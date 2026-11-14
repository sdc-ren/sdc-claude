#!/usr/bin/env node
// task-flow fast dependency provisioning for a fresh worktree: reuse the main checkout's installed
// dependencies instead of reinstalling, when the lockfile is identical.
//
//   node fastdeps.mjs <mainRepo> <worktree> --lock <lockfile> --dirs <dir>[,<dir>…]
//     e.g. --lock package-lock.json --dirs node_modules
//          --lock pubspec.lock --dirs .dart_tool,lib/core/generated
//
// Each dir is copied the cheapest way the file system has (platform.mjs cloneDir: an APFS clone on macOS —
// near-instant, copy-on-write — a reflink on Linux btrfs/xfs, else a plain copy), so the worktree gets
// its own copy and never writes into the main checkout). Prints JSON:
//   {"cloned":true,"dirs":[…]}                         lockfiles identical, dirs cloned
//   {"cloned":false,"reason":"lock-differs|no-lock|stale-deps|missing-dir|clone-failed"}  → caller installs normally
//   (stale-deps: same lockfile, but the main checkout's node_modules misses a direct dependency or holds
//   another version than the lock — its owner pulled without installing; "stale" lists the first ones)
// Never deletes anything in the main checkout. Skips a dir that already exists in the worktree.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { cloneDir } from './platform.mjs'

const [main, wt, ...rest] = process.argv.slice(2)
const opt = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined }
const lock = opt('lock')
const dirs = String(opt('dirs') || '').split(',').filter(Boolean)
const done = (o) => { console.log(JSON.stringify(o)); process.exit(0) }
if (!main || !wt || !lock || !dirs.length) {
  console.error('usage: fastdeps.mjs <mainRepo> <worktree> --lock <lockfile> --dirs <d1,d2>')
  process.exit(1)
}
const M = resolve(main)
const W = resolve(wt)
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
export function staleDeps(mainDir, wtDir, lockName) {
  const pkg = readJson(join(wtDir, 'package.json'))
  if (!pkg) return []
  const npmLock = lockName === 'package-lock.json' ? readJson(join(wtDir, lockName)) : null
  const names = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })
  const out = []
  for (const n of names) {
    const installed = readJson(join(mainDir, 'node_modules', n, 'package.json'))
    if (!installed) { out.push(`${n} missing`); continue }
    const locked = npmLock && npmLock.packages && npmLock.packages[`node_modules/${n}`]
    if (locked && locked.version && installed.version !== locked.version) out.push(`${n} ${installed.version} ≠ ${locked.version}`)
  }
  return out
}
if (!existsSync(join(M, lock)) || !existsSync(join(W, lock))) done({ cloned: false, reason: 'no-lock' })
if (hash(join(M, lock)) !== hash(join(W, lock))) done({ cloned: false, reason: 'lock-differs' })
// Same lockfile is not enough: the main checkout may have pulled a new lockfile without reinstalling
// (RVD-293: develop added pdfkit, main node_modules lacked it). Check every direct dependency is installed,
// at the locked version when the lockfile is npm's.
if (dirs.includes('node_modules')) {
  const stale = staleDeps(M, W, lock)
  if (stale.length) done({ cloned: false, reason: 'stale-deps', stale: stale.slice(0, 10) })
}
const cloned = []
for (const d of dirs) {
  const src = join(M, d)
  const dst = join(W, d)
  if (existsSync(dst)) { cloned.push(`${d} (exists)`); continue }
  if (!existsSync(src)) done({ cloned: false, reason: 'missing-dir', dir: d })
  mkdirSync(dirname(dst), { recursive: true })
  try { cloneDir(src, dst) } catch { done({ cloned: false, reason: 'clone-failed', dir: d }) }
  cloned.push(d)
}
done({ cloned: true, dirs: cloned })
