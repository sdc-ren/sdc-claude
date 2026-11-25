#!/usr/bin/env node
// task-flow browsers: every task/agent gets its OWN browser process — never a shared MCP browser,
// never another session's tabs. Logged-in sites reuse a saved session copy (storageState), written back when
// the browser closes so it stays as fresh as the last use.
//
// Library (from an agent's scratch script):
//   const { openBrowser, closeBrowser } = await import('<plugin>/scripts/browser.mjs')
//   const b = await openBrowser({ root, slug, playwrightFrom: '<path>/package.json', auth: 'jira' })
//   try { const page = await b.context.newPage(); … } finally { await closeBrowser(b) }
//
// CLI:
//   auth <name> --url <site> [--playwright <package.json>] [--browser Chrome] [--profile "Profile 1"] [--no-login]
//     Ensure ~/.claude/task-flow/auth/<name>.json holds a logged-in session for <site>:
//     1) macOS: the session of the user's own browser (Chrome, Arc, Brave, Edge, Vivaldi, Chromium), from the
//        profile that used the site most recently, checked in a headless test browser → save. The user's
//        browser is only read, never opened (macOS asks once to allow its "Safe Storage" keychain item)
//     2) else the saved session, if it is still valid
//     3) else (unless --no-login) open a visible browser and wait for the user to log in → save
//   check <name> --url <site>   exit 0 if the saved session is still logged in

import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, readFileSync, readdirSync, renameSync, rmSync, chmodSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { add, drop } from './resources.mjs'
import { killCmd, stateDir, userBrowsers } from './platform.mjs'

const AUTH_DIR = join(stateDir(), 'auth')
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
  const server = await chromium.launchServer({ headless, host: '127.0.0.1' }) // never reachable from the network
  const pid = server.process().pid
  if (root && slug) add(root, slug, { kind: 'browser', id: String(pid), release: killCmd(pid), when: 'run-end' })
  const browser = await chromium.connect(server.wsEndpoint())
  const storageState = auth && existsSync(authFile(auth)) ? authFile(auth) : undefined
  const context = await browser.newContext({ ...contextOptions, ...(storageState && { storageState }) })
  return { server, browser, context, pid, root, slug, auth: storageState ? auth : undefined }
}

// What a saved session becomes after a browser used it. Sites rotate their session cookies while you browse,
// so a snapshot that is never written back goes stale and the next run has to log in again.
// Only the sites the saved session already covers are kept (the browser may have visited others), and the
// result is null — keep the old file — when the session did not survive: a page sits on a login screen, or
// a cookie domain of the saved session has no cookie left (logged out, or cleared by a test).
export function refreshedSession(saved, current, pageUrls = []) {
  if (pageUrls.some((u) => LOGIN_RE.test(u))) return null
  const domains = new Set((saved.cookies || []).map((c) => c.domain))
  const origins = new Set((saved.origins || []).map((o) => o.origin))
  const cookies = (current.cookies || []).filter((c) => domains.has(c.domain))
  if (!cookies.length || [...domains].some((d) => !cookies.some((c) => c.domain === d))) return null
  return { cookies, origins: (current.origins || []).filter((o) => origins.has(o.origin)) }
}
async function saveSession(b) {
  const file = authFile(b.auth)
  const next = refreshedSession(JSON.parse(readFileSync(file, 'utf8')), await b.context.storageState(), b.context.pages().map((p) => p.url()))
  if (!next) return
  writePrivate(file, next)
}
// A session file holds login cookies: created readable by the user only (never world-readable for a moment),
// written whole and swapped in, since another task may be reading it.
function writePrivate(file, state) {
  const tmp = `${file}.${process.pid}.tmp`
  rmSync(tmp, { force: true })
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600, flag: 'wx' })
  renameSync(tmp, file)
}
export async function closeBrowser(b) {
  if (!b) return
  if (b.auth) await saveSession(b).catch(() => {}) // best effort: a failed save leaves the old session in place
  try { await b.browser.close() } catch {}
  try { await b.server.close() } catch {}
  if (b.root && b.slug) drop(b.root, b.slug, 'browser', String(b.pid))
}

