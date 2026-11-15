#!/usr/bin/env node
// tf: what the user gave a /tf:* command — split into the request (their own words) and the sources it points at.
// A task is not tied to one tracker: any link works, and plain words with no link are a task of their own.
//
//   node sources.mjs <root> "<input>"
//     → { request, key, sources: [{ kind, ref, key?, host?, read }], hasTracker }
//   kind: tracker (issue key or tracker link) · pr · issue (GitHub issue) · artifact (claude.ai artifact, canvas,
//         design system) · figma · doc (Notion, Google Docs, Confluence…) · url (any other web page) · file (a local path)
//   `read` says how the orchestrator reads it (docs/orchestrator.md "Sources"). Hosts listed in the workspace
//   config `## Sources` win: their line says how to read them and whether they are a tracker.
//   import { classify, keyFrom, strictKey, configSources } from './sources.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const KEY_RE = /\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})\b/
// Things that look like an issue key in plain words but never are one.
const NOT_KEYS = new Set(['UTF', 'ISO', 'SHA', 'MD', 'RFC', 'HTTP', 'HTTPS', 'TLS', 'SSL', 'IPV', 'COVID', 'ES', 'ECMA',
  'WCAG', 'AES', 'RSA', 'CVE', 'GPT', 'PEP', 'ID', 'UI', 'UX', 'API', 'OS', 'IP', 'QR', 'KB', 'MB', 'GB', 'TB', 'PM', 'AM',
  'MP', 'H', 'X', 'BASE', 'WIN', 'MAC', 'IOS', 'ANDROID', 'NODE', 'ES2015', 'CP', 'ISO8601', 'TOP', 'STEP', 'LEVEL', 'TCVN'])
const FILE_EXT = new Set(['mjs', 'js', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'md', 'txt', 'yml', 'yaml', 'sh', 'py', 'html', 'css', 'png', 'jpg', 'pdf', 'lock', 'toml', 'env', 'dart', 'kt', 'swift', 'gradle', 'xml'])
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi

// Any key-shaped token (PR titles, branch and folder names written by tf itself).
export function keyFrom(text) {
  const m = String(text || '').match(KEY_RE)
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null
}
// A key in the user's own words: written in capitals (PROJ-12), not a known false friend (UTF-8, ISO-9001),
// or a prefix the workspace config lists. A bare lowercase key on its own (`proj-301`) is still a key.
export function strictKey(text, prefixes = []) {
  const s = String(text || '').trim()
  const allow = new Set(prefixes.map((p) => p.toUpperCase()))
  if (/^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,6}$/.test(s)) { const k = keyFrom(s); return NOT_KEYS.has(k.split('-')[0]) && !allow.has(k.split('-')[0]) ? null : k }
  for (const m of s.matchAll(new RegExp(KEY_RE.source, 'g'))) {
    const p = m[1].toUpperCase()
    if (allow.has(p)) return `${p}-${m[2]}`
    if (m[1] === p && /[A-Z]/.test(p) && !NOT_KEYS.has(p)) return `${p}-${m[2]}`
  }
  return null
}

