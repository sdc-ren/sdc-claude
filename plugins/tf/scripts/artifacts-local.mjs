#!/usr/bin/env node
// tf: which Claude artifacts were CREATED (published) from this workspace — no setup needed.
// Claude Code stores each workspace's session transcripts in ~/.claude/projects/<encoded path>/.
// An artifact belongs to the workspace whose sessions published it (Artifact publish / create from a type).
// Merely listing or reading an artifact does not count, so a listing in one workspace never leaks others.
//
//   node artifacts-local.mjs <workspaceRoot> [--days 365]
//   → JSON [{ url, title?, lastPublished }] newest first
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] || '.')
const days = Number((process.argv.find((a, i) => process.argv[i - 1] === '--days')) || 365)
const enc = root.replace(/[^A-Za-z0-9]/g, '-')
const base = join(homedir(), '.claude', 'projects')
// The workspace itself and sub-folders opened as their own sessions (e.g. <root>/packflow).
const dirs = existsSync(base) ? readdirSync(base).filter((d) => d === enc || d.startsWith(`${enc}-`)).map((d) => join(base, d)) : []
const URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]{10,}/g
const cutoff = Date.now() - days * 86_400_000
const found = new Map()

function files(dir) {
  const out = []
  const walk = (d, depth) => {
    if (depth > 4) return
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      const st = statSync(p)
      if (st.isDirectory()) walk(p, depth + 1)
      else if (n.endsWith('.jsonl') && st.mtimeMs >= cutoff) out.push(p)
    }
  }
  try { walk(dir, 0) } catch {}
  return out
}

for (const f of dirs.flatMap(files)) {
  const publishIds = new Map() // tool_use id → { title }
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('Artifact') && !line.includes('tool_result')) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    const content = e && e.message && Array.isArray(e.message.content) ? e.message.content : []
    for (const c of content) {
      if (c.type === 'tool_use' && c.name === 'Artifact') {
        const a = (c.input && c.input.action) || 'publish'
        if (a === 'publish' && !(c.input && c.input.asset)) publishIds.set(c.id, { title: c.input.title || '' })
      } else if (c.type === 'tool_result' && publishIds.has(c.tool_use_id)) {
        const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content)
        const urls = text.match(URL_RE) || []
        if (!urls.length || /refused|error/i.test(text.slice(0, 200))) continue
        const url = urls[0]
        const when = e.timestamp || new Date(statSync(f).mtimeMs).toISOString()
        const prev = found.get(url)
        if (!prev || prev.lastPublished < when) found.set(url, { url, title: publishIds.get(c.tool_use_id).title || (prev && prev.title) || '', lastPublished: when })
      }
    }
  }
}
console.log(JSON.stringify([...found.values()].sort((a, b) => (a.lastPublished < b.lastPublished ? 1 : -1)), null, 2))
