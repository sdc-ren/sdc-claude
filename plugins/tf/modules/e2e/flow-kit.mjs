// task-flow e2e flow kit — generic helpers for flow scripts in .pipeline/<slug>/flows/*.mjs.
// A flow is one case: it seeds its own data, drives the app, saves screenshots, writes a verdict.
// Flows are re-run by flow-run.mjs in later rounds instead of re-driving the UI by hand.
//
// Flow file (web):
//   const { webFlow } = await import(process.env.FLOW_KIT)
//   await webFlow('21', async ({ page, step, shot, gotoReady, waitApi, api, uniq, expect }) => {
//     await step('open import', () => gotoReady('/organizer/import', 'text=Mã VĐV', '/api/organizations'))
//     await shot('after')
//     expect(await page.getByText('Mã VĐV').isVisible(), 'column Mã VĐV visible')
//   })
//
// Flow file (Android, Flutter Semantics identifiers show up as resource-id):
//   const { androidFlow } = await import(process.env.FLOW_KIT)
//   await androidFlow('22', async ({ tap, type, waitFor, shot, step }) => {
//     await step('login', async () => { await tap({ id: 'login_username_input' }); await type('user') })
//   })
//
// Env (set by flow-run.mjs): CASE, BASE_URL, API_URL, EVD_DIR, RUN_ID, TARGET, PLAYWRIGHT_FROM,
// ANDROID_SERIAL, ADB, VIEWPORT (e.g. 1440x900), HEADED=1, TRACE=1, STEP_TIMEOUT_MS, LOADING_SELECTOR, TF_ROOT, TF_SLUG,
// FLOW_LIB (the workspace's shared helpers, <root>/.pipeline/_lib — `await import(`${process.env.FLOW_LIB}/auth.mjs`)`).
// A web step that fails also saves <case>-fail-<step>.page.txt: what was on the page (roles, names, test ids)
// with ready-to-use locators — read it before editing the flow instead of guessing and re-running. An Android
// step saves <case>-fail-<step>.ui.txt the same way (resource ids, texts, descs, bounds from uiautomator).
// Each step prints `[tf-step] <name>` when it starts, so a run killed by its timeout says where it was.
// Pointing at the bug (evidence QC can read without the flow): expect(cond, msg, { at, label, expected, actual })
// marks the element `at` (a Playwright locator or selector on Web, a find() selector on Android) when it fails;
// mark(at, label) adds another marked element to the next shot; shot(name, { caption, crop }) gives the image a
// one-line caption and asks for a close-up. flow-run.mjs draws the red boxes and labels (annotate.mjs).
// Result: <EVD_DIR>/<case>.verdict.json  { case, status: PASS|FAIL|BLOCKED, platform, steps[], shots[], marks[],
//         captions{}, crop[], warnings[], trace?, error }
// Standard: <plugin>/guidelines/e2e-testing.md
// Exit code: 0 PASS · 1 FAIL · 2 BLOCKED (environment, not the app).

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export class Blocked extends Error {}
// A failed expect() carries what to point at, so the failure screenshot marks the wrong element.
export class ExpectError extends Error {
  constructor(msg, mark) { super(`expect failed: ${msg}`); this.mark = mark }
}
// Internal case ids are what file names, verdicts and evidence are made of (QC ids are display-only).
export const CASE_ID = /^[A-Za-z0-9_-]{1,64}$/
const env = process.env
const EVD = resolve(env.EVD_DIR || 'evd')
const RUN = env.RUN_ID || String(Math.floor(Date.now() / 1000))

