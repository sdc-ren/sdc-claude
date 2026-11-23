#!/usr/bin/env node
// task-flow e2e runner: runs the flows of a task and records results in flows.json.
//
//   node flow-run.mjs <taskDir> [--cases 21,22 | --cases-file ids.json] [--failed] [--target local|dev|<name>]
//                     [--env K=V]… [--playwright <package.json>] [--timeout <s>] [--jobs 3] [--commit <id>]
//                     [--changed] [--verbose]
//
//   --cases      internal case ids (flows/<id>.mjs). An id with no flow is an error (exit 2), never skipped.
//   --cases-file a JSON array of internal ids (what `cases.mjs scope --out` writes).
//   --target   uses flows.json targets.<name> as env (BASE_URL, API_URL, …); --env overrides. A --target that
//              is not saved is an error (exit 2); see --ensure-target.
//   --failed   only cases whose last result is not PASS.
//   --changed  skip a case that already PASSed on this commit, this target and this flow (the flow file and the
//              _lib files it imports, hashed as flowHash): the final check of a job re-runs only what changed.
//              Nothing left to run is a result here (`upToDate`), not an error.
//   --timeout  seconds per case before it is killed (default 180 Web/API, 360 Android); the result says the
//              step it was in (`[tf-step]` lines of the flow kit).
//   A failure whose error is an HTTP 429 / "Too many requests" is recorded as BLOCKED (`rateLimited: true`):
//   the app's rate limiter stopped the flow, not a bug — raise the limit in the task server's env (config
//   "## Servers"), `serve.mjs restart`, run again.
//   --verbose  print every field of each result (default: case, status, first error line, evidence files).
//   --list     one line per flow (case · platform · last result · on this commit/flow or not · seconds · error)
//              instead of reading flows.json; nothing runs.
//   --commit   what code ran (default: `task.mjs commit`, the HEAD of every worktree of the task); stored per case
//              so cases.mjs knows when a result no longer counts.
//   Nothing to run (empty selection) is an error (exit 2): an empty run is never reported as green.
//   Failed cases and cases with marks get a marked copy of their screenshots (annotate.mjs): red boxes and labels.
//   Save a target from the task's servers or the workspace:  node flow-run.mjs <taskDir> --ensure-target <name>
//   Record that flows were (re)written for the approved case version:  --mark-written <id,id>
//   A failed web step leaves evd/<case>-fail-<step>.page.txt (`page` in the result): the real page with locators.
//   --jobs     cases run at the same time (default 1, max 6). Keep 1 for Android (one emulator).
//   Save a target once:  node flow-run.mjs <taskDir> --save-target local --env BASE_URL=http://localhost:3100 --env API_URL=…
//
// flows.json: { targets: { <name>: { K: V } }, cases: { <case>: { file, platform, lastResult, lastRunAt,
//               lastTarget, durationMs, shots[], error } } }
// Prints a JSON summary; exit 0 when every run case is PASS, 1 otherwise.

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { rootOfTask } from './platform.mjs'
import { commitOf } from './task.mjs'
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
  else if (a === '--changed') opts.changed = true
  else if (a === '--verbose') opts.verbose = true
  else if (a === '--list') opts.list = true
  else if (a === '--env') { const [k, ...v] = argv[++i].split('='); opts.env[k] = v.join('=') }
  else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i]
}
const fail = (error, extra = {}) => { console.log(JSON.stringify({ error, ...extra }, null, 2)); process.exit(2) }
const CASE_ID = /^[A-Za-z0-9_-]{1,64}$/
// The limiter's own answer, not a bare 429: a case may expect a 429 and fail for another reason.
const RATE_LIMITED = /too many requests|too_many_requests|rate[_ .-]?limit[_ .]?exceeded/i
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

