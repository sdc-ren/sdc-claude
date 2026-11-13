#!/usr/bin/env node
// task-flow fast dependency provisioning for a fresh worktree: reuse the main checkout's installed
// dependencies instead of reinstalling, when the lockfile is identical.
//
//   node fastdeps.mjs <mainRepo> <worktree> --lock <lockfile> --dirs <dir>[,<dir>…]
//     e.g. --lock package-lock.json --dirs node_modules
//          --lock pubspec.lock --dirs .dart_tool,lib/core/generated
//
// Each dir is copied with `cp -cR` (APFS clonefile: near-instant, copy-on-write, so the worktree gets
// its own copy and never writes into the main checkout). Prints JSON:
//   {"cloned":true,"dirs":[…]}                         lockfiles identical, dirs cloned
//   {"cloned":false,"reason":"lock-differs|no-lock|missing-dir|clone-failed"}  → caller installs normally
// Never deletes anything in the main checkout. Skips a dir that already exists in the worktree.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

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
if (!existsSync(join(M, lock)) || !existsSync(join(W, lock))) done({ cloned: false, reason: 'no-lock' })
if (hash(join(M, lock)) !== hash(join(W, lock))) done({ cloned: false, reason: 'lock-differs' })
const cloned = []
for (const d of dirs) {
  const src = join(M, d)
  const dst = join(W, d)
  if (existsSync(dst)) { cloned.push(`${d} (exists)`); continue }
  if (!existsSync(src)) done({ cloned: false, reason: 'missing-dir', dir: d })
  mkdirSync(dirname(dst), { recursive: true })
  try {
    execFileSync('cp', ['-cR', src, dst], { stdio: 'pipe', timeout: 600_000 })
  } catch {
    try { execFileSync('cp', ['-R', src, dst], { stdio: 'pipe', timeout: 900_000 }) } catch { done({ cloned: false, reason: 'clone-failed', dir: d }) }
  }
  cloned.push(d)
}
done({ cloned: true, dirs: cloned })
