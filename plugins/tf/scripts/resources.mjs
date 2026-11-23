#!/usr/bin/env node
// task-flow resource registry. One file per task: <root>/.pipeline/<slug>/resources.json.
// Every resource a task holds is an entry with the exact commands that free it, so cleanup
// never guesses and never touches another session's resources.
//
//   add <root> <slug> --kind K --id ID --release CMD [--stop CMD] [--when run-end|pr-merged]
//                                               exit 3 when another task of the workspace holds that kind + id
//   drop <root> <slug> --kind K --id ID         remove an entry without running anything
//   prs <root> <slug> <pr-url>...               PRs whose merge frees the task
//   taken <root> <kind>                         ids of <kind> held by any task (one per line)
//   end-run <root> <slug>                       run every `stop`, release + drop `run-end` entries
//   release <root> <slug>                       release everything now (manual cleanup / verify-only)
//   reap [--dry-run] [<root>...]                release tasks whose PRs are all merged or closed, then
//                                               move .pipeline/<slug> to .pipeline/_archive/<slug>
//   archive <root> <slug>                       move a finished task folder to .pipeline/_archive/ and slim it: the
//                                               text (plans, ticket, handoff, feedback, history) stays, evidence
//                                               images, logs, scratch and attachments go (the PRs are merged)
//   due <root>                                  one line when cleanup is due (last /tf:clean over 7 days ago, and 3+
//                                               task worktree folders or 0.5 GB of archive), else nothing — for the run report
//   prune [--days 7] [--dry-run] [<root>...]    tasks idle longer than N days: free their resources; delete the
//                                               folder when no PR is still open (else keep only the text handoff
//                                               files); delete old _archive entries and stray clean worktrees
//   promote <root> <slug>                       copy the task's passing flows into .pipeline/_regression/ (reap does it on merge)
//   list [<root>...]                            print what every task holds (the only resource ledger)
//   list --table [<root>...]                    one line per task for a person: PRs, what it holds, disk, whether
//                                               /tf:clean frees it now; flags an id two tasks hold at once
//   register-root <root>                        add a workspace to the list `reap` uses when no root is given
//   restore-touched <root> <worktree>           put back the files tools rewrite on their own (config
//                                               "## Tool-touched files"); done automatically before a worktree is freed
//
// `when`: run-end = browsers, emulators (freed when a run stops); pr-merged = worktrees, DB clones,
// cache dbs, ports (kept for review fixes, freed by `reap` once every PR is merged/closed).
// A worktree with uncommitted or unpushed work is never removed; it stays flagged for the user.
// PRs: full URL or `owner/repo#n`. A task with no registered PR gets them from its worktrees' branches.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync, appendFileSync, renameSync, statSync, copyFileSync, chmodSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SH, androidSdk, cwdOf, killTree, pidsOnPort, sdkTool, stateDir, under } from './platform.mjs'

const HOME_DIR = stateDir()
const ROOTS = join(HOME_DIR, 'roots.txt')
const LOG = join(HOME_DIR, 'reap.log')

// A task folder name: a ticket key or a slug made by task.mjs. Never a path — `..` or a separator in a slug
// would point load, release and archive at a folder outside .pipeline/.
export const okSlug = (slug) => typeof slug === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) && !slug.includes('..')
const fileOf = (root, slug) => {
  if (!okSlug(slug)) throw new Error(`not a task name: ${JSON.stringify(slug)}`)
  return join(root, '.pipeline', slug, 'resources.json')
}
// Folders of .pipeline/ that are not tasks and must never be freed, slimmed or deleted by cleanup.
const NOT_TASKS = new Set(['digest']) // /tf:digest keeps its checkpoint and every digest there
const stamp = () => new Date().toISOString()
let logReady = false
const say = (msg) => {
  console.log(msg)
  // The log quotes failed release commands, which may hold a DB URL: readable by the user only.
  if (!logReady) { mkdirSync(HOME_DIR, { recursive: true }); try { if (existsSync(LOG)) chmodSync(LOG, 0o600) } catch {} logReady = true }
  appendFileSync(LOG, `${stamp()} ${msg}\n`, { mode: 0o600 })
}

