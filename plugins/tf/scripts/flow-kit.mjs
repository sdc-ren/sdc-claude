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
// ANDROID_SERIAL, ADB, VIEWPORT (e.g. 1440x900), HEADED=1, TRACE=1, STEP_TIMEOUT_MS, LOADING_SELECTOR, TF_ROOT, TF_SLUG.
// Result: <EVD_DIR>/<case>.verdict.json  { case, status: PASS|FAIL|BLOCKED, steps[], shots[], warnings[], trace?, error }
// Standard: <plugin>/guidelines/e2e-testing.md
// Exit code: 0 PASS · 1 FAIL · 2 BLOCKED (environment, not the app).

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export class Blocked extends Error {}
const env = process.env
const EVD = resolve(env.EVD_DIR || 'evd')
const RUN = env.RUN_ID || String(Math.floor(Date.now() / 1000))

function base(caseId) {
  mkdirSync(EVD, { recursive: true })
  const v = { case: String(caseId), status: 'PASS', target: env.TARGET || '', baseUrl: env.BASE_URL || '', runId: RUN, startedAt: new Date().toISOString(), steps: [], shots: [], error: '' }
  const t0 = Date.now()
  const uniq = (prefix = 'tf') => `${prefix}-${RUN}`
  const expect = (cond, msg) => { if (!cond) throw new Error(`expect failed: ${msg}`) }
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
  return { v, uniq, expect, blocked, api, finish }
}

function stepper(v, onFail) {
  return async function step(name, fn) {
    const s = { name, ok: true, ms: 0 }
    const t = Date.now()
    v.steps.push(s)
    try { return await fn() } catch (e) {
      s.ok = false
      s.error = String(e && e.message || e).slice(0, 500)
      try { await onFail(name) } catch {}
      throw e
    } finally { s.ms = Date.now() - t }
  }
}

export async function webFlow(caseId, fn, opts = {}) {
  const k = base(caseId)
  let b = null
  try {
    const { openBrowser } = await import('./browser.mjs')
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
    const shot = async (name, o = {}) => {
      const file = `${k.v.case}-${name}.png`
      await page.screenshot({ path: join(EVD, file), fullPage: !!o.fullPage })
      k.v.shots.push(file)
      return file
    }
    const step = stepper(k.v, (name) => shot(`fail-${name.replace(/[^\w-]+/g, '_').slice(0, 40)}`))
    await fn({ page, context: b.context, step, shot, waitApi, ready, gotoReady, api: k.api, uniq: k.uniq, expect: k.expect, blocked: k.blocked, env })
    if (tracing) { try { await b.context.tracing.stop() } catch {} }
    k.finish()
  } catch (e) {
    if (b && env.TRACE === '1') {
      const trace = `${k.v.case}-trace.zip`
      try { await b.context.tracing.stop({ path: join(EVD, trace) }); k.v.trace = trace } catch {}
    }
    k.finish(e)
  } finally {
    if (b) { const { closeBrowser } = await import('./browser.mjs'); await closeBrowser(b) }
  }
}

export async function androidFlow(caseId, fn) {
  const k = base(caseId)
  const serial = env.ANDROID_SERIAL
  const ADB = env.ADB || 'adb'
  const adb = (...args) => execFileSync(ADB, ['-s', serial, ...args], { stdio: 'pipe', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const dump = () => {
    adb('shell', 'uiautomator', 'dump', '/sdcard/tf-ui.xml')
    return adb('exec-out', 'cat', '/sdcard/tf-ui.xml').toString()
  }
  const nodes = (xml) => [...xml.matchAll(/<node [^>]*>/g)].map((m) => {
    const a = (n) => (m[0].match(new RegExp(`${n}="([^"]*)"`)) || [])[1] || ''
    const b2 = a('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    return { id: a('resource-id'), text: a('text'), desc: a('content-desc'), bounds: b2 ? b2.slice(1).map(Number) : null }
  })
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
  const shot = async (name) => {
    const file = `${k.v.case}-${name}.png`
    writeFileSync(join(EVD, file), adb('exec-out', 'screencap', '-p'))
    k.v.shots.push(file)
    return file
  }
  try {
    if (!serial) k.blocked('ANDROID_SERIAL not set — start the task emulator first')
    const step = stepper(k.v, (name) => shot(`fail-${name.replace(/[^\w-]+/g, '_').slice(0, 40)}`))
    await fn({ adb, dump, find, waitFor, tap, type, key, shot, step, sleep, api: k.api, uniq: k.uniq, expect: k.expect, blocked: k.blocked, env })
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
