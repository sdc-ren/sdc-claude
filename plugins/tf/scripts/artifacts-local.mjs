#!/usr/bin/env node
// tf: the Claude artifacts / canvases / design systems that belong to a workspace — found automatically.
//   created here : published from a Claude Code session opened in this workspace (or a sub-folder);
//                  listing or reading an artifact does not count, so other projects never leak in.
//   used here    : attached to an earlier task (<root>/.pipeline/*/attachments.json).
//   pinned       : `Design system:` line in <root>/.claude/task-flow.md (optional).
// Titles come from the publish call (title, or the page's <title>); kind from the Artifact type used.
//
//   node artifacts-local.mjs <workspaceRoot> [--days 365]   → JSON [{ id, url, title, kind, reasons[], last }]
//   node artifacts-local.mjs --titles '<json [{url,title}]>'   remember titles from an account listing
//   import { workspaceArtifacts, rememberTitles } from './artifacts-local.mjs'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { base as baseName, claudeDir, projectDirName, projectMatch, stateDir } from './platform.mjs'

const URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9-]{10,})/g
// Core Artifact type ids (the `type_url` a publish starts from) → kind shown to the user.
const TYPE_KIND = {
  '5M7UeXXcx16TP3vzVFNDzd': 'design system',
  QKN21svewxgyPb6SYRqWnd: 'design',
  Rp9naXUCj2xozpUkyQy19W: 'doc',
  GZLZthZ2sQjn7T16skfdeF: 'data',
  RoVz4QPcPto4DDQBtvX1Jf: 'sheet',
  '8jTsAFQMFDb2oA8MsPJ2eL': 'slides',
  PLsEyfjXbDUM1iasW7rjLR: 'whiteboard',
}
// Per-transcript cache (path → mtime/size + hits) so repeated lists only re-read changed files,
// plus a title cache filled from account listings (artifacts whose publish call had no title).
const STATE = stateDir()
const INDEX = join(STATE, 'artifact-index.json')
const TITLES = join(STATE, 'artifact-titles.json')
const loadJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }
export function rememberTitles(items) {
  const t = loadJson(TITLES, {})
  for (const x of items || []) if (x && x.url && x.title) t[idOf(x.url)] = x.title
  try { mkdirSync(STATE, { recursive: true }); writeFileSync(TITLES, JSON.stringify(t)) } catch {}
}
const idOf = (url) => { const m = String(url).match(/artifact\/([A-Za-z0-9-]{10,})/); return m ? m[1] : '' }

function htmlTitle(file) {
  try {
    if (!file || !existsSync(file)) return ''
    const m = readFileSync(file, 'utf8').slice(0, 20_000).match(/<title>([^<]{1,120})<\/title>/i)
    return m ? m[1].trim() : ''
  } catch { return '' }
}

function jsonl(dir, cutoff) {
  const out = []
  const walk = (d, depth) => {
    if (depth > 4) return
    let names = []
    try { names = readdirSync(d) } catch { return }
    for (const n of names) {
      const p = join(d, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p, depth + 1)
      else if (n.endsWith('.jsonl') && st.mtimeMs >= cutoff) out.push(p)
    }
  }
  walk(dir, 0)
  return out
}

function scanTranscript(f) {
  const hits = []
  const calls = new Map()
  let text
  try { text = readFileSync(f, 'utf8') } catch { return hits }
  for (const line of text.split('\n')) {
    if (!line.includes('Artifact') && !line.includes('tool_result')) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    const content = e && e.message && Array.isArray(e.message.content) ? e.message.content : []
    for (const c of content) {
      if (c.type === 'tool_use' && c.name === 'Artifact') {
        const i = c.input || {}
        if ((i.action || 'publish') !== 'publish' || i.asset) continue
        calls.set(c.id, { title: i.title || htmlTitle(i.file_path), kind: TYPE_KIND[idOf(i.type_url)] || '' })
      } else if (c.type === 'tool_result' && calls.has(c.tool_use_id)) {
        const body = typeof c.content === 'string' ? c.content : JSON.stringify(c.content)
        if (/refused|denied|error/i.test(body.slice(0, 200))) continue
        const m = body.match(URL_RE)
        if (m) hits.push({ url: m[0], ...calls.get(c.tool_use_id), last: e.timestamp || '' })
      }
    }
  }
  return hits
}

export function workspaceArtifacts(rootArg, { days = 365 } = {}) {
  const root = resolve(rootArg)
  const found = new Map()
  const put = (url, patch, reason) => {
    const id = idOf(url)
    if (!id) return
    const cur = found.get(id) || { id, url: `https://claude.ai/artifact/${id}`, title: '', kind: 'page', reasons: [], last: '' }
    if (patch.title && !cur.title) cur.title = patch.title
    if (patch.kind && cur.kind === 'page') cur.kind = patch.kind
    if (patch.last && patch.last > cur.last) cur.last = patch.last
    if (reason && !cur.reasons.includes(reason)) cur.reasons.push(reason)
    found.set(id, cur)
  }

  // 1. Created here — publish calls in this workspace's session transcripts.
  const base = join(claudeDir(), 'projects')
  const dirs = existsSync(base) ? readdirSync(base).filter(projectMatch(projectDirName(root))).map((d) => join(base, d)) : []
  const cutoff = Date.now() - days * 86_400_000
  const index = loadJson(INDEX, {})
  let dirty = false
  for (const f of dirs.flatMap((d) => jsonl(d, cutoff))) {
    let st
    try { st = statSync(f) } catch { continue }
    const key = `${st.mtimeMs}:${st.size}`
    if (!index[f] || index[f].key !== key) { index[f] = { key, hits: scanTranscript(f) }; dirty = true }
    for (const h of index[f].hits) put(h.url, h, 'created here')
  }
  if (dirty) { try { mkdirSync(STATE, { recursive: true }); writeFileSync(INDEX, JSON.stringify(index)) } catch {} }

  // 2. Used here — attached to earlier tasks.
  const pipe = join(root, '.pipeline')
  const scan = (d) => (existsSync(d) ? readdirSync(d).map((n) => join(d, n)) : [])
  for (const t of [...scan(pipe), ...scan(join(pipe, '_archive'))]) {
    const a = join(t, 'attachments.json')
    if (!existsSync(a)) continue
    try {
      for (const x of JSON.parse(readFileSync(a, 'utf8'))) {
        put(x.url, { title: x.title, kind: x.kind === 'design-system' ? 'design system' : x.kind, last: new Date(statSync(a).mtimeMs).toISOString() }, `used in ${baseName(t)}`)
      }
    } catch {}
  }

  // 3. Pinned in the workspace config.
  const cfg = join(root, '.claude', 'task-flow.md')
  if (existsSync(cfg)) {
    const m = readFileSync(cfg, 'utf8').match(/^- Design system:\s*(.*)$/m)
    const u = m && m[1].match(URL_RE)
    if (u) put(u[0], { title: m[1].split('—')[0].trim(), kind: 'design system' }, 'pinned')
  }

  const titles = loadJson(TITLES, {})
  for (const x of found.values()) if (titles[x.id]) x.title = titles[x.id] // account title wins (renames)
  return [...found.values()].sort((a, b) => (a.last < b.last ? 1 : -1))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--titles') { rememberTitles(JSON.parse(process.argv[3] || '[]')); console.log('ok'); process.exit(0) }
  const i = process.argv.indexOf('--days')
  console.log(JSON.stringify(workspaceArtifacts(process.argv[2] || '.', { days: i > 0 ? Number(process.argv[i + 1]) : 365 }), null, 2))
}
