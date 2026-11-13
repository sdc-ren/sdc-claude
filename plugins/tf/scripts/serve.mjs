#!/usr/bin/env node
// task-flow dev servers for one task: start them once per run with the task's own env (ports, DB, cache)
// and keep them up across jobs, so testers and devs never compose start commands by hand.
//
//   start   <root> <slug> [<name>…] [--ports be=3120,fe=3121] [--timeout <sec>]
//       start the named servers (default: every server without "optional": true, in config order).
//       A server already answering on its port from this task's worktree is reused. Prints JSON per server.
//   run     <root> <slug> --name <n> --server <s> -- <cmd…>
//       an ad-hoc process (e.g. a single job poller) in server <s>'s worktree with <s>'s env; no port.
//   stop    <root> <slug> [<name>…]     stop what serve.mjs started for this task (default: all)
//   restart <root> <slug> <name>…
//   status  <root> <slug>
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

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, add, drop } from './resources.mjs'

const SELF = fileURLToPath(import.meta.url)
const sh = (cmd) => { try { return execSync(cmd, { stdio: 'pipe', shell: '/bin/sh' }).toString().trim() } catch { return '' } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function readServers(root) {
  const f = join(root, '.claude', 'task-flow.md')
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

const listening = (port) => sh(`lsof -t -nP -iTCP:${port} -sTCP:LISTEN`).split('\n').filter(Boolean)
const cwdOf = (pid) => (sh(`lsof -a -p ${pid} -d cwd -Fn`).split('\n').find((l) => l.startsWith('n')) || '').slice(1)
const groupOf = (pgid) =>
  sh('ps -A -o pid=,pgid=,command=')
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m && m[2] === String(pgid))
    .map((m) => ({ pid: m[1], cmd: m[3] }))

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
  const child = spawn('/bin/sh', ['-c', cmd], { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', fd, fd] })
  child.unref()
  return { pid: child.pid, log }
}

function register(root, slug, name) {
  const cmd = `node ${JSON.stringify(SELF)} stop ${JSON.stringify(root)} ${slug} ${name}`
  add(root, slug, { kind: 'server', id: name, release: cmd, stop: cmd, when: 'run-end' })
}

async function startOne(root, slug, name, def, ctx, state, timeoutSec) {
  const v = varsFor(root, slug, name, def, ctx, state.ports)
  if (def.port && !v.port) throw new Error(`${name}: no port — the task holds ${ctx.portIds.length} port(s); pass --ports ${name}=<port>`)
  const env = Object.fromEntries(Object.entries(def.env || {}).map(([k, x]) => [k, fill(x, v)]))
  const health = def.health ? fill(def.health, v) : ''
  if (def.port) {
    const pids = listening(v.port)
    if (pids.length) {
      const mine = pids.some((p) => cwdOf(p).startsWith(v.wt))
      if (!mine) return { name, status: 'error', reason: `port ${v.port} is held by a process outside ${v.wt} — not touched` }
      if (!health || (await healthy(health))) return { name, status: 'running', port: v.port, health, log: (state.procs[name] || {}).log || '' }
      return { name, status: 'error', reason: `port ${v.port} is open but ${health} does not answer — check the log, then \`serve.mjs restart ${name}\``, log: (state.procs[name] || {}).log || '' }
    }
  }
  const { pid, log } = launch(name, fill(def.cmd, v), env, v.wt, ctx.dir)
  state.procs[name] = { pgid: pid, wt: v.wt, port: v.port || null, log, started: new Date().toISOString() }
  writeState(ctx.dir, state)
  register(root, slug, name)
  const deadline = Date.now() + 1000 * (Number(def.timeout) || timeoutSec)
  while (Date.now() < deadline) {
    if (!groupOf(pid).length) return { name, status: 'error', reason: 'exited during boot', log, tail: sh(`tail -n 30 ${JSON.stringify(log)}`) }
    if (health ? await healthy(health) : def.port ? listening(v.port).length > 0 : true) return { name, status: 'started', port: v.port, health, log }
    await sleep(1000)
  }
  return { name, status: 'error', reason: `no answer from ${health || `port ${v.port}`} within the timeout (still running, see log)`, log, tail: sh(`tail -n 30 ${JSON.stringify(log)}`) }
}

export function stopOne(root, slug, name) {
  const dir = join(root, '.pipeline', slug)
  const state = readState(dir)
  const p = state.procs[name]
  if (!p) return { name, status: 'not-started' }
  const members = groupOf(p.pgid)
  // Only our own group: its leader must still run from this task's worktree (pid reuse guard).
  const leaderCwd = members.length ? cwdOf(members[0].pid) : ''
  if (members.length && leaderCwd && !leaderCwd.startsWith(p.wt)) return { name, status: 'error', reason: `process group ${p.pgid} no longer runs from ${p.wt} — not touched` }
  if (members.length) sh(`kill -TERM -${p.pgid}`)
  delete state.procs[name]
  writeState(dir, state)
  drop(root, slug, 'server', name)
  return { name, status: members.length ? 'stopped' : 'gone' }
}

async function main() {
  const argv = process.argv.slice(2)
  const dash = argv.indexOf('--')
  const tail = dash >= 0 ? argv.slice(dash + 1) : []
  const args = dash >= 0 ? argv.slice(0, dash) : argv
  const [cmd, rootArg, slug, ...rest] = args
  const flags = {}
  const names = []
  for (let i = 0; i < rest.length; i++) rest[i].startsWith('--') ? (flags[rest[i].slice(2)] = rest[++i]) : names.push(rest[i])
  if (!cmd || !rootArg || !slug) {
    console.error('usage: serve.mjs start|run|stop|restart|status <root> <slug> …')
    process.exit(2)
  }
  const root = resolve(rootArg)
  const ctx = context(root, slug)
  const state = readState(ctx.dir)
  const print = (x) => console.log(JSON.stringify(x))

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
      print({ name: n, port: state.ports[n] || null, running: !!up, started: p ? p.started : null, log: p ? p.log : null })
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
    return print(groupOf(pid).length ? { name: flags.name, status: 'started', log } : { name: flags.name, status: 'error', reason: 'exited', log, tail: sh(`tail -n 30 ${JSON.stringify(log)}`) })
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

if (process.argv[1] && resolve(process.argv[1]) === SELF) main().catch((e) => { console.error(String(e.message || e)); process.exit(1) })