// A target the flows can run against, saved once in flows.json: kept when it is there; a shared target (dev,
// staging) is copied from the regression suite or another task of the workspace; `local` is built from the
// ports serve.mjs gave this task's servers (servers.json) — the server named fe/web/frontend/client is
// BASE_URL, be/api/backend/server is API_URL. Anything else is an error: save it with --save-target.
if (opts['ensure-target']) {
  const name = opts['ensure-target']
  if (manifest.targets[name]) { console.log(JSON.stringify({ target: name, source: 'saved', env: manifest.targets[name] })); process.exit(0) }
  const pipe = join(rootOfTask(dir), '.pipeline')
  let env = null, source = ''
  if (name !== 'local') {
    const others = existsSync(pipe) ? readdirSync(pipe).map((d) => join(pipe, d, 'flows.json')).filter((f) => f !== manifestPath && existsSync(f)) : []
    const reg = join(pipe, '_regression', 'flows.json')
    for (const f of [reg, ...others.filter((f) => f !== reg)]) {
      try { const t = JSON.parse(readFileSync(f, 'utf8')).targets || {}; if (t[name]) { env = t[name]; source = f; break } } catch {}
    }
  } else {
    let servers = {}
    try { servers = JSON.parse(readFileSync(join(dir, 'servers.json'), 'utf8')) } catch {}
    const portOf = (re) => { for (const [n, v] of Object.entries(servers.ports || servers)) if (re.test(n) && Number(v && v.port || v)) return Number(v && v.port || v); return 0 }
    const fe = portOf(/^(fe|web|frontend|client|app)$/i), be = portOf(/^(be|api|backend|server)$/i)
    if (fe || be) { env = { ...(fe ? { BASE_URL: `http://localhost:${fe}` } : {}), ...(be ? { API_URL: `http://localhost:${be}` } : {}) }; source = 'servers.json' }
  }
  if (!env) fail(`target "${name}" is not saved and could not be built — start the servers (serve.mjs) for local, or save it: flow-run.mjs <taskDir> --save-target ${name} --env BASE_URL=… --env API_URL=…`)
  manifest.targets[name] = env
  save()
  console.log(JSON.stringify({ target: name, source, env }))
  process.exit(0)
}

// The tester (re)wrote these flows for the approved version of their cases (cases.approved.json): from now on
// the flow counts as fresh for that version, and a later edit of the case makes it stale again.
if (opts['mark-written']) {
  let snap = null
  try { snap = JSON.parse(readFileSync(join(dir, 'cases.approved.json'), 'utf8')) } catch {}
  if (!snap) fail('no cases.approved.json — --mark-written records the approved case version a flow was written for')
  const rev = Object.fromEntries((snap.cases || []).map((c) => [c.id, c.rev]))
  const ids = String(opts['mark-written']).split(',').map((x) => x.trim()).filter(Boolean)
  const unknown = ids.filter((id) => !rev[id] || !existsSync(join(flowsDir, `${id}.mjs`)))
  if (unknown.length) fail('not an approved case with a flow file', { unknown })
  for (const id of ids) manifest.cases[id] = { ...(manifest.cases[id] || {}), file: `flows/${id}.mjs`, caseRev: rev[id] }
  save()
  console.log(JSON.stringify({ marked: ids }))
  process.exit(0)
}

