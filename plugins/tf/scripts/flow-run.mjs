#!/usr/bin/env node
// task-flow e2e runner: runs the flows of a task and records results in flows.json.
//
//   node flow-run.mjs <taskDir> [--cases 21,22] [--failed] [--target local|dev|<name>] [--env K=V]…
//                     [--playwright <package.json>] [--timeout 600]
//
//   --target   uses flows.json targets.<name> as env (BASE_URL, API_URL, …); --env overrides.
//   --failed   only cases whose last result is not PASS.
//   Save a target once:  node flow-run.mjs <taskDir> --save-target local --env BASE_URL=http://localhost:3100 --env API_URL=…
//
// flows.json: { targets: { <name>: { K: V } }, cases: { <case>: { file, platform, lastResult, lastRunAt,
//               lastTarget, durationMs, shots[], error } } }
// Prints a JSON summary; exit 0 when every run case is PASS, 1 otherwise.

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
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
  EVD_DIR: evd,
  RUN_ID: runId,
  TARGET: target,
  TF_ROOT: resolve(dir, '..', '..'),
  TF_SLUG: basename(dir),
  ...(opts.playwright ? { PLAYWRIGHT_FROM: resolve(opts.playwright) } : {}),
}
const results = []
for (const f of pick) {
  const c = caseOf(f)
  const r = spawnSync(process.execPath, [join(flowsDir, f)], { env: { ...childEnv, CASE: c }, stdio: ['ignore', 'pipe', 'pipe'], timeout: Number(opts.timeout || 600) * 1000, cwd: dir })
  let v = null
  try { v = JSON.parse(readFileSync(join(evd, `${c}.verdict.json`), 'utf8')) } catch {}
  if (!v || v.runId !== runId) v = { case: c, status: r.error ? 'BLOCKED' : 'FAIL', error: (r.error ? String(r.error.message) : String(r.stderr || r.stdout).slice(-1500)) || 'flow wrote no verdict', shots: [], durationMs: 0 }
  const shots = (v.shots || []).map((s) => s.replace(/\.png$/, '.webp'))
  manifest.cases[c] = { file: `flows/${f}`, platform: /androidFlow/.test(readFileSync(join(flowsDir, f), 'utf8')) ? 'android' : 'web', lastResult: v.status, lastRunAt: new Date().toISOString(), lastTarget: target, durationMs: v.durationMs, shots, error: v.error || '' }
  if (v.warnings && v.warnings.length) manifest.cases[c].warnings = v.warnings
  if (v.trace) manifest.cases[c].trace = v.trace
  results.push({ case: c, status: v.status, error: (v.error || '').split('\n')[0], shots, ...(v.warnings && v.warnings.length ? { warnings: v.warnings } : {}), ...(v.trace ? { trace: v.trace } : {}) })
}
// Screenshots → WebP (EVD rule). Skips silently if no encoder is available.
const pngs = readdirSync(evd).filter((f) => f.endsWith('.png')).map((f) => join(evd, f))
if (pngs.length) {
  try { execFileSync(process.execPath, [join(HERE, 'webp.mjs'), ...pngs, ...(childEnv.PLAYWRIGHT_FROM ? ['--playwright', childEnv.PLAYWRIGHT_FROM] : [])], { stdio: 'pipe', timeout: 300_000 }) } catch {}
}
save()
const count = (s) => results.filter((x) => x.status === s).length
console.log(JSON.stringify({ target, ran: results.length, pass: count('PASS'), fail: count('FAIL'), blocked: count('BLOCKED'), results }, null, 2))
process.exit(results.every((x) => x.status === 'PASS') ? 0 : 1)
