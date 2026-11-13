#!/usr/bin/env node
// task-flow browsers: every task/agent gets its OWN browser process — never a shared MCP browser,
// never another session's tabs. Logged-in sites reuse a saved session copy (storageState).
//
// Library (from an agent's scratch script):
//   const { openBrowser, closeBrowser } = await import('<plugin>/scripts/browser.mjs')
//   const b = await openBrowser({ root, slug, playwrightFrom: '<path>/package.json', auth: 'jira' })
//   try { const page = await b.context.newPage(); … } finally { await closeBrowser(b) }
//
// CLI:
//   auth <name> --url <site> [--playwright <package.json>] [--profile "Profile 1"]
//     Ensure ~/.claude/task-flow/auth/<name>.json holds a logged-in session for <site>:
//     1) existing saved session still valid → done
//     2) else copy the cookies of the user's Chrome profile that has cookies for the site
//        (macOS asks the user to allow "Chrome Safe Storage" once) → save if logged in
//     3) else open a visible browser and wait for the user to log in → save
//   check <name> --url <site>   exit 0 if the saved session is still logged in

import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, readdirSync, rmSync, chmodSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { add, drop } from './resources.mjs'

const AUTH_DIR = join(homedir(), '.claude', 'task-flow', 'auth')
const CHROME_DIR = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
const LOGIN_RE = /next_path=|\/login|\/signin|\/sign-in|id\.atlassian\.com|accounts\.google\.com|\/auth\//i

export const authFile = (name) => join(AUTH_DIR, `${name}.json`)

function playwright(from) {
  const candidates = [from, process.env.TF_PLAYWRIGHT, join(process.cwd(), 'package.json')].filter(Boolean)
  for (const c of candidates) {
    try { return createRequire(resolve(c))('@playwright/test') } catch {}
    try { return createRequire(resolve(c))('playwright') } catch {}
  }
  throw new Error('Playwright not found — pass playwrightFrom / --playwright <package.json that depends on @playwright/test>')
}

// Own browser process, registered so cleanup can kill it even if the script crashes.
export async function openBrowser({ root, slug, playwrightFrom, auth, headless = true, contextOptions = {} }) {
  const { chromium } = playwright(playwrightFrom)
  const server = await chromium.launchServer({ headless })
  const pid = server.process().pid
  if (root && slug) add(root, slug, { kind: 'browser', id: String(pid), release: `kill ${pid} 2>/dev/null || true`, when: 'run-end' })
  const browser = await chromium.connect(server.wsEndpoint())
  const storageState = auth && existsSync(authFile(auth)) ? authFile(auth) : undefined
  const context = await browser.newContext({ ...contextOptions, ...(storageState && { storageState }) })
  return { server, browser, context, pid, root, slug }
}
export async function closeBrowser(b) {
  if (!b) return
  try { await b.browser.close() } catch {}
  try { await b.server.close() } catch {}
  if (b.root && b.slug) drop(b.root, b.slug, 'browser', String(b.pid))
}

async function loggedIn(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
  await page.waitForTimeout(3000)
  return !LOGIN_RE.test(page.url())
}
export async function checkAuth(name, url, playwrightFrom) {
  if (!existsSync(authFile(name))) return false
  const { chromium } = playwright(playwrightFrom)
  const browser = await chromium.launch()
  try {
    const page = await (await browser.newContext({ storageState: authFile(name) })).newPage()
    return await loggedIn(page, url)
  } finally {
    await browser.close()
  }
}

function chromeProfileFor(host, wanted) {
  if (!existsSync(CHROME_DIR)) return null
  const profiles = wanted ? [wanted] : readdirSync(CHROME_DIR).filter((d) => d === 'Default' || d.startsWith('Profile '))
  const domain = host.split('.').slice(-2).join('.')
  for (const p of profiles) {
    for (const rel of ['Network/Cookies', 'Cookies']) {
      const src = join(CHROME_DIR, p, rel)
      if (!existsSync(src)) continue
      const tmp = join(mkdtempSync(join(tmpdir(), 'tf-ck-')), 'c.db')
      copyFileSync(src, tmp) // Chrome locks the live db; read a copy (host names only, no values)
      try {
        const n = execSync(`sqlite3 ${JSON.stringify(tmp)} "select count(*) from cookies where host_key like '%${domain}'"`).toString().trim()
        if (Number(n) > 0) return { profile: p, rel }
      } catch {} finally { rmSync(tmp, { force: true }) }
    }
  }
  return null
}