mkdirSync(flowsDir, { recursive: true })
const files = readdirSync(flowsDir).filter((f) => f.endsWith('.mjs')).sort()
const caseOf = (f) => basename(f, '.mjs')
let pick = files
let requested = null
if (opts['cases-file']) {
  try { requested = JSON.parse(readFileSync(resolve(opts['cases-file']), 'utf8')) } catch (e) { fail(`--cases-file: ${e.message}`) }
  if (!Array.isArray(requested)) fail('--cases-file must hold a JSON array of case ids')
} else if (opts.cases) requested = String(opts.cases).split(',').map((s) => s.trim()).filter(Boolean)
if (requested) {
  const bad = requested.filter((id) => !CASE_ID.test(String(id)))
  if (bad.length) fail('not internal case ids ([A-Za-z0-9_-]) — use the ids cases.mjs gives', { bad })
  const have = new Set(files.map(caseOf))
  const missing = requested.filter((id) => !have.has(id))
  if (missing.length) fail('no flow for these cases — write them first (a missing flow is never skipped)', { requested, missing })
  const want = new Set(requested)
  pick = files.filter((f) => want.has(caseOf(f)))
}
if (opts.failed) pick = pick.filter((f) => (manifest.cases[caseOf(f)] || {}).lastResult !== 'PASS')
const target = opts.target || 'local'
const commit = opts.commit || commitOf(dir)
// What a result was measured on: the flow file plus the workspace library files it imports.
const libDir = join(rootOfTask(dir), '.pipeline', '_lib')
function flowHash(f) {
  const h = createHash('sha256')
  let src = ''
  try { src = readFileSync(join(flowsDir, f), 'utf8') } catch {}
  h.update(src)
  const libs = [...new Set([...src.matchAll(/(?:\$\{lib\}|_lib)\/([\w.-]+\.m?js)/g)].map((m) => m[1]))].sort()
  for (const l of libs) { h.update(`\0${l}\0`); try { h.update(readFileSync(join(libDir, l))) } catch {} }
  return h.digest('hex').slice(0, 16)
}
const hashes = Object.fromEntries(pick.map((f) => [caseOf(f), flowHash(f)]))
if (opts.list) {
  const rows = pick.map((f) => {
    const c = caseOf(f), m = manifest.cases[c] || {}
    const fresh = m.lastResult === 'PASS' && m.commit === commit && (m.lastTarget || 'local') === target && m.flowHash === hashes[c]
    const plat = m.platform || (/androidFlow/.test(readFileSync(join(flowsDir, f), 'utf8')) ? 'android' : 'web')
    return `${c} · ${plat} · ${m.lastResult || 'never run'}${m.lastResult ? ` (${m.lastTarget || 'local'})` : ''} · ${fresh ? 'up to date' : m.lastResult ? 'stale' : '-'} · ${m.durationMs ? Math.round(m.durationMs / 1000) + 's' : '-'}${m.lastResult && m.lastResult !== 'PASS' && m.error ? ` · ${String(m.error).split('\n')[0].slice(0, 120)}` : ''}`
  })
  console.log(`${rows.length} flows · commit ${String(commit).slice(0, 12)} · target ${target}\n${rows.join('\n')}`)
  process.exit(0)
}
if (opts.changed) {
  const same = (f) => { const m = manifest.cases[caseOf(f)] || {}; return m.lastResult === 'PASS' && m.commit === commit && (m.lastTarget || 'local') === target && m.flowHash === hashes[caseOf(f)] }
  const skipped = pick.filter(same).map(caseOf)
  pick = pick.filter((f) => !same(f))
  if (!pick.length) { console.log(JSON.stringify({ target, commit, upToDate: true, ran: 0, skipped, note: 'every case already PASSed on this commit, target and flow' })); process.exit(0) }
  if (skipped.length) opts._skipped = skipped
}
if (!pick.length) fail('nothing to run — an empty run is not a result', { requested: requested || [], failed: !!opts.failed })
if (opts.target && !manifest.targets[opts.target] && !Object.keys(opts.env).length) fail(`target "${opts.target}" is not saved in flows.json — run --ensure-target ${opts.target} first`)