export function load(root, slug) {
  const f = fileOf(root, slug)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { slug, prs: [], entries: [] }
}
function save(root, slug, data) {
  mkdirSync(join(root, '.pipeline', slug), { recursive: true })
  writeFileSync(fileOf(root, slug), JSON.stringify(data, null, 2) + '\n')
}
function tasks(root) {
  const dir = join(root, '.pipeline')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((s) => okSlug(s) && !s.startsWith('_') && !NOT_TASKS.has(s) && existsSync(fileOf(root, s)))
}
// A password inside a URL never reaches the terminal or the log.
const mask = (s) => String(s).replace(/(:\/\/[^:/\s@]+:)[^@\s]+@/g, '$1***@')
function run(cmd, root) {
  try {
    execSync(cmd, { cwd: root, stdio: 'pipe', shell: SH, windowsHide: true, timeout: 120_000 })
    return true
  } catch (e) {
    say(`  ! failed: ${mask(cmd)} — ${mask(String(e.stderr || e.message).trim().split('\n')[0])}`)
    return false
  }
}
const tool = (file, args, cwd) => {
  try { return execFileSync(file, args, { cwd, stdio: 'pipe', windowsHide: true, timeout: 120_000 }).toString().trim() } catch { return null }
}

// ── How a resource is freed ──────────────────────────────────────────────────
// resources.json is a file any job of a task can write, and what it holds is run later, when nobody is
// looking. So for the kinds tf itself knows, the ledger only says WHAT is held (kind + id): the action is
// built here from the id, and a `release`/`stop` string stored with the entry is ignored. Each returns '' when
// the resource is free, or why it is not.
const HERE = dirname(fileURLToPath(import.meta.url))
const SERIAL = /^emulator-\d{4,5}$/
// A process is this task's when it runs from the task's worktrees or its task folder.
const ownedBy = (pid, root, slug) => { const cwd = cwdOf(pid); return cwd ? (under(cwd, join(root, '.worktrees', slug)) || under(cwd, join(root, '.pipeline', slug))) : null }
const BUILTIN = {
  worktree: {
    plan: (e) => `git worktree remove --force ${e.id}`,
    release(e, root) {
      const path = resolve(e.id)
      if (!under(path, join(root, '.worktrees')) || path === resolve(root, '.worktrees')) return `not a folder of ${join(root, '.worktrees')}`
      const common = (tool('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], path) || '').replace(/[\\/]\.git$/, '')
      if (!common) return 'not a git worktree'
      return tool('git', ['-C', common, 'worktree', 'remove', '--force', path]) === null ? 'git worktree remove failed' : ''
    },
  },
  // A port is a reservation. Whatever listens on it is stopped only when it is this task's own process:
  // weeks after a run, the listener is far more likely somebody else's. Where the system cannot tell
  // (Windows), a listener is stopped right after the run (`stop`) and left alone later (`release`).
  port: {
    plan: (e) => `stop this task's own listener on port ${e.id}, if any`,
    release: (e, root, slug) => freePort(e, root, slug, false),
    stop: (e, root, slug) => freePort(e, root, slug, true),
  },
  browser: {
    plan: (e) => `stop browser process ${e.id}`,
    release(e) { if (!/^\d+$/.test(String(e.id))) return 'not a process id'; try { killTree(e.id) } catch {} return '' },
  },
  emulator: {
    plan: (e) => `adb -s ${e.id} emu kill`,
    release(e) { if (!SERIAL.test(String(e.id))) return 'not an emulator serial'; tool(sdkTool(androidSdk(), 'platform-tools', 'adb'), ['-s', e.id, 'emu', 'kill']); return '' },
  },
  server: {
    plan: (e) => `serve.mjs stop ${e.id}`,
    release(e, root, slug) { if (!/^[\w.-]+$/.test(String(e.id))) return 'not a server name'; tool(process.execPath, [join(HERE, 'serve.mjs'), 'stop', root, slug, e.id]); return '' },
  },
}
BUILTIN.server.stop = BUILTIN.server.release
function freePort(e, root, slug, justRan) {
  const port = Number(e.id)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'not a port number'
  for (const pid of pidsOnPort(port)) {
    if (!Number(pid)) continue
    const mine = ownedBy(pid, root, slug)
    if (mine || (mine === null && justRan)) { try { killTree(pid) } catch {} } else say(`  port ${port}: process ${pid} is not this task's — left running`)
  }
  return ''
}

// Every other kind (a database, a cache index…) is freed by a command only the workspace knows. The setup
// job copies it from the config's "## Provisioning" table, so the table is the list of commands that may run:
// a stored command is run when it is one of that kind's recipes with the <placeholders> filled in by plain
// values — no spaces, no shell syntax. Anything else is kept and shown, and runs only when a person who has
// seen it says so (`release --unlisted`).
export function recipes(root) {
  const cfg = join(root, '.claude', 'task-flow.md')
  const out = {}
  if (!existsSync(cfg)) return out
  const txt = readFileSync(cfg, 'utf8')
  const i = txt.search(/^## Provisioning\b/m)
  if (i < 0) return out
  const body = txt.slice(i).split(/\r?\n/).slice(1)
  const end = body.findIndex((l) => /^## /.test(l))
  for (const line of (end < 0 ? body : body.slice(0, end))) {
    if (!/^\s*\|/.test(line)) continue
    const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
    const kind = (cells[0].match(/^[A-Za-z][\w-]*/) || [''])[0]
    if (!kind || kind === 'kind') continue
    for (const cell of cells.slice(2)) for (const m of cell.matchAll(/`([^`]+)`/g)) (out[kind] ||= []).push(m[1].trim())
  }
  return out
}
const squeeze = (s) => String(s).trim().replace(/\s+/g, ' ')
export function listed(cmd, templates = []) {
  const c = squeeze(cmd)
  return templates.some((t) => new RegExp('^' + squeeze(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<[^<>]+>/g, '[^\\s;&|`$()<>\'"]+') + '$').test(c))
}
// What freeing an entry will do, for a person to read before saying yes.
export function plan(e, root, known = recipes(root)) {
  if (BUILTIN[e.kind]) return BUILTIN[e.kind].plan(e)
  return `${mask(e.release)}${listed(e.release, known[e.kind]) ? '' : '   ← NOT a recipe of this workspace\'s config: runs only with `release --unlisted`'}`
}
// Free one entry (`stop: true` = only stop it after a run). Returns '' when done, or why not.
function free(e, root, slug, { stop = false, unlisted = false, known }) {
  const b = BUILTIN[e.kind]
  if (b) return stop ? (b.stop ? b.stop(e, root, slug) : '') : b.release(e, root, slug)
  const cmd = stop ? e.stop : e.release
  if (!cmd) return stop ? '' : 'no release command'
  if (!unlisted && !listed(cmd, known[e.kind])) return `its ${stop ? 'stop' : 'release'} command is not a ${e.kind} recipe of this workspace's config`
  return run(cmd, root) ? '' : 'release failed'
}

// Kinds whose id names something inside the task (a server name like "be"): every task has its own, so two
// tasks holding the same id is normal. Every other kind (a cache index, a DB, a port, a path, a serial) is one
// thing on the machine: held by one task at a time.
const TASK_SCOPED = new Set(['server'])
export class HeldError extends Error {
  constructor(kind, id, by) { super(`${kind} ${id} is held by task ${by} — pick another one (resources.mjs taken <root> ${kind})`); this.kind = kind; this.id = id; this.by = by }
}
// One claim at a time per workspace: check-then-write is atomic, so two setup jobs never take the same id.
// The lock is a directory (mkdir is atomic everywhere); one older than 30 s is a crashed claimer's.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
function claiming(root, fn) {
  const dir = join(root, '.pipeline')
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, '.resources.lock')
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmSync(lock, { recursive: true, force: true }); continue } } catch {}
      if (i > 200) throw new Error(`resources lock ${lock} is busy`)
      pause(50)
    }
  }
  try { return fn() } finally { rmSync(lock, { recursive: true, force: true }) }
}
export function holder(root, kind, id, except = '') {
  if (TASK_SCOPED.has(kind)) return ''
  return tasks(root).find((s) => s !== except && load(root, s).entries.some((e) => e.kind === kind && String(e.id) === String(id))) || ''
}
export function add(root, slug, entry) {
  claiming(root, () => {
    const by = holder(root, entry.kind, entry.id, slug)
    if (by) throw new HeldError(entry.kind, entry.id, by)
    const d = load(root, slug)
    d.entries = d.entries.filter((e) => !(e.kind === entry.kind && e.id === entry.id))
    d.entries.push({ when: 'pr-merged', ...entry, since: stamp() })
    save(root, slug, d)
  })
}
export function drop(root, slug, kind, id) {
  const d = load(root, slug)
  d.entries = d.entries.filter((e) => !(e.kind === kind && e.id === id))
  save(root, slug, d)
}
export function taken(root, kind) {
  return tasks(root).flatMap((s) => load(root, s).entries.filter((e) => e.kind === kind).map((e) => e.id))
}

