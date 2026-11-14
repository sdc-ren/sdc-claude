#!/usr/bin/env node
// task-flow emulators: each task boots its OWN Android emulator instance from an existing AVD in
// read-only mode (several instances can run at once, the AVD itself is never written). Emulators
// already running belong to someone else and are never touched.
//
//   start <root> <slug> --avd <name> [--sdk <path>] [--window]   prints the serial, e.g. emulator-5562
//   stop  <root> <slug>                                           kills only this task's emulators
//
// Use the serial everywhere: `adb -s <serial> …`, `maestro --device <serial> test …`.

import { spawn, execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { existsSync, openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { add, drop, load, taken } from './resources.mjs'
import { SH, androidSdk, pidsOnPort, posix, sdkTool } from './platform.mjs'

const sdkPath = androidSdk
const sh = (cmd) => { try { return execSync(cmd, { stdio: 'pipe', shell: SH, windowsHide: true }).toString() } catch { return '' } }
const qp = (p) => `"${posix(p)}"`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort(root, adb) {
  const mine = new Set(taken(root, 'emulator'))
  const running = sh(`${qp(adb)} devices`)
  for (let p = 5560; p <= 5680; p += 2) {
    const serial = `emulator-${p}`
    if (mine.has(serial) || running.includes(serial)) continue
    if (pidsOnPort(p).length || pidsOnPort(p + 1).length) continue
    return p
  }
  throw new Error('no free emulator port in 5560–5680')
}

async function start(root, slug, avd, sdk, windowed) {
  const adb = sdkTool(sdk, 'platform-tools', 'adb')
  const emulator = sdkTool(sdk, 'emulator', 'emulator')
  if (!existsSync(emulator)) throw new Error(`emulator not found under ${sdk}`)
  if (!sh(`${qp(emulator)} -list-avds`).split(/\r?\n/).includes(avd)) throw new Error(`AVD "${avd}" not found`)
  const port = freePort(root, adb)
  const serial = `emulator-${port}`
  add(root, slug, { kind: 'emulator', id: serial, release: `${qp(adb)} -s ${serial} emu kill 2>/dev/null || true`, when: 'run-end' })
  const log = openSync(join(root, '.pipeline', slug, `${serial}.log`), 'a')
  const args = ['-avd', avd, '-port', String(port), '-read-only', '-no-snapshot-save', '-no-boot-anim', '-no-audio']
  if (!windowed) args.push('-no-window')
  spawn(emulator, args, { detached: true, windowsHide: true, stdio: ['ignore', log, log] }).unref()
  for (let i = 0; i < 150; i++) {
    await sleep(2000)
    if (sh(`${qp(adb)} -s ${serial} shell getprop sys.boot_completed`).trim() === '1') return serial
  }
  sh(`${qp(adb)} -s ${serial} emu kill`)
  drop(root, slug, 'emulator', serial)
  throw new Error(`${serial} did not boot within 5 minutes (see .pipeline/${slug}/${serial}.log)`)
}

function stop(root, slug, sdk) {
  const adb = sdkTool(sdk, 'platform-tools', 'adb')
  for (const e of load(root, slug).entries.filter((x) => x.kind === 'emulator')) {
    sh(`${qp(adb)} -s ${e.id} emu kill`)
    drop(root, slug, 'emulator', e.id)
    console.log(`stopped ${e.id}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, root, slug, ...rest] = process.argv.slice(2)
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--window') flags.window = true
    else if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i]
  }
  if (!root || !slug || (cmd === 'start' && !flags.avd)) {
    console.error('usage: emulator.mjs start <root> <slug> --avd <name> [--sdk <path>] [--window] | stop <root> <slug>')
    process.exit(2)
  }
  const sdk = sdkPath(flags.sdk)
  if (cmd === 'start') console.log(await start(resolve(root), slug, flags.avd, sdk, flags.window))
  else stop(resolve(root), slug, sdk)
}