// `## Sources` (or the older `## Tracker and spec sources`) of <root>/.claude/task-flow.md:
//   - <name>: <url or host> — <kind: tracker|docs|design|spec> — <how to read> [— keys: PROJ, OPS]
export function configSources(root) {
  const f = join(resolve(root || '.'), '.claude', 'task-flow.md')
  const out = { hosts: [], keys: [] }
  if (!existsSync(f)) return out
  const txt = readFileSync(f, 'utf8')
  const sec = txt.match(/^##\s+(?:Sources|Tracker and spec sources)\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m)
  if (!sec) return out
  for (const line of sec[1].split('\n')) {
    if (!/^\s*[-*]/.test(line)) continue
    const hosts = [...line.matchAll(/https?:\/\/([^\s/`>)]+)/g)].map((m) => m[1].toLowerCase())
    for (const m of line.matchAll(/(?:^|[\s(`])((?:[a-z0-9-]+\.)+([a-z]{2,}))(?=[\s/`),]|$)/gi)) {
      if (FILE_EXT.has(m[2].toLowerCase()) || hosts.includes(m[1].toLowerCase())) continue // browser.mjs is a file, not a host
      hosts.push(m[1].toLowerCase())
    }
    const tracker = /\b(tracker|ticket|jira|linear|youtrack|redmine|clickup|asana|trello|shortcut|azure devops|issue)/i.test(line)
    const km = line.match(/\bkeys?\s*:?\s*([A-Z][A-Z0-9]{1,9}(?:\s*,\s*[A-Z][A-Z0-9]{1,9})*)/)
    if (km) out.keys.push(...km[1].split(/\s*,\s*/))
    for (const h of hosts) out.hosts.push({ host: h, tracker, line: line.replace(/^\s*[-*]\s*/, '').trim() })
  }
  return out
}

const DOC_HOSTS = /(^|\.)(notion\.so|notion\.site|docs\.google\.com|drive\.google\.com|confluence\.|atlassian\.net\/wiki|coda\.io|quip\.com|dropbox\.com\/paper|sharepoint\.com|onedrive\.live\.com|gitbook\.io|craft\.do|larksuite\.com|feishu\.cn)/i
const TRACKER_URL = [
  /\/browse\/([A-Z][A-Z0-9]{1,9}-\d+)/i, // Jira
  /[?&](?:selectedIssue|issueKey)=([A-Z][A-Z0-9]{1,9}-\d+)/i,
  /linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]{1,9}-\d+)/i,
  /\/issue\/([A-Z][A-Z0-9]{1,9}-\d+)/i, // YouTrack and others
  /\/issues\/([A-Z][A-Z0-9]{1,9}-\d+)/i,
]

function classifyUrl(url, cfg) {
  let u
  try { u = new URL(url) } catch { return { kind: 'url', ref: url, read: 'fetch the page' } }
  const host = u.hostname.toLowerCase()
  const conf = cfg.hosts.find((h) => host === h.host || host.endsWith(`.${h.host}`) || `${host}${u.pathname}`.startsWith(h.host))
  const base = { ref: url, host }
  let m
  if (/^(?:www\.)?claude\.(?:ai|com)$/.test(host.replace(/^preview\./, '')) && (m = u.pathname.match(/\/(?:code\/)?artifact\/([A-Za-z0-9-]{10,})/))) {
    return { ...base, kind: 'artifact', id: m[1], read: 'Artifact read — a Design canvas, a design system or a page (docs/attach.md)' }
  }
  if (host === 'github.com' && (m = u.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/))) return { ...base, kind: 'pr', key: null, read: `gh pr view ${m[3]} --repo ${m[1]}/${m[2]}` }
  if (host === 'github.com' && (m = u.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/))) {
    return { ...base, kind: 'issue', key: `GH-${m[2].replace(/[^\w-]/g, '').toUpperCase()}-${m[3]}`, read: `gh issue view ${m[3]} --repo ${m[1]}/${m[2]} --comments` }
  }
  for (const re of TRACKER_URL) if ((m = url.match(re))) return { ...base, kind: 'tracker', key: m[1].toUpperCase(), read: conf ? conf.line : 'the tracker recipe in the config (browser.mjs)' }
  if (conf && conf.tracker) return { ...base, kind: 'tracker', key: keyFrom(u.pathname + u.search), read: conf.line }
  if (/(^|\.)figma\.com$/.test(host)) return { ...base, kind: 'figma', read: conf ? conf.line : 'Figma MCP when connected, else browser.mjs' }
  if (DOC_HOSTS.test(`${host}${u.pathname}`)) return { ...base, kind: 'doc', read: conf ? conf.line : 'a connector for that service when connected, else fetch (public) or browser.mjs (sign-in)' }
  return { ...base, kind: 'url', read: conf ? conf.line : 'fetch (public) or browser.mjs (sign-in)' }
}

export function classify(root, input) {
  const cfg = configSources(root)
  let rest = String(input || '')
  const sources = []
  for (const m of rest.matchAll(URL_RE)) sources.push(classifyUrl(m[0].replace(/[.,;:!?]+$/, ''), cfg))
  rest = rest.replace(URL_RE, ' ')
  // owner/repo#12 (a PR) and local files the user pointed at (./spec.md, /abs/path, ~/x)
  for (const m of rest.matchAll(/(?:^|\s)([\w.-]+\/[\w.-]+)#(\d+)(?=\s|$)/g)) sources.push({ kind: 'pr', ref: `${m[1]}#${m[2]}`, read: `gh pr view ${m[2]} --repo ${m[1]}` })
  rest = rest.replace(/(?:^|\s)[\w.-]+\/[\w.-]+#\d+(?=\s|$)/g, ' ')
  for (const m of rest.matchAll(/(?:^|\s)((?:\.{1,2}\/|\/|~\/)[^\s]+|[\w.-]+\/[^\s]*\.(?:md|txt|pdf|png|jpe?g|webp|html?|json|ya?ml|csv|docx?|xlsx?))(?=\s|$)/g)) {
    const p = m[1].startsWith('~/') ? join(process.env.HOME || '', m[1].slice(2)) : isAbsolute(m[1]) ? m[1] : join(resolve(root || '.'), m[1])
    if (existsSync(p)) { sources.push({ kind: 'file', ref: p, read: 'Read the file' }); rest = rest.replace(m[1], ' ') }
  }
  const request = rest.replace(/\s+/g, ' ').trim()
  // A bare key in the words is a tracker issue too.
  const textKey = strictKey(request, cfg.keys)
  if (textKey && !sources.some((s) => s.key === textKey)) sources.unshift({ kind: 'tracker', ref: textKey, key: textKey, read: 'the tracker recipe in the config (browser.mjs)' })
  const keyed = sources.find((s) => s.kind === 'tracker' && s.key) || sources.find((s) => s.kind === 'issue')
  return { request, key: keyed ? keyed.key : null, sources, hasTracker: sources.some((s) => s.kind === 'tracker' || s.kind === 'issue') }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, ...rest] = process.argv.slice(2)
  if (!root) { console.error('usage: sources.mjs <root> "<input>"'); process.exit(2) }
  console.log(JSON.stringify(classify(root, rest.join(' ')), null, 2))
}