function siteOnly(state, url) {
  // Only cookies the browser would send to this host (exact host, or a parent ".domain").
  const host = new URL(url).host
  const sent = (d) => d === host || (d.startsWith('.') && `.${host}`.endsWith(d))
  return {
    cookies: state.cookies.filter((c) => sent(c.domain)),
    origins: state.origins.filter((o) => new URL(o.origin).host === host),
  }
}

async function fromChrome(name, url, playwrightFrom, wanted) {
  const found = chromeProfileFor(new URL(url).host, wanted)
  if (!found) return false
  console.log(`Using cookies from Chrome profile "${found.profile}" (macOS may ask to allow "Chrome Safe Storage").`)
  const dir = mkdtempSync(join(tmpdir(), 'tf-chrome-'))
  try {
    mkdirSync(join(dir, 'Default', 'Network'), { recursive: true })
    copyFileSync(join(CHROME_DIR, 'Local State'), join(dir, 'Local State'))
    copyFileSync(join(CHROME_DIR, found.profile, found.rel), join(dir, 'Default', found.rel))
    const { chromium } = playwright(playwrightFrom)
    // Real Chrome + real keychain so the copied cookies decrypt.
    const ctx = await chromium.launchPersistentContext(dir, { channel: 'chrome', headless: false, ignoreDefaultArgs: ['--use-mock-keychain'] })
    try {
      const ok = await loggedIn(ctx.pages()[0] || (await ctx.newPage()), url)
      // Keep only the site's cookies: the copied profile holds every site's, and some fail setCookies.
      if (ok) writeFileSync(authFile(name), JSON.stringify(siteOnly(await ctx.storageState(), url)))
      return ok
    } finally {
      await ctx.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function manualLogin(name, url, playwrightFrom) {
  const { chromium } = playwright(playwrightFrom)
  const browser = await chromium.launch({ headless: false })
  try {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(url).catch(() => {})
    console.log(`Log in to ${url} in the opened window. Waiting up to 10 minutes…`)
    for (let i = 0; i < 300; i++) {
      await page.waitForTimeout(2000)
      if (new URL(page.url()).host === new URL(url).host && !LOGIN_RE.test(page.url())) {
        await page.waitForTimeout(3000)
        await ctx.storageState({ path: authFile(name) })
        return true
      }
    }
    return false
  } finally {
    await browser.close()
  }
}

export async function ensureAuth(name, url, { playwrightFrom, profile } = {}) {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
  if (await checkAuth(name, url, playwrightFrom)) return 'valid'
  if (await fromChrome(name, url, playwrightFrom, profile).catch((e) => (console.log(`Chrome copy failed: ${e.message.split('\n')[0]}`), false))) {
    chmodSync(authFile(name), 0o600)
    return 'from-chrome'
  }
  if (await manualLogin(name, url, playwrightFrom)) {
    chmodSync(authFile(name), 0o600)
    return 'manual-login'
  }
  return 'failed'
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, name, ...rest] = process.argv.slice(2)
  const flags = {}
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i]
  if (!name || !flags.url) {
    console.error('usage: browser.mjs auth|check <name> --url <site> [--playwright <package.json>] [--profile <Chrome profile>]')
    process.exit(2)
  }
  if (cmd === 'check') {
    process.exit((await checkAuth(name, flags.url, flags.playwright)) ? 0 : 1)
  } else if (cmd === 'auth') {
    const result = await ensureAuth(name, flags.url, { playwrightFrom: flags.playwright, profile: flags.profile })
    console.log(`auth ${name}: ${result}`)
    process.exit(result === 'failed' ? 1 : 0)
  }
}
