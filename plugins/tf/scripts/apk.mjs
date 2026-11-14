#!/usr/bin/env node
// task-flow APK cache: build a Flutter Android APK once per source state, reuse it across tasks/runs.
// Default build is profile + arm64 only (AOT, no debug kernel, no extra ABIs → ~85% smaller than a
// universal debug APK) — enough for UI automation, which drives Semantics identifiers.
//
//   get <worktree> --flavor <f> [--define-file <path>] [--define K=V]… [--mode profile|debug|release]
//       [--target lib/main.dart] [--abi android-arm64] [--flutter <bin>] [--cache-mb 300]
//       [--flutter-args "<extra flags>"] [--log <file>] [--install <serial>] [--adb <bin>]
//     → prints the APK path. Cache key = HEAD tree + uncommitted diff + untracked files + build options,
//       so uncommitted coder changes produce a new build and identical sources reuse the cached one.
//   prune [--cache-mb 300]   trim the cache to the cap (least recently used first)
//   list                      show cached APKs

import { execSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, copyFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { IS_WIN, androidSdk, sdkTool } from './platform.mjs'

const CACHE = join(homedir(), '.cache', 'task-flow', 'apk')
const MB = 1024 * 1024

function keyOf(wt, o) {
  const git = (args) => execFileSync('git', ['-C', wt, ...args], { maxBuffer: 512 * MB })
  const h = createHash('sha256')
  h.update(git(['rev-parse', 'HEAD^{tree}']))
  h.update(git(['diff', 'HEAD', '--binary']))
  for (const f of git(['ls-files', '-o', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean)) {
    h.update(f)
    try { h.update(readFileSync(join(wt, f))) } catch {}
  }
  h.update(JSON.stringify([o.flavor, o.mode, o.abi, o.target, o.defines.sort(), o['flutter-args'] || '']))
  if (o.defineFile) h.update(readFileSync(resolve(wt, o.defineFile)))
  return h.digest('hex').slice(0, 20)
}

function entries() {
  if (!existsSync(CACHE)) return []
  return readdirSync(CACHE).filter((f) => f.endsWith('.apk')).map((f) => {
    const s = statSync(join(CACHE, f))
    return { file: join(CACHE, f), size: s.size, used: s.mtimeMs }
  })
}
export function prune(capMb) {
  const list = entries().sort((a, b) => a.used - b.used)
  let total = list.reduce((n, e) => n + e.size, 0)
  for (const e of list) {
    if (total <= capMb * MB) break
    rmSync(e.file, { force: true })
    total -= e.size
    console.error(`pruned ${e.file}`)
  }
}

export function get(wt, o) {
  mkdirSync(CACHE, { recursive: true })
  const name = `${o.flavor}-${o.mode}-${keyOf(wt, o)}.apk`
  const cached = join(CACHE, name)
  if (existsSync(cached)) {
    const now = new Date()
    utimesSync(cached, now, now)
    console.error(`cache hit ${name}`)
  } else {
    const args = ['build', 'apk', `--${o.mode}`, '--flavor', o.flavor, '--target', o.target, '--target-platform', o.abi]
    if (o.defineFile) args.push(`--dart-define-from-file=${o.defineFile}`)
    for (const d of o.defines) args.push(`--dart-define=${d}`)
    if (o['flutter-args']) args.push(...o['flutter-args'].split(/\s+/).filter(Boolean))
    console.error(`building ${name}: ${o.flutter} ${args.join(' ')}`)
    const log = o.log || join(tmpdir(), `tf-apk-${name}.log`)
    try {
      // On Windows `flutter` is a .bat shim, which only a shell can start.
      const out = execFileSync(o.flutter, args, { cwd: wt, maxBuffer: 256 * MB, stdio: ['ignore', 'pipe', 'pipe'], shell: IS_WIN, windowsHide: true })
      writeFileSync(log, out)
    } catch (e) {
      writeFileSync(log, `${e.stdout || ''}\n${e.stderr || ''}`)
      throw new Error(`flutter build failed — log: ${log}`)
    }
    const built = join(wt, 'build', 'app', 'outputs', 'flutter-apk', `app-${o.flavor}-${o.mode}.apk`)
    if (!existsSync(built)) throw new Error(`build finished but ${built} is missing — log: ${log}`)
    const tmp = `${cached}.tmp-${process.pid}`
    copyFileSync(built, tmp)
    renameSync(tmp, cached) // atomic: a parallel task never sees a half-written APK
    prune(o.cacheMb)
  }
  if (o.install) execFileSync(o.adb, ['-s', o.install, 'install', '-r', cached], { stdio: 'inherit' })
  return cached
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2)
  const o = { defines: [], mode: 'profile', target: 'lib/main.dart', abi: 'android-arm64', cacheMb: 300,
    flutter: process.env.FLUTTER || 'flutter', adb: sdkTool(androidSdk(), 'platform-tools', 'adb') }
  const pos = []
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i]
    if (k === '--define') o.defines.push(rest[++i])
    else if (k === '--define-file') o.defineFile = rest[++i]
    else if (k === '--cache-mb') o.cacheMb = Number(rest[++i])
    else if (k.startsWith('--')) o[k.slice(2)] = rest[++i]
    else pos.push(k)
  }
  if (cmd === 'get') {
    if (!pos[0] || !o.flavor) { console.error('usage: apk.mjs get <worktree> --flavor <f> […]'); process.exit(2) }
    try { console.log(get(resolve(pos[0]), o)) } catch (e) { console.error(e.message); process.exit(1) }
  } else if (cmd === 'prune') prune(o.cacheMb)
  else if (cmd === 'list') for (const e of entries()) console.log(`${(e.size / MB).toFixed(1)} MB  ${e.file}`)
  else { console.error('usage: apk.mjs get|prune|list …'); process.exit(2) }
}
