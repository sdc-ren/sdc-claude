#!/usr/bin/env node
// task-flow dev servers for one task: start them once per run with the task's own env (ports, DB, cache)
// and keep them up across jobs, so testers and devs never compose start commands by hand.
//
//   start   <root> <slug> [<name>…] [--ports be=3120,fe=3121] [--timeout <sec>]
//       start the named servers (default: every server without "optional": true, in config order).
//       A server already answering on its port from this task's worktree is reused when it runs the code the
//       worktree holds now; otherwise (code changed since it started, or serve.mjs did not start it) it is
//       stopped and started again — status "restarted", with the reason in "stale". Prints JSON per server.
//   run     <root> <slug> --name <n> --server <s> -- <cmd…>
//       an ad-hoc process (e.g. a single job poller) in server <s>'s worktree with <s>'s env; no port.
//   stop    <root> <slug> [<name>…]     stop what serve.mjs started for this task (default: all)
//   stop    <root> <slug> --pid <pid>   stop a listener running from this task's worktree that serve.mjs did not start
//   restart <root> <slug> <name>…
//   status  <root> <slug>
//   list    <root> [--json]             every server of every task of the workspace: the ones serve.mjs started
//       (running or not, on current code or not) and the listeners running from a task's worktree that it did not
//       start (by hand, an earlier run). `stop <root> <slug> <name>` or `stop <root> <slug> --pid <pid>` stops one.
//
// Servers come from the workspace config `<root>/.claude/task-flow.md`, section `## Servers`, first ```json
// block: { "<name>": { "dir": "backend", "port": true, "cmd": "npx nodemon", "env": {…}, "health": "http://localhost:{port}/health",
//          "timeout": 120, "optional": false } }
// Placeholders in cmd/env/health: {port} {port:<server>} {db} {cache} {wt} {root} {slug} {dir}.
// {db}/{cache}/ports come from the task's resources.json (kinds db, cache, port). Ports are assigned to the
// servers with "port": true in config order, in the order the ports were registered, unless --ports says
// otherwise; the mapping is remembered in <task>/servers.json.
// Every started process is its own process group, registered as a `server` resource (run-end), so
// `resources.mjs end-run` stops it. Stop only kills process groups this script recorded, after checking
// their command still runs from this task's worktree. Logs: <task>/logs/<name>.log.
//
// Code version: at launch the worktree's HEAD and a hash of its uncommitted changes are recorded; `start` compares
// them with the worktree now. A server that reloads edits by itself (a watcher in its command or in the npm
// script it runs, or "reload": true) is compared on HEAD and lockfiles only — a dependency or a checkout still
// needs a restart.

import { isMain } from '../../core/main.mjs'
import { configPath } from '../../core/paths.mjs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, openSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, add, drop } from '../resources/resources.mjs'
import { IS_WIN, alive, cwdOf, groupMembers as groupOf, killGroup, killTree, listeners, nodeCmd, parentOf, pidsOnPort as listening, running, spawnShell, tail, under } from '../../core/platform.mjs'

