#!/usr/bin/env node
// tf: look at a screen BEFORE writing a flow for it. Opens the task's own browser on the target, optionally
// runs a few steps first (login, navigation, opening a dialog), then prints what is really on the page with
// the locators a flow can use — test ids, form labels, role + name — and saves a screenshot.
// A look costs seconds; a flow written blind costs a full run per wrong selector.
//
//   node flow-peek.mjs <taskDir> <path or url> [--target local] [--steps <file.mjs>] [--wait <selector>]
//                      [--shot <name>] [--env K=V]… [--playwright <package.json>] [--max 9000]
//
//   --steps   a module run before the look:  export default async ({ page, context, api, env, lib, gotoReady }) => { … }
//             (log in with the workspace library, click into the state you want to see). When given, <path>
//             is opened AFTER the steps only if it is not '-'.
//   --wait    selector that must be visible before the page is described.
//   Output: the description on stdout, screenshot at <taskDir>/evd/peek-<name>.png (not evidence; overwritten).
//
//   Android:  node flow-peek.mjs <taskDir> - --android <serial | -> [--steps <file.mjs>] [--wait <text>] [--shot name]
//             the screen the task emulator shows now (`-` = $ANDROID_SERIAL), after the steps if given:
//             export default async ({ adb, dump, find, waitFor, tap, type, key, sleep, api, env, lib }) => { … }
//             Prints the selectors androidFlow takes ({ id } / { text } / { desc }) with bounds — no adb taps and
//             screenshots by hand to find out what is on a screen.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rootOfTask } from './platform.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const dir = resolve(argv[0] || '')
const where = argv[1]
if (!argv[0] || !existsSync(dir) || !where) { console.error('usage: flow-peek.mjs <taskDir> <path or url | -> [--target local] [--steps file.mjs] [--wait selector] [--shot name] [--android <serial|->]'); process.exit(2) }
const opts = { env: {} }
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === '--env') { const [key, ...v] = argv[++i].split('='); opts.env[key] = v.join('=') } else if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[++i]
}
const manifest = existsSync(join(dir, 'flows.json')) ? JSON.parse(readFileSync(join(dir, 'flows.json'), 'utf8')) : {}
const target = opts.target || 'local'
const root = rootOfTask(dir)
const env = { ...process.env, ...((manifest.targets || {})[target] || {}), ...opts.env, TARGET: target, TF_ROOT: root, TF_SLUG: basename(dir), FLOW_LIB: join(root, '.pipeline', '_lib') }
if (opts.playwright) env.PLAYWRIGHT_FROM = resolve(opts.playwright)
Object.assign(process.env, env)

const api = async (method, path, { body, token, headers = {} } = {}) => {
  const res = await fetch(/^https?:/.test(path) ? path : `${(env.API_URL || '').replace(/\/$/, '')}${path}`, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  })
  let json = null
  try { json = await res.json() } catch {}
  return { ok: res.ok, status: res.status, json }
}
const shotPath = () => { mkdirSync(join(dir, 'evd'), { recursive: true }); return join(dir, 'evd', `peek-${String(opts.shot || 'page').replace(/[^\w-]+/g, '_')}.png`) }

if (opts.android !== undefined) {
  const serial = opts.android && opts.android !== '-' ? opts.android : env.ANDROID_SERIAL
  if (!/^[\w.:-]+$/.test(String(serial || ''))) { console.error('peek failed: no emulator serial — --android <serial> or ANDROID_SERIAL (emulator.mjs start prints it)'); process.exit(2) }
  if (where !== '-') { console.error('peek failed: Android looks at the screen the emulator shows — pass "-" and navigate with --steps'); process.exit(2) }
  const { androidKit, describeAndroid } = await import(join(HERE, 'flow-kit.mjs'))
  const kit = androidKit(serial)
  let code = 0
  try {
    if (opts.steps) {
      const mod = await import(pathToFileURL(resolve(opts.steps)).href)
      await mod.default({ ...kit, api, env, lib: env.FLOW_LIB })
    }
    if (opts.wait) await kit.waitFor({ text: opts.wait })
    else await kit.sleep(800)
    const xml = kit.dump().toString()
    const shot = shotPath()
    try { writeFileSync(shot, kit.adb('exec-out', 'screencap', '-p')) } catch {}
    console.log(describeAndroid(xml, { max: Number(opts.max) || 9000 }))
    console.log(`\nScreenshot: ${shot}`)
  } catch (e) {
    console.error(`peek failed: ${String(e && e.message || e).split('\n')[0]}`)
    code = 1
  }
  process.exit(code)
}

const { describePage } = await import(join(HERE, 'flow-kit.mjs'))
const { openBrowser, closeBrowser } = await import(join(HERE, 'browser.mjs'))
const [w, h] = String(env.VIEWPORT || '1440x900').split('x').map(Number)
const b = await openBrowser({ root, slug: env.TF_SLUG, playwrightFrom: env.PLAYWRIGHT_FROM, contextOptions: { viewport: { width: w, height: h }, baseURL: env.BASE_URL || undefined } })
let code = 0
try {
  const page = await b.context.newPage()
  page.setDefaultTimeout(Number(env.STEP_TIMEOUT_MS || 15_000))
  const gotoReady = async (path, selector) => { await page.goto(path, { waitUntil: 'domcontentloaded' }); if (selector) await page.locator(selector).first().waitFor({ state: 'visible' }) }
  if (opts.steps) {
    const mod = await import(pathToFileURL(resolve(opts.steps)).href)
    await mod.default({ page, context: b.context, api, env, lib: env.FLOW_LIB, gotoReady })
  }
  if (where !== '-') await page.goto(where, { waitUntil: 'domcontentloaded' })
  if (opts.wait) await page.locator(opts.wait).first().waitFor({ state: 'visible' })
  else await page.waitForLoadState('load').catch(() => {})
  const shot = shotPath()
  await page.screenshot({ path: shot }).catch(() => {})
  console.log(await describePage(page, { max: Number(opts.max) || 9000 }))
  console.log(`\nScreenshot: ${shot}`)
} catch (e) {
  console.error(`peek failed: ${String(e && e.message || e).split('\n')[0]}`)
  code = 1
} finally {
  await closeBrowser(b)
}
process.exit(code)