function base(caseId, platform) {
  if (!CASE_ID.test(String(caseId))) {
    console.error(`flow-kit: case id ${JSON.stringify(String(caseId))} is not an internal id ([A-Za-z0-9_-], max 64) — name the flow file and the case by the id cases.mjs gives`)
    process.exit(2)
  }
  mkdirSync(EVD, { recursive: true })
  const v = { case: String(caseId), status: 'PASS', platform, target: env.TARGET || '', baseUrl: env.BASE_URL || '', runId: RUN, startedAt: new Date().toISOString(), steps: [], shots: [], marks: [], captions: {}, crop: [], error: '' }
  const t0 = Date.now()
  const uniq = (prefix = 'tf') => `${prefix}-${RUN}`
  const expect = (cond, msg, o = {}) => {
    if (!cond) throw new ExpectError(msg, { at: o.at, label: o.label || msg, expected: o.expected, actual: o.actual })
  }
  const blocked = (reason) => { throw new Blocked(reason) }
  async function api(method, path, { body, token, headers = {} } = {}) {
    const url = /^https?:/.test(path) ? path : `${(env.API_URL || '').replace(/\/$/, '')}${path}`
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
    let json = null
    try { json = await res.json() } catch {}
    return { ok: res.ok, status: res.status, json }
  }
  const finish = (err) => {
    if (err) {
      v.status = err instanceof Blocked ? 'BLOCKED' : 'FAIL'
      v.error = String(err && err.message || err).slice(0, 2000)
    }
    v.durationMs = Date.now() - t0
    writeFileSync(join(EVD, `${v.case}.verdict.json`), JSON.stringify(v, null, 2))
    console.log(`${v.case} ${v.status}${v.error ? ` — ${v.error.split('\n')[0]}` : ''}`)
    process.exitCode = v.status === 'PASS' ? 0 : v.status === 'BLOCKED' ? 2 : 1
  }
  // Marks wait here until the next shot() takes them.
  const pending = []
  const take = (file, fullPage, scroll) => {
    for (const m of pending.splice(0)) {
      const box = m.box && fullPage && scroll ? [m.box[0] + scroll[0], m.box[1] + scroll[1], m.box[2], m.box[3]] : m.box
      v.marks.push({ file, box, label: String(m.label || '').slice(0, 200), ...(m.expected !== undefined ? { expected: String(m.expected).slice(0, 300) } : {}), ...(m.actual !== undefined ? { actual: String(m.actual).slice(0, 300) } : {}), ...(m.step ? { step: m.step } : {}) })
    }
  }
  const noteShot = (file, o) => {
    if (o.caption) v.captions[file] = String(o.caption).slice(0, 200)
    if (o.crop) v.crop.push(file)
  }
  return { v, uniq, expect, blocked, api, finish, pending, take, noteShot }
}

// The failure shot of a step (or of the flow, when the error came from outside any step): the element a
// failed expect() named gets a box and its label; any other error gets a label without a box.
async function failMark(k, markOf, err, stepName) {
  const first = String(err && err.message || err).split('\n')[0].replace(/^expect failed: /, '').slice(0, 160)
  const m = err && err.mark
  const box = m && m.at ? await markOf(m.at).catch(() => null) : null
  k.pending.push({ box, label: m ? m.label : `${stepName}: ${first}`, expected: m && m.expected, actual: m && m.actual, step: stepName })
}

function stepper(v, onFail) {
  return async function step(name, fn) {
    const s = { name, ok: true, ms: 0 }
    const t = Date.now()
    v.steps.push(s)
    try { process.stdout.write(`\n[tf-step] ${String(name).replace(/\s+/g, ' ').slice(0, 120)}\n`) } catch {}
    try { return await fn() } catch (e) {
      s.ok = false
      s.error = String(e && e.message || e).slice(0, 500)
      if (!(e && e.shot)) {
        try { await onFail(name, e) } catch {}
        // The innermost failing step took the shot; outer steps re-throw without another one.
        try { if (e && typeof e === 'object') e.shot = true } catch {}
      }
      throw e
    } finally { s.ms = Date.now() - t }
  }
}

