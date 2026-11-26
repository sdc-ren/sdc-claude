// tf runtime — runs the engine for a host without a script runner of its own. A run can take an hour; an
// agent's shell call cannot, so the run is a background process the orchestrator starts once and then waits on
// in short calls:
//
//   <host>/run.mjs start <args.json>           start the run in the background → { run, log }
//   <host>/run.mjs wait <task dir> [--timeout s] print what the run logged since the last wait; when it has
//                                               ended, the result as one line `RESULT {…}` (exit 0)
//   <host>/run.mjs serve <args.json>           the run itself (what `start` launches)
//
// Files, in <task dir>/run/: log.txt (one line per event), result.json (the engine's result), pid.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { PLUGIN_ROOT } from '../core/main.mjs'
import { alive } from '../core/platform.mjs'
import { taskFlow } from '../engine/src/flow.mjs'
import { processRuntime } from './process.mjs'

const runDir = (dir) => join(resolve(dir), 'run')
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadArgs(file) {
  const args = readJson(resolve(file), null)
  if (!args || !args.dir || !args.root) throw new Error(`${file}: the engine's args as JSON, with root and dir`)
  return args
}

export function start(entry, argsFile) {
  const args = loadArgs(argsFile)
  const rd = runDir(args.dir)
  mkdirSync(rd, { recursive: true })
  const pid = Number(readJson(join(rd, 'pid'), 0))
  if (pid && alive(pid) && !existsSync(join(rd, 'result.json'))) throw new Error(`a run of this task is still going (pid ${pid}) — wait on it: ${entry} wait ${args.dir}`)
  for (const f of ['result.json', 'log.txt', 'offset']) rmSync(join(rd, f), { force: true })
  const out = openSync(join(rd, 'log.txt'), 'a')
  const child = spawn(process.execPath, [entry, 'serve', resolve(argsFile)], { cwd: args.root, detached: true, stdio: ['ignore', out, out], windowsHide: true })
  child.unref()
  closeSync(out)
  writeFileSync(join(rd, 'pid'), String(child.pid))
  return { run: rd, log: join(rd, 'log.txt'), pid: child.pid }
}

// New log lines since the last wait, and the result once there is one. Waits up to `timeout` seconds for it.
export async function wait(dir, timeout = 240) {
  const rd = runDir(dir)
  const until = Date.now() + timeout * 1000
  const pid = Number(readJson(join(rd, 'pid'), 0))
  for (;;) {
    const done = existsSync(join(rd, 'result.json'))
    if (done || Date.now() >= until || (pid && !alive(pid))) {
      let text = ''
      try { text = readFileSync(join(rd, 'log.txt'), 'utf8') } catch {}
      const from = Number(readJson(join(rd, 'offset'), 0))
      writeFileSync(join(rd, 'offset'), String(text.length))
      const result = readJson(join(rd, 'result.json'), null)
      const ended = !!result || (pid && !alive(pid))
      return { lines: text.slice(from), result: result || (ended ? { status: 'error', note: 'the run stopped without a result — see the log' } : null) }
    }
    await sleep(2000)
  }
}

export async function serve(argsFile, makeDriver) {
  const args = loadArgs(argsFile)
  const rd = runDir(args.dir)
  const log = (line) => appendFileSync(join(rd, 'log.txt'), `${new Date().toISOString().slice(11, 19)} ${line}\n`)
  let result
  try {
    const rt = processRuntime({ driver: makeDriver({ plugin: PLUGIN_ROOT, root: args.root, log }), root: args.root, plugin: PLUGIN_ROOT, log, concurrency: Number(process.env.TF_JOBS) || 4 })
    result = await taskFlow(args, rt)
  } catch (e) {
    result = { status: 'error', stage: 'runner', note: String((e && e.stack) || e).split('\n').slice(0, 3).join(' · ') }
  }
  writeFileSync(join(rd, 'result.json'), JSON.stringify(result, null, 2))
  log(`run ended: ${result && result.status}`)
}

/** The command line every process host shares (hosts/<agent>/run.mjs). */
export async function runnerCli(entry, makeDriver, argv = process.argv.slice(2)) {
  const [cmd, a, ...rest] = argv
  try {
    if (cmd === 'start') console.log(JSON.stringify(start(entry, a)))
    else if (cmd === 'serve') await serve(a, makeDriver)
    else if (cmd === 'wait') {
      const i = rest.indexOf('--timeout')
      const { lines, result } = await wait(a, i >= 0 ? Number(rest[i + 1]) || 240 : 240)
      if (lines) process.stdout.write(lines)
      console.log(result ? `RESULT ${JSON.stringify(result)}` : 'still running — run wait again')
    } else {
      console.error('usage: run.mjs start <args.json> | wait <task dir> [--timeout s] | serve <args.json>')
      process.exitCode = 2
    }
  } catch (e) {
    console.error(String(e.message || e))
    process.exitCode = 1
  }
}
