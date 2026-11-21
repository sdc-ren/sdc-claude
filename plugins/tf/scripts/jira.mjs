#!/usr/bin/env node
// tf: Jira through the user's signed-in browser session (browser.mjs auth) — requests run inside the Jira page,
// because Atlassian refuses them from outside. One script instead of a jira-read / jira-post scratch script in
// every task folder.
//
//   node jira.mjs read <taskDir> <KEY> --site https://x.atlassian.net [--auth jira] [--playwright <package.json>]
//        [--out <file.json>] [--md <file.md>]
//     The issue (summary, status, type, priority, people, description, attachments, links) and every comment.
//     Writes the raw JSON (default <taskDir>/tmp/jira-<KEY>.json) and, with --md, a readable markdown copy.
//     --since <commentId> --history <file.md>: comments up to that id (the ones earlier rounds already worked
//     from) go to the history file in full; the markdown keeps one line per earlier comment and every newer
//     one in full — later rounds read what is new, not the whole thread again.
//     Prints one short JSON line: key, status, comment count, last comment id, the files written.
//
//   node jira.mjs comment <taskDir> <KEY> --file <ticket-comment.md> --site … [--auth jira] [--playwright …]
//        [--reply-to <commentId>] [--mention <accountId>=<display name>]… [--expect-last <commentId>] [--confirm]
//     Markdown → Atlassian document (paragraphs, **bold**, [links](url), `- ` lists, `|` tables, `#` headings).
//     Without --confirm: prints what would be posted where, and posts nothing.
//     With --confirm (the orchestrator, after the user approved the exact text — agents are refused by the tool
//     guard): re-reads the comments, stops when one newer than --expect-last exists (QC wrote meanwhile), posts,
//     reads the comment back and prints its id and link.
//     --mention: the first "@<display name>" in the text becomes a real mention of that account.
//     --reply-to: sent as the comment's parentId; `threaded` in the output says whether the site kept it (not
//     every Jira site threads API comments — when false, the comment is a top-level one that quotes nothing).
//
// Nothing here prints a cookie or a token; the URL is built from a checked origin and key, never a shell string.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rootOfTask } from './platform.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,7}$/
const ID = /^\d{1,12}$/

// ── Text ────────────────────────────────────────────────────────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' }
export function htmlText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|pre|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '[image: $1]')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_, h, t) => (t.replace(/<[^>]+>/g, '') === h ? h : `${t.replace(/<[^>]+>/g, '')} (${h})`))
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, e) => ENT[e] ?? (e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : m))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

const inline = (s) => {
  const out = []
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g
  let i = 0, m
  while ((m = re.exec(s))) {
    if (m.index > i) out.push({ type: 'text', text: s.slice(i, m.index) })
    if (m[1]) out.push({ type: 'text', text: m[1], marks: [{ type: 'link', attrs: { href: m[2] } }] })
    else if (m[3]) out.push({ type: 'text', text: m[3], marks: [{ type: 'strong' }] })
    else out.push({ type: 'text', text: m[4], marks: [{ type: 'code' }] })
    i = re.lastIndex
  }
  if (i < s.length) out.push({ type: 'text', text: s.slice(i) })
  return out.length ? out : [{ type: 'text', text: ' ' }]
}
const para = (s) => ({ type: 'paragraph', content: inline(s) })
const cells = (row) => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))