const git = (args, cwd) => tool('git', args, cwd) || ''
const gh = (args, cwd) => tool('gh', args, cwd) || ''
// Files the workspace config lists under "## Tool-touched files": tools rewrite them on their own
// (`flutter pub get` adds exclude lines to analysis_options.yaml, an IDE re-sorts a lockfile…). They are
// never part of a change, so a worktree whose only edits are in them holds no work.
export function toolTouched(root) {
  const cfg = join(root, '.claude', 'task-flow.md')
  if (!existsSync(cfg)) return []
  const txt = readFileSync(cfg, 'utf8')
  const i = txt.search(/^## Tool-touched files\b/m)
  if (i < 0) return []
  const body = txt.slice(i).split('\n').slice(1)
  const end = body.findIndex((l) => /^## /.test(l))
  return (end < 0 ? body : body.slice(0, end)).map((l) => (l.match(/^\s*-\s*`([^`]+)`/) || [])[1]).filter(Boolean).map((p) => p.replace(/^\.\//, ''))
}
// Put the listed files back as committed when a tool changed them (tracked and modified only — a new or
// staged file is somebody's work). Returns the files restored.
export function restoreTouched(root, path) {
  const list = toolTouched(root)
  if (!list.length || !existsSync(path)) return []
  const done = []
  // `git diff --name-only`: tracked files with unstaged edits — exactly what a tool leaves behind.
  for (const file of git(['diff', '--name-only'], path).split(/\r?\n/).filter(Boolean)) {
    if (list.includes(file)) { git(['checkout', '--', file], path); done.push(file) }
  }
  return done
}
// Uncommitted changes, or commits not on the remote branch → the worktree holds work nobody else has.
// `restore: false` (a dry run) only looks: it changes no file, and counts a tool-touched file as no work.
function unsavedWork(path, root, restore = true) {
  if (!existsSync(path)) return ''
  if (root && restore) restoreTouched(root, path)
  const touched = root && !restore ? toolTouched(root) : []
  // ` M file` is a tracked file with unstaged edits (the output is trimmed, so the first line loses its leading space).
  const edits = git(['status', '--porcelain'], path).split(/\r?\n/).filter(Boolean)
    .filter((l) => { const m = l.match(/^ ?M (?! )(.+)$/); return !(m && touched.includes(m[1])) })
  if (edits.length) return 'uncommitted changes'
  if (git(['log', '--oneline', '-1', 'HEAD', '--not', '--remotes'], path)) return 'unpushed commits'
  return ''
}

// Release entries matching `pick`; keep the ones whose command failed so nothing leaks silently.
function releaseWhere(root, slug, pick, unlisted = false) {
  const d = load(root, slug)
  const known = recipes(root)
  const keep = []
  let failed = 0
  for (const e of d.entries) {
    if (!pick(e)) { keep.push(e); continue }
    const why = e.kind === 'worktree' ? unsavedWork(e.id, root) : ''
    if (why) { say(`  keep ${slug} worktree ${e.id}: ${why}`); keep.push({ ...e, error: why }); failed++; continue }
    // Removed by hand or by an earlier attempt: there is nothing left to free, and `git worktree remove`
    // would fail with "not a working tree" on every later cleanup.
    if (e.kind === 'worktree' && !existsSync(e.id)) { say(`  release ${slug} worktree ${e.id}: already gone`); continue }
    say(`  release ${slug} ${e.kind} ${e.id}`)
    const not = free(e, root, slug, { unlisted, known })
    if (not) { say(`  keep ${slug} ${e.kind} ${e.id}: ${not}`); keep.push({ ...e, error: not }); failed++ }
  }
  d.entries = keep
  if (!keep.length && pick({ when: 'pr-merged' })) rmSync(fileOf(root, slug))
  else save(root, slug, d)
  return failed === 0 // true when everything asked for was released (entries not picked stay, and are not a failure)
}
export function endRun(root, slug) {
  const known = recipes(root)
  for (const e of load(root, slug).entries) if (e.stop) { const not = free(e, root, slug, { stop: true, known }); if (not) say(`  ${slug} ${e.kind} ${e.id} not stopped: ${not}`) }
  return releaseWhere(root, slug, (e) => e.when === 'run-end')
}
export function releaseAll(root, slug, unlisted = false) {
  say(`release ${slug} @ ${root}`)
  return releaseWhere(root, slug, () => true, unlisted)
}

function prState(ref) {
  const m = String(ref).match(/^([\w.-]+\/[\w.-]+)#(\d+)$/) // owner/repo#n — gh pr view needs --repo for this form
  if (!m && !/^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/.test(String(ref))) return 'UNKNOWN' // not a PR reference: never an option for gh
  return gh(['pr', 'view', ...(m ? [m[2], '--repo', m[1]] : [String(ref)]), '--json', 'state', '-q', '.state']) || 'UNKNOWN'
}
// PRs opened from the task's worktree branches (any state) — for tasks that never registered theirs.
function prsFromWorktrees(d) {
  const urls = []
  for (const e of d.entries.filter((x) => x.kind === 'worktree' && existsSync(x.id))) {
    const b = git(['branch', '--show-current'], e.id)
    if (b) urls.push(...gh(['pr', 'list', '--head', b, '--state', 'all', '--json', 'url', '-q', '.[].url'], e.id).split('\n').filter(Boolean))
  }
  return [...new Set(urls)]
}
export function archive(root, slug) {
  if (!okSlug(slug)) throw new Error(`not a task name: ${JSON.stringify(slug)}`)
  const from = join(root, '.pipeline', slug)
  if (!existsSync(from) || existsSync(fileOf(root, slug))) return false // still holds resources
  const to = join(root, '.pipeline', '_archive', slug)
  mkdirSync(join(root, '.pipeline', '_archive'), { recursive: true })
  if (existsSync(to)) rmSync(to, { recursive: true, force: true })
  renameSync(from, to)
  const freed = slimArchived(to)
  say(`archive ${slug} → .pipeline/_archive/${freed ? ` (slimmed, ${Math.round(freed / 1048576)} MB freed)` : ''}`)
  return true
}
// An archived task keeps what a person or a later ticket reads — text — and drops what only the run needed.
const HEAVY_DIRS = new Set(['evd', 'logs', 'tmp', 'node_modules', 'attachments', '_sink', 'chain', 'proto-shots'])
const HEAVY_FILE = /\.(webp|png|jpe?g|gif|mp4|webm|zip|apk|aab|ipa|trace|log|har|tar|gz|tgz|pdf|xlsx?)$/i
export function slimArchived(dir) {
  let freed = 0
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n)
      let st
      try { st = statSync(f) } catch { continue }
      if (st.isDirectory()) {
        if (HEAVY_DIRS.has(n)) { freed += sizeOf(f); rmSync(f, { recursive: true, force: true }) } else walk(f)
      } else if (HEAVY_FILE.test(n) || st.size > 2 * 1048576) { freed += st.size; rmSync(f, { force: true }) }
    }
  }
  try { walk(dir) } catch {}
  return freed
}
function sizeOf(d) {
  let n = 0
  try { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); n += e.isDirectory() ? sizeOf(f) : statSync(f).size } } catch {}
  return n
}
const LAST_CLEAN = join(HOME_DIR, 'last-clean')
// Cleanup runs only when the user asks (/tf:clean). After a run the report says when it is due.
export function due(root) {
  let last = 0
  try { last = statSync(LAST_CLEAN).mtimeMs } catch {} // written by /tf:clean (reap); reap.log is also written by every run end
  const days = last ? Math.floor((Date.now() - last) / 86_400_000) : null
  if (days !== null && days <= 7) return ''
  // Cheap on purpose (it runs after every run): count task worktree folders, size only the archive.
  const wtDir = join(root, '.worktrees')
  const tasksWithWorktrees = existsSync(wtDir) ? readdirSync(wtDir).filter((n) => !n.startsWith('_') && !n.startsWith('.')).length : 0
  const ar = existsSync(join(root, '.pipeline', '_archive')) ? sizeOf(join(root, '.pipeline', '_archive')) : 0
  if (tasksWithWorktrees < 3 && ar < 512 * 1048576) return ''
  return `Cleanup due: ${days === null ? 'no /tf:clean yet' : `last /tf:clean ${days} days ago`} — ${tasksWithWorktrees} task worktree folders, archive ${(ar / 1073741824).toFixed(1)} GB. /tf:status shows what /tf:clean frees.`
}

function roots(args) {
  if (args.length) return args.map((r) => resolve(r))
  return existsSync(ROOTS) ? readFileSync(ROOTS, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : []
}
// When a task's PRs are merged, its passing e2e flows join the workspace regression suite
// (<root>/.pipeline/_regression/flows/<slug>-<case>.mjs + flows.json), runnable with flow-run.mjs.
export function promoteFlows(root, slug) {
  const dir = join(root, '.pipeline', slug)
  const mf = join(dir, 'flows.json')
  if (!existsSync(mf)) return 0
  let m
  try { m = JSON.parse(readFileSync(mf, 'utf8')) } catch { return 0 }
  const reg = join(root, '.pipeline', '_regression')
  const regMf = join(reg, 'flows.json')
  mkdirSync(join(reg, 'flows'), { recursive: true })
  const r = existsSync(regMf) ? JSON.parse(readFileSync(regMf, 'utf8')) : { targets: {}, cases: {} }
  r.targets ||= {}
  r.cases ||= {}
  let n = 0
  for (const [c, v] of Object.entries(m.cases || {})) {
    if (v.lastResult !== 'PASS' || !v.file || !existsSync(join(dir, v.file))) continue
    const id = `${slug}-${c}`
    copyFileSync(join(dir, v.file), join(reg, 'flows', `${id}.mjs`))
    r.cases[id] = { file: `flows/${id}.mjs`, platform: v.platform, source: slug, promotedAt: stamp(), lastResult: 'PASS' }
    n++
  }
  writeFileSync(regMf, JSON.stringify(r, null, 2) + '\n')
  if (n) say(`promote ${n} flow(s) of ${slug} → .pipeline/_regression/`)
  return n
}

// Whether reap would free a task now, and why not. `d.prs` is filled from the worktree branches when the task
// never registered its PRs (saved unless dryRun).
function reapable(root, slug, d, dryRun) {
  if (running(join(root, '.pipeline', slug))) return { ok: false, why: 'run in progress', states: [] }
  if (!d.prs.length) {
    const found = prsFromWorktrees(d)
    if (!found.length) return { ok: false, why: 'no PR', states: [] } // in progress, escalated, or a detached verify run — release by hand
    d.prs = found
    if (!dryRun) save(root, slug, d)
  }
  const states = d.prs.map(prState)
  const open = states.filter((s) => s !== 'MERGED' && s !== 'CLOSED').length
  return { ok: !open, why: open ? `${open} PR open` : '', states }
}
export function reap(rootList, dryRun = false) {
  for (const root of rootList) {
    for (const slug of tasks(root)) {
      const d = load(root, slug)
      const { ok, states } = reapable(root, slug, d, dryRun)
      if (!ok) continue
      if (dryRun) { console.log(`would reap ${slug}:${d.entries.length ? '' : ' nothing held'}`); const known = recipes(root); for (const e of d.entries) console.log(`   ${e.kind} ${e.id} → ${plan(e, root, known)}`); continue }
      say(`reap ${slug}: PRs ${states.join(',')}`)
      try { promoteFlows(root, slug) } catch (e) { say(`promote ${slug} failed: ${e.message}`) }
      if (releaseAll(root, slug)) archive(root, slug)
    }
  }
}

// One line per task, for a person: what it holds, its PRs, whether /tf:clean frees it now, and the disk its
// worktrees take. No commands, no paths — `list` prints those.
const diskKB = (path) => { const out = String(tool('du', ['-sk', path]) || ''); return Number((out.match(/^(\d+)/) || [])[1]) || 0 }
const gb = (kb) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`)
export function table(rootList) {
  const rows = []
  for (const root of rootList) {
    for (const slug of tasks(root)) {
      const d = load(root, slug)
      const kinds = {}
      for (const e of d.entries) (kinds[e.kind] ||= []).push(e.kind === 'worktree' ? '' : String(e.id))
      const holds = Object.entries(kinds).map(([k, ids]) => (k === 'worktree' ? `${ids.length} worktree` : `${k} ${ids.join(',')}`)).join(' · ') || '-'
      const kb = d.entries.filter((e) => e.kind === 'worktree' && existsSync(e.id)).reduce((s, e) => s + diskKB(e.id), 0)
      const r = reapable(root, slug, d, true)
      const merged = r.states.filter((s) => s === 'MERGED').length
      const prs = r.states.length ? `${merged}/${r.states.length} merged` : '-'
      const kept = d.entries.filter((e) => e.error).map((e) => `${e.kind === 'worktree' ? basename(e.id) : e.kind}: ${e.error === true ? 'release failed' : e.error}`)
      const clean = !d.entries.length ? 'nothing held' : r.ok ? (kept.length ? `yes, except ${kept.join('; ')}` : 'yes') : `no — ${r.why}`
      rows.push({ slug, prs, holds, disk: kb ? gb(kb) : '-', kb, clean, ok: r.ok })
    }
  }
  const cell = (s) => String(s).replace(/\|/g, '\\|')
  const lines = ['| Task | PRs | Holds | Disk | /tf:clean frees it |', '|---|---|---|---|---|',
    ...rows.map((x) => `| ${cell(x.slug)} | ${x.prs} | ${cell(x.holds)} | ${x.disk} | ${cell(x.clean)} |`)]
  const free = rows.filter((x) => x.ok)
  lines.push('', `${rows.length} tasks · ${free.length} freed by /tf:clean now (${gb(free.reduce((s, x) => s + x.kb, 0))}) · worktrees in total ${gb(rows.reduce((s, x) => s + x.kb, 0))}`)
  const dups = {}
  for (const root of rootList) for (const slug of tasks(root)) for (const e of load(root, slug).entries) if (!TASK_SCOPED.has(e.kind)) (dups[`${e.kind} ${e.id}`] ||= []).push(slug)
  for (const [k, by] of Object.entries(dups)) if (by.length > 1) lines.push(`⚠ ${k} is held by ${by.join(' and ')} at the same time`)
  return lines.join('\n') + '\n'
}

// Last activity of a task folder: newest file, ignoring the ledger itself and logs (both are touched by tooling).
function lastActivity(dir) {
  let newest = 0
  const walk = (d, depth) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name)
      if (f.isDirectory()) { if (depth < 4) walk(p, depth + 1); continue }
      if (f.name === 'resources.json' || f.name.endsWith('.log') || f.name === '.DS_Store') continue
      try { newest = Math.max(newest, statSync(p).mtimeMs) } catch {}
    }
  }
  try { walk(dir, 0) } catch {}
  return newest || statSync(dir).mtimeMs
}
// A run holds .lock; the workflow treats one older than 90 minutes as stale, and so do we.
const running = (dir) => { try { return Date.now() - statSync(join(dir, '.lock')).mtimeMs < 5_400_000 } catch { return false } }
// Text handoff files a later round needs (HANDOFF, journal, flows; old-layout folders: STATUS, spec). Evidence images,
// job reports, history and logs are heavy and regenerable.
const KEEP_WHEN_PR_OPEN = new Set(['HANDOFF.md', 'journal.md', 'flows', 'flows.json', 'plan.md', 'design.md', 'board.md', 'STATUS.md', 'spec.md', 'ticket.md', 'ticket-history.md', 'ticket-comment.md', 'feedback.md', 'feedback-history.md', 'feedback-triage.md', 'cases.md', 'cases.approved.json', 'resources.json', 'metrics.json'])
// Archived (all PRs merged/closed) tasks: slim to the handoff set after TF_PRUNE_DAYS, delete after this many days,
// so a QC report that arrives after the merge still finds HANDOFF.md and the flows.
const ARCHIVE_DAYS = Number(process.env.TF_ARCHIVE_DAYS || 30)
const days = (ms) => Math.floor((Date.now() - ms) / 86_400_000)

