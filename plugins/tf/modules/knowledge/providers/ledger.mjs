// tf knowledge map `ledger` — slices of the hand-kept notes (<knowledge>/pipeline/*.md: findings, decisions,
// env recipes, review lessons …), so an agent reads the lines about its repo and topic instead of whole files.
// The notes stay as they are; the orchestrator is their only writer.
//
// A note file is a Markdown table (columns found by their header, English or Vietnamese) or a list of `- ` lines.
// Topics come from the config (`- Topics: a, b`), else from the repos' domain folder names — never from a list
// built into tf.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const COLUMNS = {
  id: ['id', 'mã'],
  date: ['date', 'ngày', 'when'],
  repo: ['repo', 'repository', 'scope'],
  severity: ['severity', 'mức', 'level', 'priority'],
  summary: ['summary', 'description', 'mô tả', 'finding', 'q', 'question', 'recipe', 'rule', 'lesson', 'title', 'what'],
  answer: ['a', 'answer', 'decision', 'quyết định'],
  status: ['status', 'trạng thái', 'state'],
  source: ['source', 'nguồn', 'task', 'origin'],
}
const KIND = { findings: 'finding', decisions: 'decision', 'env-recipes': 'recipe', recipes: 'recipe', 'review-lessons': 'lesson', lessons: 'lesson' }
const CLOSED = /\b(fixed|done|closed|resolved|merged|accepted|wontfix|won't fix|obsolete|superseded)\b/i

const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
const norm = (h) => h.toLowerCase().replace(/\(.*?\)/g, '').replace(/[*_`]/g, '').trim()
const one = (s, n = 220) => String(s || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, n)
const tsv = (s) => String(s ?? '').replace(/[\t\n\r]+/g, ' ')

function columnsOf(header) {
  const map = {}
  header.map(norm).forEach((h, i) => {
    for (const [k, names] of Object.entries(COLUMNS)) if (map[k] === undefined && names.some((n) => h === n || h.startsWith(`${n} `))) { map[k] = i; break }
  })
  return map
}

/** The entries of one note file: [{ kind, id, date, repoRaw, severity, summary, status, source, line }]. */
export function parseNotes(name, text) {
  const kind = KIND[name] || name
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    // A table: header row, then a |---| row.
    if (/^\s*\|/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const col = columnsOf(cells(l))
      let j = i + 2
      for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
        const c = cells(lines[j])
        const get = (k) => (col[k] !== undefined ? c[col[k]] || '' : '')
        const summary = [get('summary'), get('answer')].filter(Boolean).join(' → ') || c.filter(Boolean).slice(1, 3).join(' · ')
        out.push({ kind, id: get('id'), date: get('date'), repoRaw: get('repo'), severity: get('severity'), summary: one(summary), status: one(get('status'), 80), source: one(get('source'), 120), line: j + 1 })
      }
      i = j - 1
      continue
    }
    // A list entry: `- [tag] [tag] text` (only top-level bullets).
    const m = l.match(/^[-*]\s+(.*)$/)
    if (m) {
      const tags = [...m[1].matchAll(/^\s*\[([^\]]+)\]/g)].map((t) => t[1])
      let rest = m[1], tag = []
      for (let t; (t = rest.match(/^\s*\[([^\]]+)\]\s*/));) { tag.push(t[1]); rest = rest.slice(t[0].length) }
      out.push({ kind, id: '', date: '', repoRaw: tag.join(' '), severity: '', summary: one(rest), status: '', source: '', line: i + 1, tags: tags.length ? tag : [] })
    }
  }
  return out
}

// A repo cell ("be", "backend", "fe, mobile", "BE") → the workspace's repo keys it names.
function reposOf(raw, repos) {
  const words = String(raw || '').toLowerCase().split(/[\s,/+&]+/).filter(Boolean)
  return repos.filter((r) => words.some((w) => w === r.key || w === r.path.replace(/\/+$/, '').split('/').pop().toLowerCase())).map((r) => r.key)
}

// Topics: the config's list, else the domain folder names of the repos. Each is matched as a word (a plural
// "s" either way), case-insensitively.
export function topicsOf(ctx) {
  const fromConfig = String(ctx.knowledge.topics || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
  if (fromConfig.length) return fromConfig
  const names = new Set()
  for (const r of ctx.profile.repos) for (const n of r.domains.names) if (/^[a-z][a-z0-9-]{2,}$/i.test(n)) names.add(n.toLowerCase())
  return [...names].slice(0, 60)
}
const topicRe = (t) => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/s$/, '')}s?([^a-z0-9]|$)`, 'i')

function noteFiles(ctx) {
  try { return readdirSync(ctx.pipelineDir).filter((f) => f.endsWith('.md') && !/archive/i.test(f)).sort() } catch { return [] }
}

export default {
  name: 'ledger',
  answers: 'Known findings still open, decisions already taken, verified env recipes and review lessons — per repo and per topic, with the line to open',
  applies: (ctx) => noteFiles(ctx).length > 0,
  sources(ctx) {
    const out = { topics: createHash('sha1').update(topicsOf(ctx).join(',')).digest('hex').slice(0, 12) }
    for (const f of noteFiles(ctx)) out[f] = createHash('sha1').update(readFileSync(join(ctx.pipelineDir, f))).digest('hex').slice(0, 12)
    return out
  },
  generate(ctx) {
    const topics = topicsOf(ctx)
    const res = topics.map((t) => [t, topicRe(t)])
    const rows = []
    for (const f of noteFiles(ctx)) {
      for (const e of parseNotes(f.slice(0, -3), readFileSync(join(ctx.pipelineDir, f), 'utf8'))) {
        const repos = reposOf(e.repoRaw, ctx.profile.repos)
        const hay = `${e.summary} ${e.repoRaw}`
        rows.push({ ...e, file: f, repos, topics: res.filter(([, re]) => re.test(hay)).map(([t]) => t), open: !e.status || !CLOSED.test(e.status) })
      }
    }
    const rel = ctx.pipelineRel
    const at = (e) => `${rel}/${e.file}:${e.line}`
    const line = (e) => `- ${e.id ? `**${e.id}** ` : ''}${e.kind}${e.severity ? ` · ${e.severity}` : ''}${e.status ? ` · ${e.status}` : ''} — ${e.summary} (\`${at(e)}\`)`
    // Notes with a status are listed while open; notes without one (decisions, recipes, lessons) always.
    const live = rows.filter((e) => e.open)
    const out = {}
    out['ledger/index.tsv'] = `${['kind', 'id', 'date', 'repos', 'topics', 'status', 'summary', 'at'].join('\t')}\n` +
      rows.map((e) => [e.kind, e.id, e.date, e.repos.join(' '), e.topics.join(' '), e.status, e.summary, at(e)].map(tsv).join('\t')).join('\n') + '\n'
    const head = (title) => `# ${title}\n\nGenerated by tf from \`${rel}/\` — do not edit; the notes there are the source. Grep \`ledger/index.tsv\` for anything else.\n\n`
    for (const r of ctx.profile.repos) {
      const mine = live.filter((e) => e.repos.includes(r.key))
      out[`ledger/by-repo/${r.key}.md`] = head(`Notes for ${r.key}`) + (mine.length ? mine.map(line).join('\n') : '_None._') + '\n'
    }
    const loose = live.filter((e) => !e.repos.length)
    if (loose.length) out['ledger/by-repo/_other.md'] = head('Notes not tied to one repo') + loose.map(line).join('\n') + '\n'
    for (const t of topics) {
      const mine = live.filter((e) => e.topics.includes(t))
      if (mine.length) out[`ledger/topics/${t}.md`] = head(`Notes on ${t}`) + mine.map(line).join('\n') + '\n'
    }
    return out
  },
}