// Markdown (the subset the ticket-comment guideline uses) → Atlassian document format.
export function adf(md, mentions = []) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n')
  const content = []
  for (let k = 0; k < lines.length;) {
    const l = lines[k]
    if (/^\s*\|/.test(l)) {
      const rows = []
      while (k < lines.length && /^\s*\|/.test(lines[k])) rows.push(lines[k++])
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map(cells)
      content.push({ type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' },
        content: body.map((r, ri) => ({ type: 'tableRow', content: r.map((c) => ({ type: ri ? 'tableCell' : 'tableHeader', attrs: {}, content: c.split('<br>').map((x) => para(x.replace(/^[-•]\s+/, '• '))) })) })) })
      continue
    }
    if (/^\s*[-*] /.test(l)) {
      const items = []
      while (k < lines.length && /^\s*[-*] /.test(lines[k])) items.push(lines[k++].replace(/^\s*[-*] /, ''))
      content.push({ type: 'bulletList', content: items.map((x) => ({ type: 'listItem', content: [para(x)] })) })
      continue
    }
    if (/^\s*\d+[.)] /.test(l)) {
      const items = []
      while (k < lines.length && /^\s*\d+[.)] /.test(lines[k])) items.push(lines[k++].replace(/^\s*\d+[.)] /, ''))
      content.push({ type: 'orderedList', attrs: { order: 1 }, content: items.map((x) => ({ type: 'listItem', content: [para(x)] })) })
      continue
    }
    const h = l.match(/^(#{1,6})\s+(.*)$/)
    if (h) content.push({ type: 'heading', attrs: { level: Math.min(h[1].length + 2, 6) }, content: inline(h[2]) })
    else if (l.trim() && !/^<!--.*-->$/.test(l.trim())) content.push(para(l))
    k++
  }
  // "@Display Name" → a real mention, once per --mention.
  for (const m of mentions) {
    const at = `@${m.name}`
    let done = false
    const walk = (nodes) => {
      for (let i = 0; i < nodes.length && !done; i++) {
        const n = nodes[i]
        if (n.type === 'text' && !n.marks && n.text.includes(at)) {
          const [a, ...rest] = n.text.split(at)
          nodes.splice(i, 1, ...(a ? [{ type: 'text', text: a }] : []), { type: 'mention', attrs: { id: m.id, text: at } }, ...(rest.join(at) ? [{ type: 'text', text: rest.join(at) }] : []))
          done = true
        } else if (n.content) walk(n.content)
      }
    }
    walk(content)
    if (!done) throw new Error(`--mention: "${at}" is not in the comment`)
  }
  return { type: 'doc', version: 1, content }
}
const adfText = (n) => {
  if (n.type === 'text') return n.text
  if (n.type === 'mention') return n.attrs.text
  const kids = (n.content || []).map(adfText)
  if (/^(paragraph|heading)$/.test(n.type)) return kids.join('')
  return kids.join(n.type === 'tableRow' ? ' | ' : '\n')
}

export function issueMarkdown(issue, comments, { since = '' } = {}) {
  const f = issue.fields || {}
  const r = issue.renderedFields || {}
  const who = (p) => (p && p.displayName) || '-'
  const out = [`# ${issue.key} — ${f.summary || ''}`, '',
    `Status: ${(f.status || {}).name || '-'} · Type: ${(f.issuetype || {}).name || '-'} · Priority: ${(f.priority || {}).name || '-'} · Assignee: ${who(f.assignee)} · Reporter: ${who(f.reporter)}`,
    ...(f.parent ? [`Parent: ${f.parent.key} — ${(f.parent.fields || {}).summary || ''}`] : []),
    ...((f.issuelinks || []).length ? [`Links: ${f.issuelinks.map((l) => { const o = l.outwardIssue || l.inwardIssue || {}; return `${(l.type || {})[l.outwardIssue ? 'outward' : 'inward'] || ''} ${o.key || ''}`.trim() }).join(' · ')}`] : []),
    '', '## Description', '', htmlText(r.description) || '(empty)']
  if ((f.attachment || []).length) out.push('', '## Attachments', '', ...f.attachment.map((a) => `- ${a.filename} (${a.mimeType}, ${Math.round((a.size || 0) / 1024)} KB, ${a.id})`))
  const head = (c) => `${c.id} · ${who(c.author)} · ${String(c.created || '').slice(0, 16).replace('T', ' ')}${c.parentId ? ` · reply to ${c.parentId}` : ''}`
  const full = (c) => ['', `### ${head(c)}`, '', htmlText(c.renderedBody) || '(empty)']
  // An edited comment counts as new: QC edits their report instead of adding one.
  const old = since ? comments.filter((c) => Number(c.id) <= Number(since) && (!c.updated || c.updated === c.created)) : []
  const fresh = comments.filter((c) => !old.includes(c))
  if (old.length) {
    out.push('', `## Earlier comments (${old.length}, full text in ticket-history.md)`, '',
      ...old.map((c) => `- ${head(c)} — ${htmlText(c.renderedBody).replace(/\s+/g, ' ').slice(0, 110)}`))
  }
  out.push('', `## Comments${old.length ? ' since the last round' : ''} (${fresh.length})`)
  for (const c of fresh) out.push(...full(c), ...(c.updated && c.updated !== c.created ? [`(edited ${String(c.updated).slice(0, 16).replace('T', ' ')})`] : []))
  return out.join('\n') + '\n'
}
// The comments issueMarkdown folds away with the same `since`, verbatim ('' when none).
export function issueHistory(issue, comments, since) {
  const who = (p) => (p && p.displayName) || '-'
  const old = since ? comments.filter((c) => Number(c.id) <= Number(since) && (!c.updated || c.updated === c.created)) : []
  if (!old.length) return ''
  return [`# ${issue.key} — earlier comments (verbatim)`, ...old.flatMap((c) => ['', `### ${c.id} · ${who(c.author)} · ${String(c.created || '').slice(0, 16).replace('T', ' ')}${c.parentId ? ` · reply to ${c.parentId}` : ''}`, '', htmlText(c.renderedBody) || '(empty)'])].join('\n') + '\n'
}

