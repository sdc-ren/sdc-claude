#!/usr/bin/env node
// The test render of a canvas's screens, in a process of its own.
//
// A canvas is someone else's code: each screen carries a script, and rendering it here runs that script.
// node:vm does not contain it (a script reaches the host's Function through any object it is handed), so the
// boundary is this process: canvas.mjs starts it with Node's permission model (no file writes, no child
// processes, no workers, reads limited to this file and the runtime), an empty environment and a deadline.
// It refuses to run any other way.
//
//   stdin   [{ "file": "admin/Home.dc.html", "sources": { "main": { tpl, logic, props }, … } }, …]
//   stdout  one line per screen, as it finishes: { "file": …, "error": "" | "what failed" }

import { readFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const sandboxed = () => {
  try { return !!process.permission && !process.permission.has('fs.write') && !process.permission.has('child') } catch { return false }
}
if (!sandboxed()) {
  console.error('canvas-smoke.mjs runs a canvas\'s own scripts: start it through canvas.mjs, which sandboxes it')
  process.exit(3)
}

const RUNTIME = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'canvas-runtime.js'), 'utf8')
const SCREEN_MS = 2000

// Render a screen once with a stub React, then press every handler once (click, change…) and render again:
// a screen whose script throws, or a button whose handler throws, shows up here instead of in front of a client.
function smoke(sources) {
  const R = {
    Fragment: 'F',
    Component: class { constructor(p) { this.props = p || {}; this.state = {} } setState(u) { this.state = { ...this.state, ...(typeof u === 'function' ? u(this.state, this.props) : u) } } forceUpdate() {} },
    createElement: (t, p, ...c) => ({ t, p, c }),
  }
  const sandbox = { console: { log() {}, warn() {}, error() {} } }
  vm.createContext(sandbox)
  vm.runInContext(RUNTIME, sandbox, { timeout: SCREEN_MS })
  sandbox.__render = () => {
    const ctx = sandbox.DCRuntime.makeComponents(R, sources, '')
    const C = ctx.components.main
    const inst = new C(sources.main.props || {})
    // A script that does not even parse comes back from the runtime as an error element, not a component.
    if (inst && inst.t === 'pre') throw new Error((inst.c || []).join(''))
    const handlers = []
    const walkEl = (e) => {
      if (!e || typeof e !== 'object') return
      if (typeof e.t === 'function') { const c = new e.t(e.p || {}); walkEl(c.render ? c.render() : null) }
      for (const [k, v] of Object.entries(e.p || {})) if (/^on[A-Z]/.test(k) && typeof v === 'function') handlers.push([k, v])
      ;(e.c || []).forEach(walkEl)
    }
    const check = (tree) => { if (tree && tree.c && tree.c[0] && tree.c[0].t === 'pre') throw new Error(tree.c[0].c.join('')) }
    let tree = inst.render()
    check(tree)
    walkEl(tree)
    const ev = { preventDefault() {}, stopPropagation() {}, target: { value: '', checked: true }, currentTarget: { value: '', checked: true }, key: 'Enter' }
    for (const [k, fn] of handlers.slice(0, 200)) {
      try { fn(ev) } catch (e) { throw new Error(`${k} handler: ${e && e.message}`) }
      tree = inst.render()
      check(tree)
    }
  }
  // The deadline covers everything the screen's script does: a loop that never ends is stopped here.
  vm.runInContext('__render()', sandbox, { timeout: SCREEN_MS })
}

let input = ''
try { input = readFileSync(0, 'utf8') } catch {}
for (const { file, sources } of JSON.parse(input || '[]')) {
  let error = ''
  try { smoke(sources) } catch (e) {
    error = e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? `did not finish within ${SCREEN_MS / 1000} s (a loop that never ends?)` : String((e && e.message) || e).split('\n')[0]
  }
  writeSync(1, JSON.stringify({ file, error }) + '\n')
}
// Everything above ran without the event loop turning once, so nothing a script started in the background
// (a timer, a socket) has made progress; leaving now drops it.
process.exit(0)