// What is on the page right now, as the locators a flow can use: the accessibility tree (role + name →
// getByRole), every data-testid, form fields with their label/placeholder, and visible alerts/toasts.
export async function describePage(page, { max = 9000 } = {}) {
  const out = [`URL: ${page.url()}`]
  try { out.push(`Title: ${await page.title()}`) } catch {}
  const found = await page.evaluate(() => {
    const seen = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const txt = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 70)
    const ids = [...document.querySelectorAll('[data-testid]')].filter(seen).slice(0, 80).map((el) => `${el.getAttribute('data-testid')}  <${el.tagName.toLowerCase()}> ${txt(el)}`)
    const fields = [...document.querySelectorAll('input, select, textarea')].filter(seen).slice(0, 60).map((el) => {
      const label = (el.labels && el.labels[0] && el.labels[0].innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60)
      return `<${el.tagName.toLowerCase()}${el.type ? ` type=${el.type}` : ''}> label="${label}" placeholder="${el.getAttribute('placeholder') || ''}" name="${el.getAttribute('name') || ''}"${el.disabled ? ' disabled' : ''}`
    })
    const alerts = [...document.querySelectorAll('[role=alert], [role=status], [aria-live], .toast, .Toastify__toast, .el-message, .ant-message, .v-snackbar')].filter(seen).map(txt).filter(Boolean).slice(0, 10)
    return { ids, fields, alerts }
  }).catch(() => ({ ids: [], fields: [], alerts: [] }))
  if (found.alerts.length) out.push('', '## Alerts / toasts', ...found.alerts.map((a) => `- ${a}`))
  out.push('', "## Test ids → page.getByTestId('<id>')", ...(found.ids.length ? found.ids.map((x) => `- ${x}`) : ['(none on this page — use role + name, label or placeholder; tell the dev which element needs one)']))
  if (found.fields.length) out.push('', "## Form fields → getByLabel('<label>') / getByPlaceholder('<placeholder>')", ...found.fields.map((x) => `- ${x}`))
  let tree = ''
  try { tree = await page.locator('body').ariaSnapshot() } catch { tree = '(aria snapshot not available in this Playwright version)' }
  out.push('', "## Accessibility tree → getByRole('<role>', { name: '<name>' })", tree.length > max ? `${tree.slice(0, max)}\n… (cut at ${max} chars)` : tree)
  return out.join('\n')
}