// ── Browser ─────────────────────────────────────────────────────────────────
async function inJira(o, fn) {
  const { openBrowser, closeBrowser } = await import(join(HERE, 'browser.mjs'))
  const b = await openBrowser({ root: o.root, slug: o.slug, playwrightFrom: o.playwright, auth: o.auth })
  try {
    const page = await b.context.newPage()
    await page.goto(`${o.site}/browse/${o.key}`, { waitUntil: 'domcontentloaded' })
    if (!page.url().startsWith(o.site)) throw new Error(`not signed in to ${o.site} — run: node ${join(HERE, 'browser.mjs')} auth ${o.auth} --url ${o.site}`)
    return await fn(page)
  } finally { await closeBrowser(b) }
}
const getComments = (page, key) => page.evaluate(async (key) => {
  const all = []
  for (let at = 0; at < 2000; at += 100) {
    const r = await fetch(`/rest/api/3/issue/${key}/comment?orderBy=created&startAt=${at}&maxResults=100&expand=renderedBody`, { headers: { Accept: 'application/json' } })
    if (!r.ok) return { error: `comments: HTTP ${r.status}` }
    const j = await r.json()
    all.push(...(j.comments || []))
    if (all.length >= (j.total || 0) || !(j.comments || []).length) break
  }
  return { comments: all }
}, key)

