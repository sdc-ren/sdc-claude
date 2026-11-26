// tf build — the engine as one self-contained script, for a host whose script runner takes a single file that
// starts with `export const meta = {…}` and gets the runtime as globals (args, agent, parallel, phase, log,
// budget). The ES modules in engine/src/ are the source; this only concatenates them.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PLUGIN_ROOT } from '../core/main.mjs'

const read = (f) => readFileSync(join(PLUGIN_ROOT, 'engine', 'src', f), 'utf8').replace(/\r\n/g, '\n')
// Drop the import lines and the `export` keyword: in one script every name is already in scope.
const unmodule = (s) => s.replace(/^import [^\n]*\n/gm, '').replace(/^export (?=(?:async )?(?:const|function|let|class) )/gm, '')
// A file's own leading comment block (its description), which the bundle replaces with its own.
const body = (s) => s.replace(/^(?:\/\/[^\n]*\n)+/, '').replace(/^\n+/, '').replace(/\n+$/, '\n')

/**
 * @param {string} banner comment lines that open the bundle (what generated it, how to rebuild)
 * @returns {string}
 */
export function bundleEngine(banner) {
  const flow = read('flow.mjs')
  const header = flow.slice(0, flow.search(/^import /m)).replace(/\n+$/, '\n')
  const meta = body(read('meta.mjs'))
  if (!/^export const meta = \{/.test(meta)) throw new Error('engine/src/meta.mjs must start with export const meta = {…}')
  // meta right after the banner: a runner that reads it statically finds it at the top, as before the split.
  return [
    banner.replace(/\n+$/, ''),
    meta.replace(/\n+$/, ''),
    '',
    header.replace(/\n+$/, ''),
    '',
    unmodule(body(read('limits.mjs'))).replace(/\n+$/, ''),
    '',
    unmodule(body(read('schemas.mjs'))).replace(/^\n+/, '').replace(/\n+$/, ''),
    '',
    unmodule(flow.slice(flow.search(/^export async function taskFlow/m))).replace(/\n+$/, ''),
    '',
    'return await taskFlow(args, { agent, parallel, phase, log, budget })',
    '',
  ].join('\n')
}
