#!/usr/bin/env node
// task-flow warm worktree pool: one ready worktree per repo (deps installed, env copied), so a new task
// only moves it into place and switches branch instead of creating and installing from scratch.
//
//   fill <root> <key> <repoPath> --base <branch> [--lock <lockfile> --dirs <d1,d2>] [--env .env,.env.local] [--install "<cmd>"]
//       ensure <root>/.worktrees/_pool/<key> exists, detached at origin/<base>, deps cloned from the main
//       checkout (fastdeps); when they cannot be cloned, run --install in the pool. Safe to run in the background after a task run.
//   take <root> <key> <repoPath> <dest> --branch <name> --base <branch> [--lock <lockfile>]
//       move the pool worktree to <dest> and check out <name> (origin/<name> if it exists, else a new branch
//       from origin/<base>, upstream unset). Prints {"taken":true,"path","needsInstall"} or {"taken":false,"reason"}.
//   status <root>
//
// The pool is not a task resource (no resources.json entry); prune never removes `_pool/*` worktrees.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs'
import { execSync, execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SH } from './platform.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe', shell: SH, windowsHide: true, timeout: 900_000 }).toString().trim()
const trySh = (cmd, cwd) => { try { return { ok: true, out: sh(cmd, cwd) } } catch (e) { return { ok: false, out: String(e.stderr || e.message).trim() } } }
const q = JSON.stringify
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0) }
const hash = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : '')
const poolPath = (root, key) => join(resolve(root), '.worktrees', '_pool', key)
const STAMP = '.tf-pool.json'

function parse(argv) {
  const pos = []
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i]
    else pos.push(argv[i])
  }
  return { pos, o }
}

function fill([root, key, repoPath], o) {
  const repo = resolve(repoPath)
  const pool = poolPath(root, key)
  const base = o.base || 'develop'
  trySh('git fetch origin --quiet', repo)
  if (existsSync(pool)) {
    if (trySh('git status --porcelain --untracked-files=no', pool).out) out({ filled: false, reason: 'pool-dirty', pool })
    const r = trySh(`git checkout --quiet --detach origin/${base}`, pool)
    if (!r.ok) out({ filled: false, reason: `checkout failed: ${r.out.split('\n').pop()}` })
  } else {
    const r = trySh(`git worktree add --quiet --detach ${q(pool)} origin/${base}`, repo)
    if (!r.ok) out({ filled: false, reason: `worktree add failed: ${r.out.split('\n').pop()}` })
  }
  for (const f of String(o.env || '.env').split(',').filter(Boolean)) {
    if (existsSync(join(repo, f)) && !existsSync(join(pool, f))) copyFileSync(join(repo, f), join(pool, f))
  }
  let deps = { cloned: false, reason: 'no --lock' }
  if (o.lock && o.dirs) {
    const stamp = existsSync(join(pool, STAMP)) ? JSON.parse(readFileSync(join(pool, STAMP), 'utf8')) : {}
    const now = hash(join(pool, o.lock))
    if (stamp.lock && stamp.lock !== now) for (const d of o.dirs.split(',')) rmSync(join(pool, d), { recursive: true, force: true })
    try { deps = JSON.parse(execFileSync(process.execPath, [join(HERE, 'fastdeps.mjs'), repo, pool, '--lock', o.lock, '--dirs', o.dirs], { stdio: 'pipe', timeout: 900_000 }).toString()) } catch {}
    // fastdeps could not clone (lock differs / main checkout's deps are stale): install in the pool itself —
    // fill runs in the background, so the slow install happens here instead of in the next task's setup.
    if (!deps.cloned && o.install) {
      const r = trySh(o.install, pool)
      deps = r.ok ? { cloned: false, installed: true, reason: deps.reason } : { ...deps, installFailed: r.out.split('\n').pop() }
    }
    if (deps.cloned || deps.installed) writeFileSync(join(pool, STAMP), JSON.stringify({ lock: now, base, at: new Date().toISOString() }))
  }
  out({ filled: true, pool, deps })
}

function take([root, key, repoPath, dest], o) {
  const repo = resolve(repoPath)
  const pool = poolPath(root, key)
  const target = resolve(dest)
  if (!o.branch) out({ taken: false, reason: 'missing --branch' })
  if (existsSync(target)) out({ taken: false, reason: 'dest-exists' })
  if (!existsSync(pool)) out({ taken: false, reason: 'no-pool' })
  if (trySh('git status --porcelain --untracked-files=no', pool).out) out({ taken: false, reason: 'pool-dirty' })
  const mv = trySh(`git worktree move ${q(pool)} ${q(target)}`, repo)
  if (!mv.ok) out({ taken: false, reason: `move failed: ${mv.out.split('\n').pop()}` })
  trySh('git fetch origin --quiet', target)
  const remote = trySh(`git rev-parse --verify --quiet origin/${o.branch}`, target).ok
  const co = remote
    ? trySh(`git checkout --quiet -B ${q(o.branch)} origin/${o.branch}`, target)
    : trySh(`git checkout --quiet -b ${q(o.branch)} origin/${o.base || 'develop'} && git branch --unset-upstream`, target)
  if (!co.ok) out({ taken: true, path: target, needsInstall: true, warning: `checkout: ${co.out.split('\n').pop()}` })
  let needsInstall = false
  if (o.lock) {
    const stamp = existsSync(join(target, STAMP)) ? JSON.parse(readFileSync(join(target, STAMP), 'utf8')) : {}
    needsInstall = !stamp.lock || stamp.lock !== hash(join(target, o.lock))
  }
  trySh(`rm -f ${q(join(target, STAMP))}`)
  out({ taken: true, path: target, branch: o.branch, fromRemote: remote, needsInstall })
}

function status([root]) {
  const wt = join(resolve(root), '.worktrees', '_pool')
  const pools = existsSync(wt) ? readdirSync(wt) : []
  out({ pools: pools.map((n) => {
    const p = join(wt, n)
    const stamp = existsSync(join(p, STAMP)) ? JSON.parse(readFileSync(join(p, STAMP), 'utf8')) : null
    return { key: n, path: p, head: trySh('git rev-parse --short HEAD', p).out, dirty: !!trySh('git status --porcelain --untracked-files=no', p).out, stamp }
  }) })
}

const [cmd, ...rest] = process.argv.slice(2)
const { pos, o } = parse(rest)
if (cmd === 'fill' && pos.length >= 3) fill(pos, o)
else if (cmd === 'take' && pos.length >= 4) take(pos, o)
else if (cmd === 'status' && pos.length >= 1) status(pos)
else { console.error('usage: pool.mjs fill <root> <key> <repoPath> --base B [--lock L --dirs D] | take <root> <key> <repoPath> <dest> --branch N --base B [--lock L] | status <root>'); process.exit(1) }