// ── CLI ─────────────────────────────────────────────────────────────────────
function args(argv) {
  const o = { mentions: [] }
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--confirm') o.confirm = true
    else if (a === '--mention') { const [id, ...n] = String(argv[++i] || '').split('='); o.mentions.push({ id, name: n.join('=') }) }
    else if (a.startsWith('--')) o[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i]
    else pos.push(a)
  }
  return { o, pos }
}
const die = (msg, code = 2) => { console.error(`jira: ${msg}`); process.exit(code) }

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { o, pos } = args(rest)
  const dir = resolve(pos[0] || '')
  o.key = pos[1]
  if (!['read', 'comment'].includes(cmd) || !pos[0] || !existsSync(dir)) die('usage: jira.mjs read|comment <taskDir> <KEY> --site https://<org>.atlassian.net … (see the header)')
  if (!KEY.test(String(o.key || ''))) die(`not an issue key: ${JSON.stringify(o.key)}`)
  let site
  try { site = new URL(String(o.site || '')) } catch { die('--site must be the Jira origin, e.g. https://acme.atlassian.net') }
  if (site.protocol !== 'https:' || site.pathname !== '/' || site.search || site.username) die('--site must be a plain https origin')
  o.site = site.origin
  o.auth = o.auth || 'jira'
  if (!/^[\w-]{1,40}$/.test(o.auth)) die('--auth must be a saved session name')
  o.root = rootOfTask(dir)
  o.slug = basename(dir)
  if (o.playwright) o.playwright = resolve(o.playwright)
  for (const k of ['replyTo', 'expectLast', 'since']) if (o[k] && !ID.test(o[k])) die(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a comment id`)
  for (const m of o.mentions) if (!/^[\w:-]{6,128}$/.test(m.id) || !m.name) die('--mention takes <accountId>=<display name>')

  if (cmd === 'read') {
    const got = await inJira(o, async (page) => {
      const issue = await page.evaluate(async (key) => {
        const r = await fetch(`/rest/api/3/issue/${key}?expand=renderedFields&fields=summary,status,issuetype,priority,assignee,reporter,description,attachment,issuelinks,subtasks,parent,created,updated,labels`, { headers: { Accept: 'application/json' } })
        return r.ok ? r.json() : { error: `issue: HTTP ${r.status}` }
      }, o.key)
      if (issue.error) return issue
      const c = await getComments(page, o.key)
      return c.error ? c : { issue, comments: c.comments }
    })
    if (got.error) die(got.error, 1)
    const out = resolve(o.out || join(dir, 'tmp', `jira-${o.key}.json`))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(got, null, 1))
    let md = ''
    let history = ''
    if (o.md) {
      md = resolve(o.md)
      mkdirSync(dirname(md), { recursive: true })
      writeFileSync(md, issueMarkdown(got.issue, got.comments, { since: o.since || '' }))
      const h = issueHistory(got.issue, got.comments, o.since || '')
      if (h && o.history) { history = resolve(o.history); writeFileSync(history, h) }
    }
    const last = got.comments[got.comments.length - 1]
    console.log(JSON.stringify({ key: o.key, status: ((got.issue.fields || {}).status || {}).name || '', comments: got.comments.length, lastCommentId: last ? last.id : '', out, ...(md ? { md } : {}), ...(history ? { history } : {}) }))
    return
  }

  if (!o.file || !existsSync(resolve(o.file))) die('comment needs --file <markdown>')
  const doc = adf(readFileSync(resolve(o.file), 'utf8'), o.mentions)
  if (/<evd:[^>]+>/.test(JSON.stringify(doc))) die('the comment still has <evd:FILE> placeholders — upload the evidence and fill the links first')
  const preview = { key: o.key, site: o.site, ...(o.replyTo ? { replyTo: o.replyTo } : {}), blocks: doc.content.length, mentions: o.mentions.map((m) => `@${m.name}`), text: adfText(doc).slice(0, 800) }
  if (!o.confirm) { console.log(JSON.stringify({ dryRun: true, ...preview }, null, 1)); return }
  const res = await inJira(o, async (page) => {
    const c = await getComments(page, o.key)
    if (c.error) return c
    if (o.expectLast) {
      const newer = c.comments.filter((x) => Number(x.id) > Number(o.expectLast))
      if (newer.length) return { stop: `new comments since ${o.expectLast}: ${newer.map((x) => `${x.id} (${(x.author || {}).displayName || '?'})`).join(', ')} — read them, update the draft, show it again` }
    }
    return page.evaluate(async ({ key, body, parentId }) => {
      const r = await fetch(`/rest/api/3/issue/${key}/comment`, { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Atlassian-Token': 'no-check' },
        body: JSON.stringify(parentId ? { body, parentId } : { body }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) return { error: `post: HTTP ${r.status} ${JSON.stringify(j.errorMessages || j.errors || '').slice(0, 300)}` }
      const back = await fetch(`/rest/api/3/issue/${key}/comment/${j.id}`, { headers: { Accept: 'application/json' } })
      const bj = back.ok ? await back.json().catch(() => ({})) : {}
      return { id: j.id, readBack: back.ok, parentId: bj.parentId || j.parentId || '' }
    }, { key: o.key, body: doc, parentId: o.replyTo || undefined })
  })
  if (res.error) die(res.error, 1)
  if (res.stop) die(res.stop, 4)
  console.log(JSON.stringify({ posted: true, key: o.key, id: res.id, readBack: res.readBack, ...(o.replyTo ? { threaded: String(res.parentId) === String(o.replyTo) } : {}), url: `${o.site}/browse/${o.key}?focusedCommentId=${res.id}` }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => die(String(e && e.message || e).split('\n')[0], 1))
