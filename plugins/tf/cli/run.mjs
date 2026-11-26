// tf — runs `tf <command> [args…]`: finds the module of <command> and runs its own command line in this
// process, as if node had been started on that file (process.argv[1] is the module, the args follow).
//
//   tf                     the list of commands
//   tf help | --help       the same
//   tf --version           the plugin version
//   tf <command> [args…]   run it; its exit code is tf's exit code
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PLUGIN_ROOT } from '../core/main.mjs'

const PLUGIN_MANIFESTS = ['.claude-plugin/plugin.json', 'plugin.json']

export function version() {
  for (const m of PLUGIN_MANIFESTS) {
    try { return JSON.parse(readFileSync(join(PLUGIN_ROOT, m), 'utf8')).version || '' } catch {}
  }
  return ''
}

// The first comment line of a module, without the `tf:`-style prefix.
function summary(file) {
  try {
    const line = readFileSync(join(PLUGIN_ROOT, file), 'utf8').split(/\r?\n/).find((l) => l.startsWith('// ')) || ''
    return line.slice(3).replace(/^(?:SDC )?(?:tf|task-flow)(?: core)?(?:\s*[—:-])?\s+/i, '').slice(0, 100)
  } catch { return '' }
}

export function usage(commands) {
  const w = Math.max(...Object.keys(commands).map((n) => n.length))
  return [`tf ${version()} — usage: tf <command> [args…]`, '', ...Object.entries(commands).map(([n, f]) => `  ${n.padEnd(w)}  ${summary(f)}`), ''].join('\n')
}

/**
 * @param {string[]} argv the arguments after `tf`
 * @param {Record<string, string>} commands name → plugin-relative module path
 */
export async function run(argv, commands) {
  const [cmd, ...args] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { process.stdout.write(usage(commands)); return }
  if (cmd === '--version' || cmd === '-v') { console.log(version()); return }
  const rel = Object.hasOwn(commands, cmd) ? commands[cmd] : ''
  const file = rel && join(PLUGIN_ROOT, rel)
  if (!file || !existsSync(file)) {
    console.error(`tf: no command "${cmd}" — run tf help for the list`)
    process.exitCode = 2
    return
  }
  process.argv = [process.argv[0], file, ...args]
  await import(pathToFileURL(file).href)
}
