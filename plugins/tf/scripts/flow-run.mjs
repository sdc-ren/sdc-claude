#!/usr/bin/env node
// task-flow e2e runner: runs the flows of a task and records results in flows.json.
//
//   node flow-run.mjs <taskDir> [--cases 21,22] [--failed] [--target local|dev|<name>] [--env K=V]…
//                     [--playwright <package.json>] [--timeout 600] [--jobs 3]
//
//   --target   uses flows.json targets.<name> as env (BASE_URL, API_URL, …); --env overrides.
//   --failed   only cases whose last result is not PASS.
//   A failed web step leaves evd/<case>-fail-<step>.page.txt (`page` in the result): the real page with locators.
//   --jobs     cases run at the same time (default 1, max 6). Keep 1 for Android (one emulator).
//   Save a target once:  node flow-run.mjs <taskDir> --save-target local --env BASE_URL=http://localhost:3100 --env API_URL=…
//
// flows.json: { targets: { <name>: { K: V } }, cases: { <case>: { file, platform, lastResult, lastRunAt,
//               lastTarget, durationMs, shots[], error } } }
// Prints a JSON summary; exit 0 when every run case is PASS, 1 otherwise.

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { rootOfTask } from './platform.mjs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const dir = resolve(argv[0] || '')
if (!argv[0] || !existsSync(dir)) { console.error('usage: flow-run.mjs <taskDir> [--cases a,b] [--failed] [--target name] [--env K=V]…'); process.exit(1) }
const opts = { env: {} }
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--failed') opts.failed = true
  else if (a === '--env') { const [k, ...v] = argv[++i].split('='); opts.env[k] = v.join('=') }
  else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i]
}
const flowsDir = join(dir, 'flows')
const manifestPath = join(dir, 'flows.json')
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
manifest.targets ||= {}
manifest.cases ||= {}
const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

if (opts['save-target']) {
  manifest.targets[opts['save-target']] = { ...(manifest.targets[opts['save-target']] || {}), ...opts.env }
  save()
  console.log(JSON.stringify({ saved: opts['save-target'], target: manifest.targets[opts['save-target']] }))
  process.exit(0)
}

mkdirSync(flowsDir, { recursive: true })
const files = readdirSync(flowsDir).filter((f) => f.endsWith('.mjs')).sort()
const caseOf = (f) => basename(f, '.mjs')
let pick = files
if (opts.cases) { const want = new Set(String(opts.cases).split(',').map((s) => s.trim())); pick = files.filter((f) => want.has(caseOf(f))) }
if (opts.failed) pick = pick.filter((f) => (manifest.cases[caseOf(f)] || {}).lastResult !== 'PASS')

const evd = join(dir, 'evd')
mkdirSync(evd, { recursive: true })
const target = opts.target || 'local'
const runId = `${Math.floor(Date.now() / 1000).toString(36)}`
const childEnv = {
  ...process.env,
  ...(manifest.targets[target] || {}),
  ...opts.env,
  FLOW_KIT: join(HERE, 'flow-kit.mjs'),
  FLOW_LIB: join(rootOfTask(dir), '.pipeline', '_lib'),
  EVD_DIR: evd,
  RUN_ID: runId,
  TARGET: target,
  TF_ROOT: resolve(dir, '..', '..'),
  TF_SLUG: basename(dir),
  ...(opts.playwright ? { PLAYWRIGHT_FROM: resolve(opts.playwright) } : {}),
}
const results = []
function runCase(f) {
  const c = caseOf(f)
  return new Promise((done) => {
    const p = spawn(process.execPath, [join(flowsDir, f)], { env: { ...childEnv, CASE: c }, stdio: ['ignore', 'pipe', 'pipe'], cwd: dir })
    let outText = '', failure = ''
    const keep = (b) => { outText = (outText + b).slice(-4000) }
    p.stdout.on('data', keep)
    p.stderr.on('data', keep)
    const timer = setTimeout(() => { failure = `timed out after ${opts.timeout || 600}s`; p.kill('SIGKILL') }, Number(opts.timeout || 600) * 1000)
    p.on('error', (e) => { failure = String(e.message) })
    p.on('close', () => {
      clearTimeout(timer)
      let v = null
      try { v = JSON.parse(readFileSync(join(evd, `${c}.verdict.json`), 'utf8')) } catch {}
      if (!v || v.runId !== runId) v = { case: c, status: failure ? 'BLOCKED' : 'FAIL', error: failure || outText.slice(-1500) || 'flow wrote no verdict', shots: [], durationMs: 0 }
      const shots = (v.shots || []).map((x) => x.replace(/\.png$/, '.webp'))
      ran[c] = { file: `flows/${f}`, platform: /androidFlow/.test(readFileSync(join(flowsDir, f), 'utf8')) ? 'android' : 'web', lastResult: v.status, lastRunAt: new Date().toISOString(), lastTarget: target, durationMs: v.durationMs, shots, error: v.error || '' }
      if (v.warnings && v.warnings.length) ran[c].warnings = v.warnings
      if (v.trace) ran[c].trace = v.trace
      if (v.page) ran[c].page = `evd/${v.page}`
      results.push({ case: c, status: v.status, error: (v.error || '').split('\n')[0], shots, ...(v.warnings && v.warnings.length ? { warnings: v.warnings } : {}), ...(v.trace ? { trace: v.trace } : {}), ...(v.page ? { page: `evd/${v.page}` } : {}) })
      done()
    })
  })
}
// --jobs N runs N cases at a time (flows seed their own data, so they do not depend on each other).
const ran = {}
const queue = [...pick]
const workers = Math.max(1, Math.min(Number(opts.jobs) || 1, 6, queue.length || 1))
await Promise.all(Array.from({ length: workers }, async () => { while (queue.length) await runCase(queue.shift()) }))
results.sort((x, y) => pick.findIndex((f) => caseOf(f) === x.case) - pick.findIndex((f) => caseOf(f) === y.case))
// Screenshots → WebP (EVD rule). Skips silently if no encoder is available.
const pngs = readdirSync(evd).filter((f) => f.endsWith('.png')).map((f) => join(evd, f))
if (pngs.length) {
  try { execFileSync(process.execPath, [join(HERE, 'webp.mjs'), ...pngs, ...(childEnv.PLAYWRIGHT_FROM ? ['--playwright', childEnv.PLAYWRIGHT_FROM] : [])], { stdio: 'pipe', timeout: 300_000 }) } catch {}
}
// Another tester may have run other cases meanwhile: merge this run's cases into the file as it is now.
try { Object.assign(manifest, JSON.parse(readFileSync(manifestPath, 'utf8'))) } catch {}
manifest.targets ||= {}
manifest.cases = { ...(manifest.cases || {}), ...ran }
save()
const count = (s) => results.filter((x) => x.status === s).length
console.log(JSON.stringify({ target, ran: results.length, pass: count('PASS'), fail: count('FAIL'), blocked: count('BLOCKED'), results }, null, 2))
process.exit(results.every((x) => x.status === 'PASS') ? 0 : 1)