const SELF = fileURLToPath(import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function readServers(root) {
  const f = configPath(root)
  if (!existsSync(f)) throw new Error(`no workspace config ${f}`)
  const txt = readFileSync(f, 'utf8')
  const i = txt.search(/^## Servers\b/m)
  if (i < 0) throw new Error('workspace config has no "## Servers" section')
  const m = txt.slice(i).match(/```json\s*\n([\s\S]*?)```/)
  if (!m) throw new Error('"## Servers" has no ```json block')
  return JSON.parse(m[1])
}

const stateFile = (dir) => join(dir, 'servers.json')
const readState = (dir) => (existsSync(stateFile(dir)) ? JSON.parse(readFileSync(stateFile(dir), 'utf8')) : { ports: {}, procs: {} })
const writeState = (dir, s) => writeFileSync(stateFile(dir), JSON.stringify(s, null, 2) + '\n')

export function assignPorts(defs, portIds, given = {}, remembered = {}) {
  const out = {}
  const used = new Set()
  const want = Object.keys(defs).filter((n) => defs[n].port)
  for (const n of want) {
    const p = given[n] || remembered[n]
    if (p) { out[n] = Number(p); used.add(String(p)) }
  }
  const free = portIds.filter((p) => !used.has(String(p)))
  for (const n of want) if (!out[n] && free.length) out[n] = Number(free.shift())
  return out
}

export function fill(str, vars) {
  return String(str).replace(/\{(port(?::[\w-]+)?|db|cache|wt|root|slug|dir)\}/g, (all, k) => {
    const v = k === 'port' ? vars.port : k.startsWith('port:') ? vars.ports[k.slice(5)] : vars[k]
    if (v === undefined || v === null || v === '') throw new Error(`placeholder ${all} has no value`)
    // The filled string becomes a shell command, and some values come from the task's ledger: a value never
    // brings shell syntax with it.
    if (/[`$;&|<>()'"\n]/.test(String(v))) throw new Error(`placeholder ${all}: its value ${JSON.stringify(String(v))} holds shell characters`)
    return String(v)
  })
}

function context(root, slug) {
  const dir = join(root, '.pipeline', slug)
  const res = load(root, slug)
  const one = (kind) => (res.entries.find((e) => e.kind === kind) || {}).id
  return { dir, db: one('db'), cache: one('cache'), portIds: res.entries.filter((e) => e.kind === 'port').map((e) => e.id) }
}

function varsFor(root, slug, name, def, ctx, ports) {
  const wt = join(root, '.worktrees', slug, def.dir)
  if (!existsSync(wt)) throw new Error(`${name}: worktree ${wt} does not exist — run setup first`)
  return { root, slug, dir: ctx.dir, db: ctx.db, cache: ctx.cache, wt, ports, port: ports[name] }
}

// Does a process listening on our port belong to this task? Its working directory tells (macOS, Linux);
// where the system cannot say (Windows) the server we started for this name must still be alive.
const ownsPort = (pids, wt, proc) => (IS_WIN ? !!(proc && alive(proc.pgid)) : pids.some((p) => under(cwdOf(p), wt)))

const git = (wt, args, input) => {
  try { return execFileSync('git', ['-C', wt, ...args], { input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, timeout: 30_000, windowsHide: true }).toString() } catch { return null }
}
const LOCKS = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|pubspec\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Cargo\.lock|composer\.lock)$/
const WATCH = /\b(nodemon|ts-node-dev|node-dev|tsx\s+watch|vite|next\s+dev|nuxt\s+dev|ng\s+serve|webpack-dev-server|webpack\s+serve|react-scripts\s+start|flutter\s+run)\b|(^|\s)(--watch|-w)(\s|=|$)/

/** Does the server reload edits by itself? "reload" in the config decides; else a watcher in its command, or in
 *  the package.json script the command runs (`npm run x`, `yarn x`, `pnpm x`, `bun run x`). */
export function reloads(def, wt) {
  if (typeof def.reload === 'boolean') return def.reload
  const cmd = String(def.cmd || '')
  if (WATCH.test(cmd)) return true
  const m = cmd.match(/\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)/)
  if (!m || !wt) return false
  try { return WATCH.test(String((JSON.parse(readFileSync(join(wt, 'package.json'), 'utf8')).scripts || {})[m[1] === 'start' && !/\brun\b/.test(cmd) ? 'start' : m[1]] || '')) } catch { return false }
}

/** The code a server started from `wt` runs: `<HEAD>` plus `+<hash>` of the uncommitted changes (names and
 *  contents; lockfiles only when the server reloads edits). '' when `wt` is not a git checkout. */
export function codeVersion(wt, { reload = false } = {}) {
  const head = git(wt, ['rev-parse', 'HEAD'])
  if (head === null) return ''
  const lines = (git(wt, ['status', '--porcelain=v1', '-uall', '-z']) || '').split('\0').filter(Boolean)
  const changed = []
  for (let i = 0; i < lines.length; i++) {
    const [code, file] = [lines[i].slice(0, 2), lines[i].slice(3)]
    if (/R|C/.test(code)) i++ // -z: a rename's old name follows as its own entry
    if (!reload || LOCKS.test(file)) changed.push([code, file])
  }
  if (!changed.length) return head.trim().slice(0, 12)
  const present = changed.filter(([c]) => !c.includes('D')).map(([, f]) => f)
  const contents = present.length ? git(wt, ['hash-object', '--stdin-paths'], `${present.join('\n')}\n`) || '' : ''
  const sum = createHash('sha1').update(changed.map((x) => x.join(' ')).join('\n')).update(contents).digest('hex').slice(0, 10)
  return `${head.trim().slice(0, 12)}+${sum}`
}

// The topmost process of a listener's tree still running from `wt` (a watcher above the server, a shell running
// it), never this process or one of its parents.
function topOf(pid, wt) {
  const self = new Set()
  for (let p = String(process.pid), i = 0; p && p !== '0' && p !== '1' && i < 30; i++, p = parentOf(p)) self.add(p)
  if (self.has(String(pid))) return ''
  let top = String(pid)
  for (let i = 0; i < 8; i++) {
    const up = parentOf(top)
    if (!up || up === '0' || up === '1' || self.has(up) || !under(cwdOf(up), wt)) break
    top = up
  }
  return top
}

// Why a server answering on its port is not the code the worktree holds now ('' when it is).
function staleness(proc, ours, now) {
  if (!ours) return 'not started by serve.mjs: which code it runs is unknown'
  if (proc.version === undefined) return 'started before serve.mjs recorded code versions'
  if (proc.version !== now) return `code changed since it started (${proc.version || 'unknown'} → ${now || 'unknown'})`
  return ''
}

// Stop a stale server holding our port: our own process group, else the tree of each listener that runs from
// this task's worktree. Resolves to whether the port came free.
async function stopStale(port, wt, proc, ours) {
  if (ours) killGroup(proc.pgid)
  else for (const pid of listening(port)) { if (!under(cwdOf(pid), wt)) continue; const top = topOf(pid, wt); if (top) killTree(top) }
  const end = Date.now() + 15_000
  while (Date.now() < end) { if (!listening(port).length) return true; await sleep(300) }
  return false
}

async function healthy(url, ms = 3000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'manual' })
    return r.status < 500
  } catch { return false }
}

function launch(name, cmd, env, cwd, dir) {
  mkdirSync(join(dir, 'logs'), { recursive: true })
  const log = join(dir, 'logs', `${name}.log`)
  const fd = openSync(log, 'a')
  const child = spawnShell(cmd, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd] })
  child.unref()
  return { pid: child.pid, log }
}

function register(root, slug, name) {
  const cmd = nodeCmd(SELF, 'stop', JSON.stringify(root), slug, name)
  add(root, slug, { kind: 'server', id: name, release: cmd, stop: cmd, when: 'run-end' })
}

async function startOne(root, slug, name, def, ctx, state, timeoutSec) {
  const v = varsFor(root, slug, name, def, ctx, state.ports)
  if (def.port && !v.port) throw new Error(`${name}: no port — the task holds ${ctx.portIds.length} port(s); pass --ports ${name}=<port>`)
  const env = Object.fromEntries(Object.entries(def.env || {}).map(([k, x]) => [k, fill(x, v)]))
  const health = def.health ? fill(def.health, v) : ''
  const version = codeVersion(v.wt, { reload: reloads(def, v.wt) })
  let stale = ''
  if (def.port) {
    const pids = listening(v.port)
    if (pids.length) {
      const proc = state.procs[name]
      const mine = ownsPort(pids, v.wt, proc)
      if (!mine) return { name, status: 'error', reason: `port ${v.port} is held by a process outside ${v.wt} — not touched` }
      // Is the listener the process group serve.mjs recorded? (Windows cannot list a group: the leader stands for it.)
      const ours = !!proc && (IS_WIN ? alive(proc.pgid) : groupOf(proc.pgid).some((m) => pids.includes(m.pid)))
      stale = staleness(proc, ours, version)
      if (!stale) {
        if (!health || (await healthy(health))) return { name, status: 'running', port: v.port, health, version, log: proc.log || '' }
        return { name, status: 'error', reason: `port ${v.port} is open but ${health} does not answer — check the log, then \`serve.mjs restart ${name}\``, log: proc.log || '' }
      }
      if (!(await stopStale(v.port, v.wt, proc, ours))) return { name, status: 'error', reason: `stale server on port ${v.port} (${stale}) did not stop — check \`lsof -iTCP:${v.port}\``, stale }
      delete state.procs[name]
      writeState(ctx.dir, state)
    }
  }
  const { pid, log } = launch(name, fill(def.cmd, v), env, v.wt, ctx.dir)
  state.procs[name] = { pgid: pid, wt: v.wt, port: v.port || null, log, started: new Date().toISOString(), version }
  writeState(ctx.dir, state)
  register(root, slug, name)
  const deadline = Date.now() + 1000 * (Number(def.timeout) || timeoutSec)
  while (Date.now() < deadline) {
    if (!groupOf(pid).length) return { name, status: 'error', reason: 'exited during boot', log, tail: tail(log) }
    if (health ? await healthy(health) : def.port ? listening(v.port).length > 0 : true) return { name, status: stale ? 'restarted' : 'started', ...(stale ? { stale } : {}), port: v.port, health, version, log }
    await sleep(1000)
  }
  return { name, status: 'error', reason: `no answer from ${health || `port ${v.port}`} within the timeout (still running, see log)`, log, tail: tail(log) }
}

export function stopOne(root, slug, name) {
  const dir = join(root, '.pipeline', slug)
  const state = readState(dir)
  const p = state.procs[name]
  if (!p) return { name, status: 'not-started' }
  const members = groupOf(p.pgid)
  // Only our own group: its leader must still run from this task's worktree (pid reuse guard).
  const leaderCwd = members.length ? cwdOf(members[0].pid) : ''
  // servers.json is a file of the task folder: the worktree it names must be this task's, and where the
  // system can tell (macOS, Linux) the leader must be seen running from it — unknown is not a yes.
  const mine = under(p.wt, join(root, '.worktrees', slug)) && (IS_WIN || (!!leaderCwd && under(leaderCwd, p.wt)))
  if (members.length && !mine) return { name, status: 'error', reason: `process group ${p.pgid} is not seen running from this task's worktree ${p.wt} — not touched` }
  if (members.length) killGroup(p.pgid)
  delete state.procs[name]
  writeState(dir, state)
  drop(root, slug, 'server', name)
  return { name, status: members.length ? 'stopped' : 'gone' }
}

/** Every server of the workspace's tasks: [{ task, name, recorded, running, pid, ports, current, started, log, cwd, cmd }].
 *  `current`: does it run the worktree's code now (null when unknown or stopped). */
export function listAll(root) {
  const pipe = join(root, '.pipeline')
  const tasks = existsSync(pipe) ? readdirSync(pipe).filter((n) => !/^[._]/.test(n) && existsSync(stateFile(join(pipe, n)))).sort() : []
  let defs = {}
  try { defs = readServers(root) } catch {}
  const ls = listeners()
  const known = new Set()
  const rows = []
  for (const slug of tasks) {
    const state = readState(join(pipe, slug))
    for (const [name, p] of Object.entries(state.procs || {})) {
      const members = groupOf(p.pgid)
      for (const m of members) known.add(m.pid)
      const ports = [...new Set(ls.filter((l) => members.some((m) => m.pid === l.pid)).map((l) => l.port))]
      if (p.port && !ports.includes(p.port) && members.length) ports.unshift(p.port)
      const running = members.length > 0
      const current = running && p.version !== undefined ? codeVersion(p.wt, { reload: reloads(defs[name] || {}, p.wt) }) === p.version : null
      rows.push({ task: slug, name, recorded: true, running, pid: String(p.pgid), ports, current, started: p.started || null, log: p.log || null })
    }
  }
  // Listeners running from a task's worktree that serve.mjs did not start: which code they run is unknown.
  const wts = join(root, '.worktrees')
  const byPid = new Map()
  for (const l of ls) {
    if (known.has(l.pid)) continue
    if (byPid.has(l.pid)) { byPid.get(l.pid).ports.push(l.port); continue }
    const cwd = cwdOf(l.pid)
    if (!under(cwd, wts) || cwd === wts) continue
    byPid.set(l.pid, { task: relative(wts, cwd).split(/[\\/]/)[0], name: '', recorded: false, running: true, pid: l.pid, ports: [l.port], current: null, started: null, log: null, cwd, cmd: l.cmd.slice(0, 120) })
  }
  return [...rows, ...[...byPid.values()].sort((a, b) => a.task.localeCompare(b.task) || a.ports[0] - b.ports[0])]
}

/** Stop a listener serve.mjs did not start: only when it runs from this task's worktree (with the tree above it
 *  that still runs from there — a watcher, a shell). */
export async function stopPid(root, slug, pid) {
  const wt = join(root, '.worktrees', slug)
  if (IS_WIN) return { pid, status: 'error', reason: 'Windows cannot tell which folder a process runs from — stop it yourself' }
  if (!running(pid)) return { pid, status: 'gone' }
  const cwd = cwdOf(pid)
  if (!under(cwd, wt)) return { pid, status: 'error', reason: `process ${pid} runs from ${cwd || 'an unknown folder'}, not from ${wt} — not touched` }
  const top = topOf(pid, cwd)
  if (!top) return { pid, status: 'error', reason: 'that is this process or one of its parents — not touched' }
  killTree(top)
  const end = Date.now() + 10_000
  while (Date.now() < end) { if (!running(pid)) return { pid, status: 'stopped' }; await sleep(200) }
  return { pid, status: 'error', reason: `process ${pid} is still running after SIGTERM` }
}

const ago = (iso) => { if (!iso) return ''; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d` }
export function table(rows) {
  if (!rows.length) return 'No server of a tf task is running or recorded in this workspace.'
  const head = ['#', 'task', 'server', 'port', 'pid', 'state', 'code', 'up', 'started by']
  const body = rows.map((r, i) => [String(i + 1), r.task, r.name || '—', r.ports.join(',') || '—', r.pid, r.running ? 'running' : 'stopped', r.current === true ? 'current' : r.current === false ? 'STALE' : r.running ? '?' : '', ago(r.started), r.recorded ? 'serve.mjs' : `by hand: ${r.cmd || r.cwd}`])
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => (i === head.length - 1 ? 0 : b[i].length))))
  const line = (c) => c.map((x, i) => (i === c.length - 1 ? x : x.padEnd(w[i]))).join('  ')
  return [line(head), ...body.map(line)].join('\n')
}

async function main() {
  const argv = process.argv.slice(2)
  const dash = argv.indexOf('--')
  const tail = dash >= 0 ? argv.slice(dash + 1) : []
  const args = dash >= 0 ? argv.slice(0, dash) : argv
  if (args[0] === 'list' && args[1]) {
    const rows = listAll(resolve(args[1]))
    console.log(args.includes('--json') ? JSON.stringify(rows, null, 2) : table(rows))
    return
  }
  const [cmd, rootArg, slug, ...rest] = args
  const flags = {}
  const names = []
  for (let i = 0; i < rest.length; i++) rest[i].startsWith('--') ? (flags[rest[i].slice(2)] = rest[++i]) : names.push(rest[i])
  if (!cmd || !rootArg || !slug) {
    console.error('usage: serve.mjs start|run|stop|restart|status <root> <slug> … | serve.mjs list <root> [--json]')
    process.exit(2)
  }
  const root = resolve(rootArg)
  const ctx = context(root, slug)
  const state = readState(ctx.dir)
  const print = (x) => console.log(JSON.stringify(x))

  if (cmd === 'stop' && flags.pid) return print(await stopPid(root, slug, String(flags.pid)))
  if (cmd === 'stop') {
    for (const n of names.length ? names : Object.keys(state.procs)) print(stopOne(root, slug, n))
    return
  }
  const defs = readServers(root)
  const given = Object.fromEntries(String(flags.ports || '').split(',').filter(Boolean).map((x) => x.split('=')))
  state.ports = assignPorts(defs, ctx.portIds, given, state.ports)
  writeState(ctx.dir, state)

  if (cmd === 'status') {
    for (const n of Object.keys(defs)) {
      const p = state.procs[n]
      const alive = p && groupOf(p.pgid).length > 0
      const up = defs[n].port && state.ports[n] ? listening(state.ports[n]).length > 0 : alive
      const now = p && up ? codeVersion(p.wt, { reload: reloads(defs[n], p.wt) }) : null
      print({ name: n, port: state.ports[n] || null, running: !!up, started: p ? p.started : null, version: p ? p.version ?? null : null, ...(now !== null ? { current: now === p.version } : {}), log: p ? p.log : null })
    }
    for (const n of Object.keys(state.procs).filter((x) => !defs[x])) print({ name: n, adHoc: true, running: groupOf(state.procs[n].pgid).length > 0, log: state.procs[n].log })
    return
  }
  if (cmd === 'run') {
    const def = defs[flags.server]
    if (!flags.name || !def || !tail.length) throw new Error('run needs --name <n> --server <configured server> -- <cmd…>')
    if (state.procs[flags.name] && groupOf(state.procs[flags.name].pgid).length) return print({ name: flags.name, status: 'running' })
    const v = varsFor(root, slug, flags.server, def, ctx, state.ports)
    const env = Object.fromEntries(Object.entries(def.env || {}).map(([k, x]) => [k, fill(x, v)]))
    const { pid, log } = launch(flags.name, tail.map((a) => (/^[\w./:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' '), env, v.wt, ctx.dir)
    state.procs[flags.name] = { pgid: pid, wt: v.wt, port: null, log, started: new Date().toISOString() }
    writeState(ctx.dir, state)
    register(root, slug, flags.name)
    await sleep(3000)
    return print(groupOf(pid).length ? { name: flags.name, status: 'started', log } : { name: flags.name, status: 'error', reason: 'exited', log, tail: tail(log) })
  }
  if (cmd === 'start' || cmd === 'restart') {
    const list = names.length ? names : Object.keys(defs).filter((n) => !defs[n].optional)
    for (const n of list) if (!defs[n]) throw new Error(`unknown server ${n} (config has: ${Object.keys(defs).join(', ')})`)
    if (cmd === 'restart') for (const n of list) { print(stopOne(root, slug, n)); await sleep(1500) }
    let failed = false
    for (const n of list) {
      const r = await startOne(root, slug, n, defs[n], ctx, readState(ctx.dir), Number(flags.timeout) || 120)
      print(r)
      if (r.status === 'error') failed = true
    }
    process.exitCode = failed ? 1 : 0
    return
  }
  throw new Error(`unknown command ${cmd}`)
}

if (isMain(import.meta.url, 'scripts/serve.mjs')) main().catch((e) => { console.error(String(e.message || e)); process.exit(1) })