// Signed in on the page that is open now. A URL check alone is not enough: an expired Jira session stays on the
// site as an anonymous visitor instead of redirecting to a login page, so Jira is asked who the user is.
export async function signedIn(page) {
  if (LOGIN_RE.test(page.url())) return false
  if (!/\.atlassian\.net$/i.test(new URL(page.url()).hostname)) return true
  return page.evaluate(async () => (await fetch('/rest/api/3/myself', { headers: { Accept: 'application/json' } })).ok).catch(() => false)
}
async function loggedIn(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
  await page.waitForTimeout(3000)
  return signedIn(page)
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

// Would a browser send a cookie stored under `key` (a host, or ".parent.domain") to `host`?
export const cookieSentTo = (key, host) => key === host || (key.startsWith('.') && `.${host}`.endsWith(key))

// ── The user's own browser ───────────────────────────────────────────────────
// The browser the user works in keeps its sessions far longer than a saved copy, so it is read first. Its cookie
// store is decrypted here (macOS: AES-128-CBC with a key derived from the browser's "Safe Storage" keychain
// item) and handed to the test browser as a storage state — the user's browser is never opened or driven.

const CHROME_EPOCH = 11644473600 // seconds between 1601-01-01 (Chrome's clock) and 1970-01-01
const SAME_SITE = { 0: 'None', 1: 'Lax', 2: 'Strict' }

// Rows of a copied cookie database that the browser would send to `host`, decrypted with `password`.
// Expired cookies are dropped; `lastUsed` (unix seconds) tells which profile used the site most recently.
export function readCookieDb(db, host, password) {
  // The host comes from a URL someone gave us. It never reaches a shell or the SQL text: sqlite3 runs without a
  // shell, with a fixed query, and host names are compared here.
  const out = execFileSync('sqlite3', ['-json', db,
    'select host_key, name, path, hex(encrypted_value) as ev, value, expires_utc, last_access_utc, is_secure, is_httponly, samesite from cookies'],
  { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).toString()
  const version = Number(execFileSync('sqlite3', [db, "select value from meta where key = 'version'"], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) || 0
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const now = Date.now() / 1000
  const cookies = []
  let lastUsed = 0
  for (const r of out.trim() ? JSON.parse(out) : []) {
    if (!cookieSentTo(r.host_key, host)) continue
    const expires = Number(r.expires_utc) ? Number(r.expires_utc) / 1e6 - CHROME_EPOCH : -1
    if (expires !== -1 && expires < now) continue
    let value = r.value || ''
    const enc = Buffer.from(r.ev || '', 'hex')
    if (enc.length) {
      if (enc.subarray(0, 3).toString() !== 'v10') continue // another scheme: not readable here
      try {
        const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
        let plain = Buffer.concat([d.update(enc.subarray(3)), d.final()])
        // Database version 24+: the value starts with SHA-256 of the cookie's domain — which also proves the key.
        if (version >= 24) {
          if (!plain.subarray(0, 32).equals(createHash('sha256').update(r.host_key).digest())) continue
          plain = plain.subarray(32)
        }
        value = plain.toString('utf8')
      } catch { continue } // wrong key: this profile belongs to another keychain item
    }
    const secure = !!Number(r.is_secure)
    let sameSite = SAME_SITE[Number(r.samesite)] || 'Lax'
    if (sameSite === 'None' && !secure) sameSite = 'Lax'
    cookies.push({ name: r.name, value, domain: r.host_key, path: r.path || '/', expires, httpOnly: !!Number(r.is_httponly), secure, sameSite })
    lastUsed = Math.max(lastUsed, Number(r.last_access_utc) / 1e6 - CHROME_EPOCH)
  }
  return { cookies, lastUsed }
}

// Profiles of the user's browsers that hold cookies for `host`, most recently used first. Only host names and
// access times are read here; no keychain access yet.
export function browserProfilesFor(host, { browser, profile } = {}, browsers = userBrowsers()) {
  if (!/^[a-z0-9.-]+$/.test(host)) return []
  const found = []
  for (const b of browsers) {
    if (browser && b.name.toLowerCase() !== String(browser).toLowerCase()) continue
    if (!existsSync(b.dir)) continue
    const profiles = profile ? [profile] : readdirSync(b.dir).filter((d) => d === 'Default' || /^Profile \d+$/.test(d))
    for (const p of profiles) {
      if (p !== 'Default' && !/^Profile \d+$/.test(p)) continue
      for (const rel of ['Network/Cookies', 'Cookies']) {
        const src = join(b.dir, p, rel)
        if (!existsSync(src)) continue
        const dir = mkdtempSync(join(tmpdir(), 'tf-ck-'))
        try {
          const tmp = join(dir, 'c.db')
          copyFileSync(src, tmp) // the browser locks the live database; read a copy
          const rows = execFileSync('sqlite3', [tmp, 'select host_key, max(last_access_utc) from cookies group by host_key'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)
          let last = 0
          for (const line of rows) {
            const [k, t] = line.split('|')
            if (k && cookieSentTo(k.trim(), host)) last = Math.max(last, Number(t) / 1e6 - CHROME_EPOCH)
          }
          if (last) found.push({ browser: b, profile: p, file: src, lastUsed: last })
        } catch {} finally { rmSync(dir, { recursive: true, force: true }) }
        break
      }
    }
  }
  return found.sort((a, b) => b.lastUsed - a.lastUsed)
}

function keychainPassword(service) {
  return execFileSync('security', ['find-generic-password', '-w', '-s', service], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

// The site's session from the user's own browser, verified in a headless test browser and saved. Tries each
// profile that has the site, most recently used first, and stops at the first one that is signed in.
async function fromUserBrowser(name, url, playwrightFrom, pick = {}) {
  const host = new URL(url).hostname
  const passwords = {}
  for (const f of browserProfilesFor(host, pick)) {
    const label = `${f.browser.name} profile "${f.profile}"`
    let password = passwords[f.browser.keychain]
    if (password === undefined) {
      console.log(`Reading the ${host} session from ${label} (macOS may ask to allow "${f.browser.keychain}" — choose Always Allow).`)
      try { password = keychainPassword(f.browser.keychain) } catch { password = '' }
      passwords[f.browser.keychain] = password
    }
    if (!password) { console.log(`${label}: keychain access denied`); continue }
    const dir = mkdtempSync(join(tmpdir(), 'tf-ck-'))
    let state
    try {
      const tmp = join(dir, 'c.db')
      copyFileSync(f.file, tmp)
      const { cookies } = readCookieDb(tmp, host, password)
      if (!cookies.length) continue
      state = { cookies, origins: [] }
    } finally { rmSync(dir, { recursive: true, force: true }) }
    if (await stateWorks(state, url, playwrightFrom)) {
      writePrivate(authFile(name), state)
      console.log(`Signed in from ${label}.`)
      return true
    }
    console.log(`${label}: not signed in to ${host}`)
  }
  return false
}

async function stateWorks(storageState, url, playwrightFrom) {
  const { chromium } = playwright(playwrightFrom)
  const browser = await chromium.launch()
  try {
    return await loggedIn(await (await browser.newContext({ storageState })).newPage(), url)
  } finally {
    await browser.close()
  }
}

function siteOnly(state, url) {
  // Only cookies the browser would send to this host (exact host, or a parent ".domain").
  const host = new URL(url).host
  return {
    cookies: state.cookies.filter((c) => cookieSentTo(c.domain, host)),
    origins: state.origins.filter((o) => new URL(o.origin).host === host),
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
      if (new URL(page.url()).host === new URL(url).host && (await signedIn(page))) {
        await page.waitForTimeout(3000)
        // Only this site's cookies and storage: the window may have passed through other sites on the way in.
        writePrivate(authFile(name), siteOnly(await ctx.storageState(), url))
        return true
      }
    }
    return false
  } finally {
    await browser.close()
  }
}

// Order: the user's own browser first (it keeps sessions longest), then the saved copy, then a visible
// browser for the user to log in once. `interactive: false` stops before the last step (agents mid-run).
export async function ensureAuth(name, url, { playwrightFrom, browser, profile, interactive = true } = {}) {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
  if (await fromUserBrowser(name, url, playwrightFrom, { browser, profile }).catch((e) => (console.log(`Reading the browser session failed: ${e.message.split('\n')[0]}`), false))) {
    chmodSync(authFile(name), 0o600)
    return 'from-browser'
  }
  if (await checkAuth(name, url, playwrightFrom)) return 'valid'
  if (!interactive) return 'failed'
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
    console.error('usage: browser.mjs auth|check <name> --url <site> [--playwright <package.json>] [--browser Chrome|Arc|Brave|Edge|Vivaldi|Chromium] [--profile "Profile 1"] [--no-login]')
    process.exit(2)
  }
  if (cmd === 'check') {
    process.exit((await checkAuth(name, flags.url, flags.playwright)) ? 0 : 1)
  } else if (cmd === 'auth') {
    const result = await ensureAuth(name, flags.url, { playwrightFrom: flags.playwright, browser: flags.browser, profile: flags.profile, interactive: !('no-login' in flags) })
    console.log(`auth ${name}: ${result}`)
    process.exit(result === 'failed' ? 1 : 0)
  }
}