const evd = join(dir, 'evd')
mkdirSync(evd, { recursive: true })
// Unique per invocation: a verdict left by an earlier run (even one in the same second) never counts.
const runId = `${Math.floor(Date.now() / 1000).toString(36)}-${randomBytes(4).toString('hex')}`
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
    let src = ''
    try { src = readFileSync(join(flowsDir, f), 'utf8') } catch {}
    const limit = Number(opts.timeout) || (/androidFlow/.test(src) ? 360 : 180)
    const timer = setTimeout(() => {
      const at = [...outText.matchAll(/\[tf-step\] (.+)/g)].pop()
      failure = `timed out after ${limit}s${at ? ` in step "${at[1].trim()}"` : ''}`
      p.kill('SIGKILL')
    }, limit * 1000)
    p.on('error', (e) => { failure = String(e.message) })
    p.on('close', (code, signal) => {
      clearTimeout(timer)
      let v = null
      try { v = JSON.parse(readFileSync(join(evd, `${c}.verdict.json`), 'utf8')) } catch {}
      // A flow that wrote PASS and then crashed, was killed or timed out did not pass.
      if (v && v.runId === runId && v.status === 'PASS' && (failure || signal || code !== 0))
        v = { ...v, status: failure ? 'BLOCKED' : 'FAIL', error: failure || `flow exited with ${signal || `code ${code}`} after writing PASS: ${outText.slice(-800)}` }
      if (!v || v.runId !== runId) v = { case: c, status: failure ? 'BLOCKED' : 'FAIL', error: failure || outText.slice(-1500) || 'flow wrote no verdict', shots: [], durationMs: 0 }
      // The app's rate limiter stopped the flow (seeding a tournament, a login): the environment, not the app.
      if (v.status === 'FAIL' && RATE_LIMITED.test(String(v.error || ''))) {
        v = { ...v, status: 'BLOCKED', rateLimited: true, error: `rate-limited (HTTP 429) — not a bug: raise the limit in the task server's env (config "## Servers"), serve.mjs restart <server>, run again. ${String(v.error).split('\n')[0].slice(0, 300)}` }
      }
      const shots = (v.shots || []).map((x) => x.replace(/\.png$/, '.webp'))
      // Keep what other tools recorded about the case (caseRev from --mark-written); replace only the run result.
      const prev = { ...(manifest.cases[c] || {}) }
      for (const k of ['warnings', 'trace', 'page', 'marks', 'marked']) delete prev[k]
      ran[c] = { ...prev, file: `flows/${f}`, platform: v.platform || (/androidFlow/.test(readFileSync(join(flowsDir, f), 'utf8')) ? 'android' : 'web'), lastResult: v.status, lastRunAt: new Date().toISOString(), lastTarget: target, commit, flowHash: hashes[c], durationMs: v.durationMs, shots, error: v.error || '' }
      if (v.marks && v.marks.length) ran[c].marks = v.marks.map(({ label, expected, actual, step }) => ({ label, ...(expected !== undefined ? { expected } : {}), ...(actual !== undefined ? { actual } : {}), ...(step ? { step } : {}) }))
      verdicts[c] = v
      if (v.warnings && v.warnings.length) ran[c].warnings = v.warnings
      if (v.trace) ran[c].trace = v.trace
      if (v.page) ran[c].page = `evd/${v.page}`
      results.push({ case: c, status: v.status, error: (v.error || '').split('\n')[0], shots, ...(v.rateLimited ? { rateLimited: true } : {}), ...(v.warnings && v.warnings.length ? { warnings: v.warnings } : {}), ...(v.trace ? { trace: v.trace } : {}), ...(v.page ? { page: `evd/${v.page}` } : {}) })
      done()
    })
  })
}
// --jobs N runs N cases at a time (flows seed their own data, so they do not depend on each other).
const ran = {}
const verdicts = {}
const queue = [...pick]
const workers = Math.max(1, Math.min(Number(opts.jobs) || 1, 6, queue.length || 1))
await Promise.all(Array.from({ length: workers }, async () => { while (queue.length) await runCase(queue.shift()) }))
results.sort((x, y) => pick.findIndex((f) => caseOf(f) === x.case) - pick.findIndex((f) => caseOf(f) === y.case))
// Evidence that points at the bug: every shot with marks, and the failure shots of a failed case, get a marked
// copy (red boxes + labels) and, when the marked area is small or the flow asked for it, a close-up. Done here,
// before WebP, so no model ever has to look at the image.
const pwFrom = childEnv.PLAYWRIGHT_FROM || process.env.TF_PLAYWRIGHT || ''
try {
  const jobs = []
  for (const [c, v] of Object.entries(verdicts)) {
    const byFile = new Map()
    for (const m of v.marks || []) { if (!byFile.has(m.file)) byFile.set(m.file, []); byFile.get(m.file).push({ box: m.box || null, label: m.label }) }
    if (v.status !== 'PASS') for (const f of (v.shots || []).filter((x) => /-fail-/.test(x))) if (!byFile.has(f)) byFile.set(f, [{ box: null, label: (v.error || v.status).split('\n')[0].slice(0, 160) }])
    for (const [f, marks] of byFile) if (existsSync(join(evd, f))) jobs.push({ case: c, file: join(evd, f), shot: f, marks, crop: (v.crop || []).includes(f) ? true : undefined, scale: v.platform === 'android' ? 2.6 : 1 })
  }
  if (jobs.length) {
    const { annotateAll } = await import('./annotate.mjs')
    const res = await annotateAll(jobs.map(({ file, marks, crop, scale }) => ({ file, marks, crop, scale })), { playwrightFrom: pwFrom || undefined })
    jobs.forEach((j, i) => {
      const r = (res && res[i]) || {}
      if (!r.marked) return
      // Caption: the one the flow gave, else the label of the failure itself (the mark a failed expect() left),
      // else the first label on the image.
      const own = (verdicts[j.case].marks || []).filter((m) => m.file === j.shot)
      const failing = own.find((m) => m.step && (m.expected !== undefined || m.actual !== undefined)) || own.find((m) => m.step)
      const cap = (verdicts[j.case].captions || {})[j.shot] || (failing && failing.label) || j.marks.map((m) => m.label).filter(Boolean)[0] || ''
      const webp = (p) => basename(p).replace(/\.png$/, '.webp')
      ran[j.case].marked = [...(ran[j.case].marked || []), { file: webp(r.marked), caption: cap }, ...(r.crop ? [{ file: webp(r.crop), caption: cap }] : [])]
    })
    for (const x of results) if (ran[x.case] && ran[x.case].marked) x.marked = ran[x.case].marked.map((m) => m.file)
  }
} catch (e) { for (const x of results) if (x.status !== 'PASS') x.warnings = [...(x.warnings || []), `marking evidence failed: ${String(e.message || e).slice(0, 160)}`] }
// Screenshots → WebP (EVD rule). Skips silently if no encoder is available.
const pngs = readdirSync(evd).filter((f) => f.endsWith('.png')).map((f) => join(evd, f))
if (pngs.length) {
  try { execFileSync(process.execPath, [join(HERE, 'webp.mjs'), ...pngs, ...(childEnv.PLAYWRIGHT_FROM ? ['--playwright', childEnv.PLAYWRIGHT_FROM] : [])], { stdio: 'pipe', timeout: 300_000 }) } catch {}
}
// Another tester may have run other cases meanwhile: merge this run's cases into the file as it is now.
try { Object.assign(manifest, JSON.parse(readFileSync(manifestPath, 'utf8'))) } catch {}
manifest.targets ||= {}
manifest.cases ||= {}
// Per case: what is on disk now (a caseRev recorded meanwhile survives), with this run's result on top.
for (const [c, r] of Object.entries(ran)) {
  const now = { ...(manifest.cases[c] || {}) }
  for (const k of ['warnings', 'trace', 'page', 'marks', 'marked']) delete now[k]
  manifest.cases[c] = { ...now, ...r, ...(now.caseRev && !r.caseRev ? { caseRev: now.caseRev } : {}) }
}
save()
const count = (s) => results.filter((x) => x.status === s).length
// Default output is what the tester acts on; --verbose keeps every field (warnings, trace, marked files).
const brief = (x) => ({ case: x.case, status: x.status, ...(x.rateLimited ? { rateLimited: true } : {}), ...(x.status !== 'PASS' ? { error: x.error } : {}), ...(x.page ? { page: x.page } : {}), ...(x.status !== 'PASS' && (x.marked || x.shots).length ? { evd: (x.marked || x.shots).slice(0, 3) } : {}), ...(x.warnings ? { warnings: x.warnings.length } : {}) })
console.log(JSON.stringify({ target, commit, requested: requested || pick.map(caseOf), missing: [], ran: results.length, pass: count('PASS'), fail: count('FAIL'), blocked: count('BLOCKED'), ...(opts._skipped ? { skipped: opts._skipped } : {}), results: opts.verbose ? results : results.map(brief) }, opts.verbose ? null : undefined, opts.verbose ? 2 : undefined))
process.exit(results.every((x) => x.status === 'PASS') ? 0 : 1)