// uiautomator XML → the nodes a flow can address: resource id, text, content-desc, bounds, clickable.
export function androidNodes(xml) {
  return [...String(xml).matchAll(/<node [^>]*>/g)].map((m) => {
    const a = (n) => (m[0].match(new RegExp(`${n}="([^"]*)"`)) || [])[1] || ''
    const b2 = a('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    return { id: a('resource-id'), text: a('text'), desc: a('content-desc'), cls: a('class').split('.').pop(), clickable: a('clickable') === 'true', scrollable: a('scrollable') === 'true', bounds: b2 ? b2.slice(1).map(Number) : null }
  })
}
// What is on an Android screen right now, as the selectors androidFlow takes ({ id }, { text }, { desc }) —
// the same job describePage does for the web. Nodes with nothing to address them by are left out.
export function describeAndroid(xml, { max = 9000 } = {}) {
  const ns = androidNodes(xml).filter((n) => n.bounds && (n.id || n.text || n.desc))
  const short = (id) => id.replace(/^[\w.]+:id\//, '')
  const q = (s) => JSON.stringify(s.replace(/\s+/g, ' ').trim().slice(0, 70))
  const line = (n) => {
    const sel = n.id ? `{ id: '${short(n.id)}' }` : n.text ? `{ text: ${q(n.text)} }` : `{ desc: ${q(n.desc)} }`
    const [x1, y1, x2, y2] = n.bounds
    return `- ${sel}  <${n.cls || 'View'}>${n.text && n.id ? ` text=${q(n.text)}` : ''}${n.desc && (n.id || n.text) ? ` desc=${q(n.desc)}` : ''}${n.clickable ? ' clickable' : ''}${n.scrollable ? ' scrollable' : ''} @${x1},${y1} ${x2 - x1}×${y2 - y1}`
  }
  const ids = ns.filter((n) => n.id).length
  const out = ['## Android screen → tap({ id }) / tap({ text }) / tap({ desc })',
    ...(ids ? [] : ['(no resource ids on this screen — use text/desc; tell the dev which element needs a key)']), ...ns.map(line)]
  const txt = out.join('\n')
  return txt.length > max ? `${txt.slice(0, max)}\n… (cut at ${max} chars)` : txt
}

export async function webFlow(caseId, fn, opts = {}) {
  const k = base(caseId, 'web')
  let b = null
  try {
    const { openBrowser } = await import('../browser/browser.mjs')
    const [w, h] = String(opts.viewport || env.VIEWPORT || '1440x900').split('x').map(Number)
    b = await openBrowser({
      root: env.TF_ROOT, slug: env.TF_SLUG, playwrightFrom: env.PLAYWRIGHT_FROM, headless: env.HEADED !== '1',
      contextOptions: { viewport: { width: w, height: h }, baseURL: env.BASE_URL || undefined, ...(opts.contextOptions || {}) },
    })
    const page = await b.context.newPage()
    // A ceiling, not a delay: actions and waits return as soon as the app is ready; only a stuck step
    // waits the full time and then fails (faster than Playwright's 30 s navigation default).
    page.setDefaultTimeout(Number(env.STEP_TIMEOUT_MS || 15_000))
    // Reported with the verdict even when the flow passes (guideline: console errors and 5xx are findings).
    k.v.warnings = []
    page.on('console', (m) => { if (m.type() === 'error' && k.v.warnings.length < 20) k.v.warnings.push(`console: ${m.text().slice(0, 200)}`) })
    page.on('response', (r) => { if (r.status() >= 500 && k.v.warnings.length < 20) k.v.warnings.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().slice(0, 160)}`) })
    // Playwright trace only on request (TRACE=1, e.g. to debug a failure a screenshot does not explain):
    // recording costs time on every action, so normal runs skip it.
    const tracing = env.TRACE === '1'
    if (tracing) { try { await b.context.tracing.start({ screenshots: true, snapshots: true }) } catch {} }
    // Wait for the app, not the clock: the response that carries the data, or the screen being ready.
    const waitApi = (urlPart, { status, method, timeout } = {}) => page.waitForResponse((r) => r.url().includes(urlPart)
      && (!method || r.request().method() === method) && (!status || r.status() === status), { timeout })
    const LOADING = env.LOADING_SELECTOR || '[aria-busy="true"], .loading, .spinner, [data-loading="true"]'
    async function ready(selector) {
      if (selector) await page.locator(selector).first().waitFor({ state: 'visible' })
      await page.locator(LOADING).first().waitFor({ state: 'hidden' }).catch(() => {})
    }
    async function gotoReady(path, selector, apiPart) {
      const resp = apiPart ? waitApi(apiPart) : null
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      if (resp) await resp
      await ready(selector)
    }
    // Where an element is on the screenshot: scrolled into view first, so the marked area is not hidden.
    const markOf = async (at) => {
      const l = typeof at === 'string' ? page.locator(at).first() : at && typeof at.first === 'function' ? at.first() : at
      if (!l || typeof l.boundingBox !== 'function') return null
      await l.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
      const b = await l.boundingBox({ timeout: 2000 }).catch(() => null)
      return b ? [b.x, b.y, b.width, b.height].map(Math.round) : null
    }
    const mark = async (at, label, extra = {}) => { k.pending.push({ box: await markOf(at), label, ...extra }) }
    const shot = async (name, o = {}) => {
      const file = `${k.v.case}-${String(name).replace(/[^\w-]+/g, '_').slice(0, 60)}.png`
      const scroll = o.fullPage ? await page.evaluate(() => [window.scrollX, window.scrollY]).catch(() => null) : null
      await page.screenshot({ path: join(EVD, file), fullPage: !!o.fullPage })
      k.v.shots.push(file)
      k.take(file, !!o.fullPage, scroll)
      k.noteShot(file, o)
      return file
    }
    let failShot = false
    const step = stepper(k.v, async (name, err) => {
      failShot = true
      const tag = `fail-${name.replace(/[^\w-]+/g, '_').slice(0, 40)}`
      await failMark(k, markOf, err, name)
      await shot(tag)
      // The page as it was when the step failed, so the fix comes from what is really there.
      const file = `${k.v.case}-${tag}.page.txt`
      writeFileSync(join(EVD, file), await describePage(page))
      k.v.page = file
    })
    try {
      await fn({ page, context: b.context, step, shot, mark, waitApi, ready, gotoReady, describe: () => describePage(page), lib: env.FLOW_LIB || '', api: k.api, uniq: k.uniq, expect: k.expect, blocked: k.blocked, env })
    } catch (e) {
      // Failed outside any step (an expect() after the steps): still leave a marked failure shot.
      if (!failShot && !(e instanceof Blocked)) { try { await failMark(k, markOf, e, 'end'); await shot('fail-end') } catch {} }
      throw e
    }
    if (tracing) { try { await b.context.tracing.stop() } catch {} }
    k.finish()
  } catch (e) {
    if (b && env.TRACE === '1') {
      const trace = `${k.v.case}-trace.zip`
      try { await b.context.tracing.stop({ path: join(EVD, trace) }); k.v.trace = trace } catch {}
    }
    k.finish(e)
  } finally {
    if (b) { const { closeBrowser } = await import('../browser/browser.mjs'); await closeBrowser(b) }
  }
}

// The adb helpers androidFlow gives a flow, on their own (flow-peek uses them to look at a screen).
export function androidKit(serial, ADB = env.ADB || 'adb') {
  const adb = (...args) => execFileSync(ADB, ['-s', serial, ...args], { stdio: 'pipe', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const dump = () => {
    adb('shell', 'uiautomator', 'dump', '/sdcard/tf-ui.xml')
    return adb('exec-out', 'cat', '/sdcard/tf-ui.xml').toString()
  }
  const nodes = androidNodes
  const match = (n, sel) => (sel.id && (n.id === sel.id || n.id.endsWith(`/${sel.id}`)))
    || (sel.text && n.text.includes(sel.text)) || (sel.desc && n.desc.includes(sel.desc))
  const find = (sel) => nodes(dump()).find((n) => n.bounds && match(n, sel)) || null
  async function waitFor(sel, timeout = 15_000) {
    const end = Date.now() + timeout
    while (Date.now() < end) { const n = find(sel); if (n) return n; await sleep(700) }
    throw new Error(`not found: ${JSON.stringify(sel)}`)
  }
  async function tap(sel, timeout) {
    const n = await waitFor(sel, timeout)
    const [x1, y1, x2, y2] = n.bounds
    adb('shell', 'input', 'tap', String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)))
    await sleep(400)
    return n
  }
  const type = async (text) => { adb('shell', 'input', 'text', String(text).replace(/ /g, '%s')); await sleep(300) }
  const key = async (code) => { adb('shell', 'input', 'keyevent', String(code)); await sleep(300) }
  // A signed-in app session kept for this task: the first `session(key, …)` runs `login` and saves the app's
  // shared_prefs; later ones (the next case, the next re-run of the same case) put them back and only check
  // `ready` — no login form. A saved session that no longer reaches `ready` (expired, another build) is logged
  // in again and saved anew. Needs a debuggable build (run-as); without one it just runs `login`.
  // Files: <task>/tmp/app-sessions/<appId>-<key>.tar, readable by the user only (they hold tokens); never evidence.
  async function session(sessionKey, login, { appId, ready, readyTimeout = 20_000, activity = '' } = {}) {
    if (!/^[A-Za-z][\w.]*$/.test(String(appId || ''))) throw new Error('session: appId (the Android package) is required')
    if (!/^[\w.-]{1,64}$/.test(String(sessionKey))) throw new Error('session: key is a short name for the account ([A-Za-z0-9_.-])')
    if (!ready) throw new Error('session: ready (a selector that is only on screen when signed in) is required')
    const t0 = Date.now()
    const dir = join(env.TF_ROOT || '.', '.pipeline', env.TF_SLUG || '_', 'tmp', 'app-sessions')
    const file = join(dir, `${appId}-${sessionKey}.tar`)
    const dev = `/data/local/tmp/tf-session-${process.pid}.tar`
    const launch = () => (activity ? adb('shell', 'am', 'start', '-n', `${appId}/${activity}`) : adb('shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1'))
    if (existsSync(file)) {
      try {
        adb('shell', 'am', 'force-stop', appId)
        adb('push', file, dev)
        adb('shell', 'chmod', '644', dev)
        // adb shell joins its arguments into one device command line: pass it whole (appId and dev are checked above).
        adb('shell', `run-as ${appId} sh -c 'rm -rf shared_prefs && tar -xf ${dev}'`)
        launch()
        await waitFor(ready, readyTimeout)
        return { reused: true, ms: Date.now() - t0 }
      } catch { /* expired or another build: log in again below */ } finally { try { adb('shell', 'rm', '-f', dev) } catch {} }
    }
    await login()
    await waitFor(ready, readyTimeout)
    try {
      const tar = adb('exec-out', 'run-as', appId, 'tar', '-cf', '-', 'shared_prefs')
      if (tar.length > 512) { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(file, tar, { mode: 0o600 }) }
    } catch { /* not debuggable: nothing to keep, the login still counts */ }
    return { reused: false, ms: Date.now() - t0 }
  }
  return { adb, dump, nodes, find, waitFor, tap, type, key, sleep, session }
}

export async function androidFlow(caseId, fn) {
  const k = base(caseId, 'android')
  const serial = env.ANDROID_SERIAL
  const ADB = env.ADB || 'adb'
  const { adb, dump, find, waitFor, tap, type, key, sleep, session } = androidKit(serial, ADB)
  // Screen pixels of a node (uiautomator bounds are already in screencap pixels).
  const markOf = async (sel) => {
    const n = sel && sel.bounds ? sel : find(sel)
    if (!n || !n.bounds) return null
    const [x1, y1, x2, y2] = n.bounds
    return [x1, y1, x2 - x1, y2 - y1]
  }
  const mark = async (at, label, extra = {}) => { k.pending.push({ box: await markOf(at).catch(() => null), label, ...extra }) }
  const shot = async (name, o = {}) => {
    const file = `${k.v.case}-${String(name).replace(/[^\w-]+/g, '_').slice(0, 60)}.png`
    writeFileSync(join(EVD, file), adb('exec-out', 'screencap', '-p'))
    k.v.shots.push(file)
    k.take(file, false, null)
    k.noteShot(file, o)
    return file
  }
  let failShot = false
  try {
    if (!serial) k.blocked('ANDROID_SERIAL not set — start the task emulator first')
    const step = stepper(k.v, async (name, err) => {
      failShot = true
      const tag = `fail-${name.replace(/[^\w-]+/g, '_').slice(0, 40)}`
      await failMark(k, markOf, err, name)
      await shot(tag)
      // The screen as it was when the step failed (ids, texts, descs, bounds): fix the step from it, no re-run.
      try { const file = `${k.v.case}-${tag}.ui.txt`; writeFileSync(join(EVD, file), describeAndroid(dump())); k.v.page = file } catch {}
    })
    try {
      await fn({ adb, dump, find, waitFor, tap, type, key, shot, mark, step, sleep, session, api: k.api, uniq: k.uniq, expect: k.expect, blocked: k.blocked, env })
    } catch (e) {
      if (!failShot && serial && !(e instanceof Blocked)) { try { await failMark(k, markOf, e, 'end'); await shot('fail-end') } catch {} }
      throw e
    }
    k.finish()
  } catch (e) {
    k.finish(e)
  }
}

// Playwright module for flows that need it directly (e.g. expect from @playwright/test).
export function playwright() {
  const from = env.PLAYWRIGHT_FROM
  try { return createRequire(resolve(from))('@playwright/test') } catch { return createRequire(resolve(from))('playwright') }
}