export function prune(rootList, maxDays = 7, dryRun = false) {
  const act = (msg, fn) => { if (dryRun) console.log(`would ${msg}`); else { say(msg); fn() } }
  for (const root of rootList) {
    const pipe = join(root, '.pipeline')
    if (!existsSync(pipe)) continue
    for (const slug of readdirSync(pipe)) {
      const dir = join(pipe, slug)
      if (slug.startsWith('_') || NOT_TASKS.has(slug) || !okSlug(slug) || !statSync(dir).isDirectory() || running(dir)) continue
      const idle = days(lastActivity(dir))
      if (idle <= maxDays) continue
      const d = load(root, slug)
      if (d.entries.length) act(`free ${slug} (idle ${idle}d)`, () => releaseAll(root, slug))
      if (!dryRun && existsSync(fileOf(root, slug)) && load(root, slug).entries.length) continue // something was kept (unsaved work)
      const prs = d.prs.length ? d.prs : prsFromWorktrees(d)
      const states = prs.map(prState)
      // gh offline, logged out or rate-limited: an open PR must not be mistaken for a closed one.
      if (states.includes('UNKNOWN')) { console.log(`keep ${slug}: could not read the state of its PR(s) — nothing deleted`); continue }
      const open = prs.filter((u, i) => states[i] === 'OPEN')
      if (open.length) {
        // A later QC round still needs the plan, ticket and state; everything heavy goes.
        act(`slim ${slug} (idle ${idle}d, PR open: ${open.join(' ')})`, () => {
          for (const f of readdirSync(dir)) if (!KEEP_WHEN_PR_OPEN.has(f)) rmSync(join(dir, f), { recursive: true, force: true })
        })
      } else {
        act(`delete ${slug} (idle ${idle}d, no open PR)`, () => rmSync(dir, { recursive: true, force: true }))
      }
    }
    const arch = join(pipe, '_archive')
    if (existsSync(arch)) for (const slug of readdirSync(arch)) {
      const dir = join(arch, slug)
      const idle = days(lastActivity(dir))
      if (idle > ARCHIVE_DAYS) act(`delete _archive/${slug} (idle ${idle}d)`, () => rmSync(dir, { recursive: true, force: true }))
      else if (idle > maxDays && readdirSync(dir).some((f) => !KEEP_WHEN_PR_OPEN.has(f))) {
        act(`slim _archive/${slug} (idle ${idle}d)`, () => {
          for (const f of readdirSync(dir)) if (!KEEP_WHEN_PR_OPEN.has(f)) rmSync(join(dir, f), { recursive: true, force: true })
        })
      }
    }
    // Worktrees no task ledger knows about: remove when clean, pushed, and idle; otherwise report.
    const wtRoot = join(root, '.worktrees')
    if (existsSync(wtRoot)) {
      const owned = new Set(tasks(root).flatMap((s) => load(root, s).entries.filter((e) => e.kind === 'worktree').map((e) => e.id)))
      // Layout: .worktrees/<SLUG>/<repo dir> (task parent folders) — older flat .worktrees/<slug>-<key> too.
      // .worktrees/_pool/* is the warm pool (pool.mjs) and never pruned.
      const candidates = []
      for (const name of readdirSync(wtRoot)) {
        const p = join(wtRoot, name)
        if (name.startsWith('_') || !statSync(p).isDirectory()) continue
        if (existsSync(join(p, '.git'))) candidates.push([name, p])
        else for (const sub of readdirSync(p)) if (existsSync(join(p, sub, '.git'))) candidates.push([`${name}/${sub}`, join(p, sub)])
      }
      for (const [name, wt] of candidates) {
        if (owned.has(wt)) continue
        const idle = days(statSync(wt).mtimeMs)
        if (idle <= maxDays) continue
        const why = unsavedWork(wt, root, !dryRun)
        if (why) { console.log(`stray worktree ${name} kept: ${why}`); continue }
        const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt).replace(/[\\/]\.git$/, '')
        act(`remove stray worktree ${name} (idle ${idle}d)`, () => { if (tool('git', ['-C', common, 'worktree', 'remove', '--force', wt]) === null) say(`  ! could not remove ${wt}`) })
      }
      // Empty task parent folders left after their worktrees were freed.
      if (!dryRun) for (const name of readdirSync(wtRoot)) {
        const p = join(wtRoot, name)
        if (name.startsWith('_') || !statSync(p).isDirectory() || existsSync(join(p, '.git'))) continue
        const holdsWorktree = readdirSync(p).some((sub) => existsSync(join(p, sub, '.git')))
        // Empty task folder, or leftovers (e.g. a dev server's vite cache) written after the worktree was removed.
        if (!holdsWorktree && (!readdirSync(p).length || days(statSync(p).mtimeMs) > maxDays)) rmSync(p, { recursive: true, force: true })
      }
    }
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2)
  const flags = {}
  const pos = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i]
    else pos.push(rest[i])
  }
  const [root, slug] = [pos[0] && resolve(pos[0]), pos[1]]
  switch (cmd) {
    case 'restore-touched': console.log(JSON.stringify({ restored: restoreTouched(root, resolve(pos[1] || '.')) })); break
    case 'add':
      if (!flags.kind || !flags.id) throw new Error('add needs --kind --id')
      if (!BUILTIN[flags.kind] && !flags.release) throw new Error(`add --kind ${flags.kind} needs --release: the command of the config's Provisioning table for that kind`)
      try {
        add(root, slug, { kind: flags.kind, id: flags.id, ...(flags.release && { release: flags.release }), ...(flags.stop && { stop: flags.stop }), when: flags.when || 'pr-merged' })
      } catch (e) {
        if (!(e instanceof HeldError)) throw e
        console.error(`held: ${e.message}`)
        process.exitCode = 3
      }
      break
    case 'drop': drop(root, slug, flags.kind, flags.id); break
    case 'prs': { const d = load(root, slug); d.prs = [...new Set([...d.prs, ...pos.slice(2)])]; save(root, slug, d); break }
    case 'taken': console.log(taken(root, slug).join('\n')); break
    case 'end-run': process.exitCode = endRun(root, slug) ? 0 : 1; break
    case 'promote': console.log(promoteFlows(root, slug)); break
    case 'release': process.exitCode = releaseAll(root, slug, process.argv.includes('--unlisted')) ? 0 : 1; break
    case 'reap': {
      const dry = process.argv.includes('--dry-run')
      const list = roots(process.argv.slice(3).filter((a) => a !== '--dry-run'))
      reap(list, dry)
      prune(list, Number(process.env.TF_PRUNE_DAYS || 7), dry) // /tf:clean runs `reap`, so pruning rides along
      if (!dry) { mkdirSync(HOME_DIR, { recursive: true }); writeFileSync(LAST_CLEAN, new Date().toISOString() + '\n') }
      break
    }
    case 'prune': {
      const a = process.argv.slice(3)
      const i = a.indexOf('--days')
      const n = i >= 0 ? Number(a.splice(i, 2)[1]) : 7
      const dry = a.includes('--dry-run')
      prune(roots(a.filter((x) => x !== '--dry-run')), n, dry)
      break
    }
    case 'archive': process.exitCode = archive(root, slug) ? 0 : 1; break
    case 'due': { const line = due(root); if (line) console.log(line); break }
    case 'list':
      if (process.argv.includes('--table')) { process.stdout.write(table(roots(process.argv.slice(3).filter((a) => a !== '--table')))); break }
      for (const r of roots(pos)) for (const s of tasks(r)) {
        const d = load(r, s)
        console.log(`${r} · ${s} · PRs: ${d.prs.join(' ') || '-'}`)
        const known = recipes(r)
        for (const e of d.entries) console.log(`   ${e.kind} ${e.id} (${e.when}) → ${plan(e, r, known)}${e.error ? `   KEPT: ${e.error === true ? 'release failed' : e.error}` : ''}`)
      }
      break
    case 'register-root': {
      mkdirSync(HOME_DIR, { recursive: true })
      const list = new Set(roots([]))
      list.add(root)
      writeFileSync(ROOTS, [...list].join('\n') + '\n')
      break
    }
    default:
      console.error('usage: resources.mjs add|drop|prs|taken|end-run|release|reap [--dry-run]|prune [--days N] [--dry-run]|archive|list|register-root …')
      process.exitCode = 2
  }
}
