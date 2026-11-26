// tf build — shared content (content/) into a host's files. Content is Markdown with a small front matter and
// a few placeholders; each host says what they become:
//   {{root}}    the plugin folder, as the host lets a prompt name it
//   {{args}}    what the user typed after the command
//   {{config}}  the workspace config file, as the docs name it
//   {{roles}}   the folder of the host's role files (the rendered content/roles/)
//   {{background}} how a long command runs in the background on this host
//   {{fallback}} what a command means on an agent that does not fill the placeholders
//   {{notes}}   the host notes: how the *(host: …)* steps of the docs are done on this host
// Front matter values are kept as written (quotes included), so a host writes them back unchanged.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { PLUGIN_ROOT } from '../core/main.mjs'

/** @returns {{ meta: Record<string, string>, order: string[], body: string }} */
export function parse(text) {
  const t = text.replace(/\r\n/g, '\n')
  const m = t.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) throw new Error('content file without front matter')
  const meta = {}, order = []
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s?(.*)$/)
    if (!kv) throw new Error(`front matter line not "key: value": ${line}`)
    meta[kv[1]] = kv[2]
    order.push(kv[1])
  }
  return { meta, order, body: m[2] }
}

// Every Markdown file of a plugin folder ('content/commands', 'hosts/claude/commands' …) → [{ name, meta, order, body }].
export function load(dir) {
  return readdirSync(join(PLUGIN_ROOT, dir)).filter((f) => f.endsWith('.md')).sort().map((f) => ({ name: f.slice(0, -3), ...parse(readFileSync(join(PLUGIN_ROOT, dir, f), 'utf8')) }))
}

/** Replace {{name}} placeholders; an unknown one is an error, so a typo never reaches a prompt. */
export function fill(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (all, k) => {
    if (!Object.hasOwn(vars, k)) throw new Error(`unknown placeholder ${all}`)
    return vars[k]
  })
}

/** Front matter lines from [key, raw value] pairs (values as written in content/, already filled). */
export const frontMatter = (pairs) => `---\n${pairs.map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`
