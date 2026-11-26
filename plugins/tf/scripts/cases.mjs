#!/usr/bin/env node
// task-flow e2e test cases: <task>/cases.md (written by the PM, edited and approved by the user) → a frozen
// snapshot (cases.approved.json) that the e2e run executes exactly, and the one place that decides the outcome.
//
//   node cases.mjs <cmd> <taskDir> [--commit <sha>] [--out <file>] [--write] [--lang vi|en] [--date DDMM]
//
//   parse      cases.md → JSON (schemaVersion, target, questions, missingSpecs, coverage, cases[] with id + rev)
//   validate   { ok, errors[], warnings[], counts } — exit 1 when not ok
//   approve    validate, then write cases.approved.json (the snapshot) — exit 1 and nothing written when invalid
//   status     snapshot vs cases.md / requirements; per case flow fresh|stale|missing, result valid|invalid|none
//   scope      JSON array of internal ids without a valid result (--out writes it for flow-run.mjs --cases-file)
//   preview    plain text for chat: table ID · Tình huống · Mong đợi · Nền tảng · ⚠, a line of counts, a line of flows
//   results    verdict per snapshot case (verified | verified-bugs | incomplete); --write copies comment images to
//              evd/comment/, writes results.json, ticket-comment.md and the HANDOFF.md cases block
//
// Three things expire separately: the snapshot (requirements or cases.md changed), a flow (the case's rev changed),
// a result (rev, target or commit changed). A case's internal id ([A-Za-z0-9_-]) names its flow, verdict and evidence;
// sourceId (the ID as written, e.g. a QC id) is display-only.

import { configPath } from '../core/paths.mjs'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rootOfTask } from './platform.mjs'

export const SCHEMA = 1
export const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/
const PLATFORMS = { web: 'Web', app: 'App', api: 'API' }

// ── Text helpers ─────────────────────────────────────────────────────────────
export const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const sha = (s) => createHash('sha256').update(s).digest('hex')
// Diacritics stripped, anything not a letter or digit → "-", at most `max` characters. Case is kept.
export function slugify(s, max = 40) {
  return plain(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '')
}
// The internal id of a heading ID: itself when already safe, else its slug ("case" when nothing is left).
export const safeId = (sourceId) => (SAFE_ID.test(sourceId) ? sourceId : slugify(sourceId) || 'case')
// JSON with sorted keys: the same data always hashes the same.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}
// What a flow is written for: only the fields that change how the case runs.
export function caseRev(c) {
  const steps = (c.steps || []).map(squash)
  return sha(JSON.stringify([squash(c.platform), squash(c.screen), squash(c.data), steps, squash(c.expected)])).slice(0, 12)
}
export const casesHash = (parsed) => sha(canonical({ target: parsed.target || '', cases: parsed.cases || [] }))

// ── cases.md → JSON ──────────────────────────────────────────────────────────
const key = (s) => squash(plain(s).replace(/[*_`]/g, '').toLowerCase())
const SECTIONS = [
  ['questions', (k) => k === 'cau hoi' || k === 'questions' || k === 'question'],
  ['missing', (k) => k === 'spec con thieu' || k === 'missing specs' || k === 'missing spec'],
  ['coverage', (k) => k === 'coverage' || /^ac\s*(→|->|=>)\s*tc$/.test(k)],
  ['cases', (k) => k === 'cases' || k === 'test cases' || k === 'cac case'],
]
const FIELDS = {
  source: ['nguon', 'source'],
  platform: ['nen tang', 'platform'],
  screen: ['man hinh', 'screen'],
  data: ['data', 'du lieu'],
  steps: ['buoc', 'cac buoc', 'steps'],
  expected: ['mong doi', 'ket qua mong doi', 'expected'],
  priority: ['uu tien', 'priority'],
  notes: ['ghi chu', 'notes', 'note'],
}
const fieldOf = (label) => { const k = key(label); return Object.keys(FIELDS).find((f) => FIELDS[f].includes(k)) }
const NONE = /^\(?(khong co|khong|none|n\/a|-|—)\)?\.?$/i
const HEAD_SEP = [' — ', ' – ', ' - ', ': ']

function splitHeading(text) {
  let at = -1, len = 0
  for (const s of HEAD_SEP) { const i = text.indexOf(s); if (i > 0 && (at < 0 || i < at)) { at = i; len = s.length } }
  return at < 0 ? [text.trim(), ''] : [text.slice(0, at).trim(), text.slice(at + len).trim()]
}

// "- AC1 — tóm tắt: TC1, TC2" | "- AC3 — tóm tắt: ⚠ chưa có TC — lý do"
function coverageItem(text) {
  const flagged = text.includes('⚠')
  const warn = text.indexOf('⚠')
  const head = flagged ? text.slice(0, warn) : text
  const colon = head.lastIndexOf(':')
  const left = colon >= 0 ? text.slice(0, colon) : text
  const right = colon >= 0 ? (flagged ? text.slice(colon + 1, warn) : text.slice(colon + 1)) : ''
  const [ac, summary] = splitHeading(left.trim())
  const cases = right.split(/[,;]/).map((s) => s.replace(/\(.*?\)/g, '').trim()).filter(Boolean)
  return { ac, summary, cases, flagged }
}

export function parseCases(md) {
  const out = { schemaVersion: SCHEMA, target: '', questions: [], missingSpecs: [], coverage: [], cases: [], notices: [] }
  let section = '', item = null, c = null, field = ''
  const items = { questions: [], missing: [], coverage: [] }
  const flushCase = () => { if (c) out.cases.push(c); c = null; field = '' }
  for (const raw of String(md).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const indented = /^\s/.test(line)
    let m
    if ((m = /^##\s+(.*)$/.exec(line)) && !line.startsWith('###')) {
      flushCase(); item = null
      const k = key(m[1])
      section = (SECTIONS.find(([, ok]) => ok(k)) || ['other'])[0]
      continue
    }
    if (/^#\s/.test(line)) { flushCase(); item = null; section = ''; continue }
    if (!section && (m = /^\s*(target|moi truong|environment)\s*:\s*(.*)$/i.exec(plain(line)))) {
      out.target = line.slice(line.indexOf(':') + 1).replace(/`/g, '').trim()
      continue
    }
    if ((m = /^###\s+(.*)$/.exec(line)) && !['questions', 'missing', 'coverage'].includes(section)) {
      flushCase()
      const [sourceId, title] = splitHeading(m[1])
      c = { id: '', sourceId, title, source: '', platform: '', screen: '', data: '', steps: [], expected: '', priority: '', notes: '', flagged: m[1].includes('⚠'), rev: '' }
      continue
    }
    if (['questions', 'missing', 'coverage'].includes(section)) {
      if ((m = /^[-*]\s+(.*)$/.exec(line))) { item = [m[1].trim()]; items[section].push(item) }
      else if (indented && item && line.trim()) item.push(line.trim())
      continue
    }
    if (!c || !line.trim()) continue
    if (line.includes('⚠')) c.flagged = true
    if (!indented && (m = /^[-*]\s+\**([^:*]{1,40}?)\**\s*:\**\s*(.*)$/.exec(line))) {
      const f = fieldOf(m[1])
      if (!f && field === 'steps') { c.steps.push(line.replace(/^[-*]\s+/, '').trim()); continue }
      if (!f) { out.notices.push(`${c.sourceId}: unknown field "${m[1].trim()}" ignored`); field = ''; continue }
      field = f
      const v = m[2].trim()
      if (f === 'steps') { if (v) c.steps.push(v.replace(/^(\d+[.)]|[-*])\s+/, '')) } else c[f] = v
      continue
    }
    if (field === 'steps') {
      if ((m = /^\s*(?:\d+[.)]|[-*])\s+(.*)$/.exec(line))) c.steps.push(m[1].trim())
      else if (indented && c.steps.length) c.steps[c.steps.length - 1] += ` ${line.trim()}`
      continue
    }
    if (field && indented) c[field] = c[field] ? `${c[field]}\n${line.trim()}` : line.trim()
  }
  flushCase()
  const text = (it) => it.join(' ').trim()
  for (const it of items.questions) {
    const t = text(it)
    if (NONE.test(plain(t))) continue
    const id = /^(Q\d+)\b/i.exec(t)
    out.questions.push({ id: id ? id[1].toUpperCase() : '', text: t })
  }
  out.missingSpecs = items.missing.map(text).filter((t) => !NONE.test(plain(t)))
  out.coverage = items.coverage.map(text).filter((t) => !NONE.test(plain(t))).map(coverageItem)
  // Internal ids: unique, stable for safe heading IDs, "-2", "-3" on a clash.
  const used = new Set()
  for (const k of out.cases) {
    const p = PLATFORMS[k.platform.trim().toLowerCase()]
    if (p) k.platform = p
    if (/^p[1-3]$/i.test(k.priority.trim())) k.priority = k.priority.trim().toUpperCase()
    const want = safeId(k.sourceId)
    let id = want
    for (let n = 2; used.has(id); n++) id = `${want.slice(0, 40 - String(n).length - 1)}-${n}`
    if (id !== want) out.notices.push(`${k.sourceId}: internal id ${want} is taken, using ${id}`)
    used.add(id)
    k.id = id
    k.rev = caseRev(k)
  }
  return out
}

// ── Task files ───────────────────────────────────────────────────────────────
const readText = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n')

export function parse(taskDir) {
  const md = readText(join(taskDir, 'cases.md'))
  if (md === null) throw new Error(`no cases.md in ${taskDir}`)
  return parseCases(md)
}
export const snapshotOf = (taskDir) => readJson(join(taskDir, 'cases.approved.json'))
export function flowsOf(taskDir) {
  const f = readJson(join(taskDir, 'flows.json')) || {}
  return { targets: f.targets && typeof f.targets === 'object' ? f.targets : {}, cases: f.cases && typeof f.cases === 'object' ? f.cases : {} }
}

// Targets a run may use: local, the ones saved in flows.json, the ones the workspace config `## Flows` names.
export function knownTargets(taskDir) {
  const names = new Set(['local', ...Object.keys(flowsOf(taskDir).targets)])
  const cfg = readText(configPath(rootOfTask(resolve(taskDir))))
  if (cfg) {
    let inFlows = false
    for (const line of cfg.split(/\r?\n/)) {
      if (/^##\s/.test(line)) { inFlows = /^##\s+flows\b/i.test(line); continue }
      if (!inFlows || !/target/i.test(line)) continue
      const body = line.replace(/^.*?targets?\s*[:：]/i, '')
      // `local` = …; `dev` = https://dev.acme.io   or   local = …, staging = …
      for (const part of body.split(/;|,(?=\s*`?[A-Za-z0-9_.-]+`?\s*(?:=|:|—|–))/)) {
        const m = /^\s*`?([A-Za-z0-9_.-]+)`?\s*(?:=|:|—|–)\s*(.*)$/.exec(part)
        if (!m || /not allowed|khong (duoc|cho phep)|^</i.test(plain(m[2]).trim())) continue
        names.add(m[1])
      }
    }
  }
  return [...names]
}

// The requirements a snapshot was approved against: ticket.md without its ## Clarifications, and specs/.
function listFiles(dir, rel = '') {
  let out = []
  let entries = []
  try { entries = readdirSync(join(dir, rel), { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out = out.concat(listFiles(dir, r))
    else if (e.isFile()) out.push(r)
  }
  return out
}
export function withoutClarifications(md) {
  const out = []
  let skip = false
  for (const line of String(md).replace(/\r\n?/g, '\n').split('\n')) {
    if (/^#{1,2}\s/.test(line)) skip = /^##\s+clarifications\b/i.test(line)
    if (!skip) out.push(line)
  }
  return out.join('\n')
}
export function requirementsHash(taskDir) {
  const h = createHash('sha256')
  h.update('ticket.md\0').update(withoutClarifications(readText(join(taskDir, 'ticket.md')) ?? '')).update('\0')
  const specs = join(taskDir, 'specs')
  for (const f of listFiles(specs).sort()) h.update(`specs/${f}\0`).update(readFileSync(join(specs, f))).update('\0')
  return h.digest('hex')
}

// ── validate / approve ───────────────────────────────────────────────────────
export function validateParsed(p, { targets = ['local'] } = {}) {
  const errors = [], warnings = []
  const cases = p.cases || []
  if (!cases.length) errors.push('no cases')
  const seen = (list, what) => {
    const s = new Set()
    for (const v of list) { if (s.has(v)) errors.push(`duplicate ${what}: ${v}`); s.add(v) }
  }
  seen(cases.map((c) => c.sourceId), 'case ID')
  seen(cases.map((c) => c.id), 'internal id')
  for (const c of cases) {
    const at = c.sourceId || c.id
    if (!SAFE_ID.test(c.id || '')) errors.push(`${at}: internal id ${JSON.stringify(c.id)} is not [A-Za-z0-9_-]{1,40}`)
    if (!squash(c.source)) errors.push(`${at}: missing Nguồn`)
    if (!squash(c.platform)) errors.push(`${at}: missing Nền tảng`)
    else if (!Object.values(PLATFORMS).includes(c.platform)) errors.push(`${at}: invalid Nền tảng "${c.platform}" (Web | App | API)`)
    if (!(c.steps || []).some((s) => squash(s))) errors.push(`${at}: missing Bước`)
    if (!squash(c.expected)) errors.push(`${at}: missing Mong đợi`)
    if (!squash(c.priority)) warnings.push(`${at}: no Ưu tiên`)
    else if (!/^P[1-3]$/.test(c.priority)) errors.push(`${at}: invalid Ưu tiên "${c.priority}" (P1 | P2 | P3)`)
    if (c.flagged) warnings.push(`${at}: ⚠ needs a look`)
  }
  const ids = new Set(cases.flatMap((c) => [c.sourceId, c.id]))
  for (const a of p.coverage || []) {
    for (const t of a.cases) if (!ids.has(t)) errors.push(`${a.ac}: coverage names ${t}, which is not a case`)
    if (!a.cases.length && !a.flagged) errors.push(`${a.ac}: no case covers it and it is not marked ⚠`)
  }
  if (!squash(p.target)) errors.push('empty Target')
  else if (!targets.includes(p.target)) errors.push(`Target "${p.target}" is not known (${targets.join(', ')}) — add it to the config ## Flows or flows.json targets`)
  if ((p.questions || []).length) warnings.push(`${p.questions.length} open question(s)`)
  if ((p.missingSpecs || []).length) warnings.push(`${p.missingSpecs.length} missing spec(s)`)
  for (const n of p.notices || []) warnings.push(n)
  const count = (pl) => cases.filter((c) => c.platform === pl).length
  return {
    ok: !errors.length, errors, warnings,
    counts: { cases: cases.length, web: count('Web'), app: count('App'), api: count('API'), flagged: cases.filter((c) => c.flagged).length, uncovered: (p.coverage || []).filter((a) => !a.cases.length).length },
  }
}
export function validate(taskDir) {
  let p
  try { p = parse(taskDir) } catch (e) { return { ok: false, errors: [e.message], warnings: [], counts: { cases: 0, web: 0, app: 0, api: 0, flagged: 0, uncovered: 0 } } }
  return validateParsed(p, { targets: knownTargets(taskDir) })
}

export function approve(taskDir, { now = new Date() } = {}) {
  const v = validate(taskDir)
  if (!v.ok) return { approved: false, errors: v.errors }
  const p = parse(taskDir)
  const { notices, ...rest } = p
  const snap = { schemaVersion: SCHEMA, approvedAt: now.toISOString(), target: rest.target, requirements: requirementsHash(taskDir), hash: casesHash(p), cases: p.cases }
  writeJson(join(taskDir, 'cases.approved.json'), snap)
  return { approved: true, hash: snap.hash, cases: snap.cases.length }
}

// ── status / scope ───────────────────────────────────────────────────────────
// One case against flows.json: is its flow written for this rev, is its last result still worth anything?
export function caseState(taskDir, c, entry, target, commit) {
  const e = entry || {}
  const flow = !existsSync(join(taskDir, 'flows', `${c.id}.mjs`)) ? 'missing' : e.caseRev === c.rev ? 'fresh' : 'stale'
  // commit undefined = not checked (status for display); '' = the code under test is unknown (no worktree):
  // nothing recorded can be trusted for it, so no result is reused.
  const result = !e.lastResult ? 'none'
    : commit === '' ? 'invalid'
    : e.caseRev === c.rev && e.lastTarget === target && (commit === undefined || e.commit === commit) ? 'valid' : 'invalid'
  return { flow, result }
}

export function status(taskDir, { commit } = {}) {
  const snap = snapshotOf(taskDir)
  let parsed = null
  try { parsed = parse(taskDir) } catch {}
  if (!snap && !parsed) throw new Error(`no cases.md and no cases.approved.json in ${taskDir}`)
  const valid = parsed ? validateParsed(parsed, { targets: knownTargets(taskDir) }).ok : false
  const src = snap || parsed
  const target = src.target || ''
  const flows = flowsOf(taskDir)
  return {
    approved: !!snap,
    valid,
    edited: !!(snap && parsed && casesHash(parsed) !== snap.hash),
    requirementsChanged: !!(snap && requirementsHash(taskDir) !== snap.requirements),
    target,
    cases: (src.cases || []).map((c) => {
      const e = flows.cases[c.id] || {}
      return { id: c.id, sourceId: c.sourceId, rev: c.rev, ...caseState(taskDir, c, e, target, commit), lastResult: e.lastResult || null }
    }),
  }
}

export function scope(taskDir, { commit, out } = {}) {
  const ids = status(taskDir, { commit }).cases.filter((c) => c.result !== 'valid').map((c) => c.id)
  if (out) writeJson(resolve(out), ids)
  return ids
}

// ── preview ──────────────────────────────────────────────────────────────────
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
export function preview(taskDir) {
  const p = parse(taskDir)
  const v = validateParsed(p, { targets: knownTargets(taskDir) })
  const flows = flowsOf(taskDir)
  const flowOf = {}
  const rows = p.cases.map((c) => {
    const s = caseState(taskDir, c, flows.cases[c.id], p.target, undefined)
    flowOf[s.flow] = (flowOf[s.flow] || 0) + 1
    const id = c.id === c.sourceId ? c.sourceId : `${c.sourceId} (${c.id})`
    return `| ${cell(id)} | ${cell(c.title)} | ${cell(clip(squash(c.expected), 140))} | ${cell(c.platform)} | ${c.flagged ? '⚠' : ''} |`
  })
  const lines = ['| ID | Tình huống | Mong đợi | Nền tảng | ⚠ |', '|---|---|---|---|---|', ...rows, '',
    `${v.counts.cases} TC · ${v.counts.uncovered} AC chưa có TC · ${v.counts.flagged} ⚠ · ${p.questions.length} câu hỏi · ${p.missingSpecs.length} spec còn thiếu · target: ${p.target || '(trống)'}`,
    `flow: ${Object.entries(flowOf).map(([k, n]) => `${n} ${k}`).join(' · ') || '-'}`]
  if (v.errors.length) lines.push('', 'Lỗi:', ...v.errors.map((e) => `- ${e}`))
  return lines.join('\n') + '\n'
}

// ── results ──────────────────────────────────────────────────────────────────
const LABELS = {
  vi: { env: 'Môi trường', result: 'Kết quả', bug: 'Failed — BUG', notTested: 'Not tested', noResult: 'chưa có kết quả hợp lệ', blocked: 'môi trường chặn', details: 'Chi tiết lỗi', issue: 'Vấn đề', actual: 'Hiện tại', expected: 'Mong muốn', source: 'Nguồn', verdict: 'Kết luận', unverified: 'chưa xác minh' },
  en: { env: 'Environment', result: 'Result', bug: 'Failed — BUG', notTested: 'Not tested', noResult: 'no valid result', blocked: 'blocked by the environment', details: 'Bug details', issue: 'Issue', actual: 'Actual', expected: 'Expected', source: 'Source', verdict: 'Verdict', unverified: 'unverified' },
}
const firstLine = (s) => String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || ''
const letters = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(97 + ((n - 1) % 26)) + s; return s }
const ddmm = (d = new Date()) => `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}`

export function results(taskDir, { commit, write = false, lang = 'vi', date } = {}) {
  const snap = snapshotOf(taskDir)
  if (!snap) throw new Error(`no cases.approved.json in ${taskDir} — approve cases.md first`)
  const target = snap.target || ''
  const flows = flowsOf(taskDir)
  const arr = (x) => (Array.isArray(x) ? x : [])
  const cases = arr(snap.cases).map((c) => {
    const e = flows.cases[c.id] || {}
    const st = caseState(taskDir, c, e, target, commit)
    const base = { id: c.id, sourceId: c.sourceId, title: c.title, source: c.source, platform: c.platform, expected: c.expected, flow: st.flow }
    if (st.result !== 'valid') return { ...base, status: 'unverified', error: '', shots: [], marked: [], marks: [] }
    return {
      ...base, status: e.lastResult, error: e.error || '',
      shots: arr(e.shots).filter((s) => typeof s === 'string'),
      marked: arr(e.marked).map((m) => (typeof m === 'string' ? { file: m, caption: '' } : { file: m && m.file, caption: (m && m.caption) || '' })).filter((m) => m.file),
      marks: arr(e.marks).filter((m) => m && typeof m === 'object').map((m) => ({ label: m.label || '', expected: m.expected || '', actual: m.actual || '', step: m.step || '' })),
    }
  })
  const n = (s) => cases.filter((c) => c.status === s).length
  const counts = { pass: n('PASS'), fail: n('FAIL'), blocked: n('BLOCKED'), unverified: cases.length - n('PASS') - n('FAIL') - n('BLOCKED') }
  const verdict = counts.unverified || counts.blocked ? 'incomplete' : counts.fail ? 'verified-bugs' : 'verified'
  const out = { verdict, counts, cases }
  if (!write) return out

  const L = LABELS[lang] || LABELS.vi
  const slug = basename(resolve(taskDir))
  const day = /^\d{4}$/.test(String(date || '')) ? String(date) : ddmm()
  const evd = join(taskDir, 'evd')
  const commentDir = join(evd, 'comment')
  mkdirSync(commentDir, { recursive: true })
  // This folder is ours: images of an earlier results --write for this task go, so nothing stale is uploaded.
  for (const f of readdirSync(commentDir)) if (f.startsWith(`${slug}-`)) rmSync(join(commentDir, f), { force: true })
  const findImage = (f) => [join(evd, String(f).replace(/^evd[\\/]/, '')), join(taskDir, String(f))].find((p) => existsSync(p) && statSync(p).isFile())
  for (const c of cases) {
    c.comment = []
    const imgs = c.marked.length ? c.marked : c.shots.map((s) => ({ file: s, caption: '' }))
    let i = 0
    for (const img of imgs) {
      const from = findImage(img.file)
      if (!from) continue
      const caption = img.caption || basename(img.file, extname(img.file))
      const desc = slugify(caption.toLowerCase(), 40)
      const name = `${slug}-${day}-${slugify(c.sourceId) || c.id}${letters(i++)}${desc ? `-${desc}` : ''}${extname(from).toLowerCase()}`
      copyFileSync(from, join(commentDir, name))
      c.comment.push({ file: `evd/comment/${name}`, caption: img.caption || '' })
    }
  }
  writeJson(join(taskDir, 'results.json'), { ...out, target, commit: commit || null, writtenAt: new Date().toISOString() })

  const evdCell = (c, withCaption) => c.comment.map((x) => `<evd:${basename(x.file)}>${withCaption && x.caption ? `<br>_${cell(x.caption)}_` : ''}`).join(withCaption ? '<br>' : ' ')
  const outcome = (c) => {
    if (c.status === 'PASS') return 'PASS'
    // The failure itself (the mark a failed expect() left: it has a step) names the bug; other marks only point.
    const lead = c.marks.find((m) => m.label && m.step && (m.expected || m.actual)) || c.marks.find((m) => m.label && m.step) || c.marks.find((m) => m.label)
    if (c.status === 'FAIL') return `${L.bug}: ${firstLine((lead || {}).label) || firstLine(c.error) || '?'}`
    return `${L.notTested} — ${c.status === 'BLOCKED' ? firstLine(c.error) || L.blocked : L.noResult}`
  }
  const bullets = (list) => list.map((x) => `• ${cell(String(x).trim())}`).join('<br>')
  const md = [`${L.env}: ${target}`, '', `| ID | TC | ${L.result} | Evidence |`, '|---|---|---|---|',
    ...cases.map((c) => `| ${cell(c.sourceId)} | ${cell(c.title)} | ${cell(outcome(c))} | ${evdCell(c, false)} |`)]
  const failed = cases.filter((c) => c.status === 'FAIL')
  if (failed.length) {
    md.push('', `${L.details}:`, '', `| # | ${L.issue} | ${L.actual} | ${L.expected} | Evidence |`, '|---|---|---|---|---|')
    for (const c of failed) {
      const actual = c.marks.map((m) => m.actual).filter(Boolean)
      const expected = c.marks.map((m) => m.expected).filter(Boolean)
      md.push(`| ${cell(c.sourceId)} | ${cell(c.title)}<br>${L.source}: ${cell(c.source)} | ${bullets(actual.length ? actual : [firstLine(c.error) || '?'])} | ${bullets(expected.length ? expected : [c.expected || '?'])} | ${evdCell(c, true)} |`)
    }
  }
  writeFileSync(join(taskDir, 'ticket-comment.md'), md.join('\n') + '\n')

  const handoff = join(taskDir, 'HANDOFF.md')
  const text = readText(handoff)
  if (text !== null) {
    const short = (c) => (c.status === 'unverified' ? L.unverified : c.status)
    const block = ['<!-- tf:cases -->', `${L.verdict}: ${verdict}`, '', `| ID | TC | ${L.result} | Flow |`, '|---|---|---|---|',
      ...cases.map((c) => `| ${cell(c.sourceId)} | ${cell(c.title)} | ${cell(short(c))} | ${c.flow === 'missing' ? '—' : `flows/${c.id}.mjs (${c.flow})`} |`), '<!-- /tf:cases -->'].join('\n')
    const re = /<!-- tf:cases -->[\s\S]*?<!-- \/tf:cases -->/
    writeFileSync(handoff, re.test(text) ? text.replace(re, () => block) : `${text.replace(/\s*$/, '')}\n\n${block}\n`)
  }
  return out
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const USAGE = 'usage: cases.mjs parse|validate|approve|status|scope|preview|results <taskDir> [--commit <sha>] [--out <file>] [--write] [--lang vi|en] [--date DDMM]'
  const [cmd, dirArg, ...rest] = process.argv.slice(2)
  const opts = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--write') opts.write = true
    else if (a.startsWith('--')) opts[a.slice(2)] = rest[++i]
  }
  if (!cmd || !dirArg || !existsSync(resolve(dirArg))) { console.error(USAGE); process.exit(2) }
  const dir = resolve(dirArg)
  const print = (v) => console.log(JSON.stringify(v, null, 2))
  try {
    if (cmd === 'parse') { const { notices, ...p } = parse(dir); print(p) }
    else if (cmd === 'validate') { const v = validate(dir); print(v); process.exitCode = v.ok ? 0 : 1 }
    else if (cmd === 'approve') { const r = approve(dir); print(r); process.exitCode = r.approved ? 0 : 1 }
    else if (cmd === 'status') print(status(dir, { commit: opts.commit }))
    else if (cmd === 'scope') print(scope(dir, { commit: opts.commit, out: opts.out }))
    else if (cmd === 'preview') process.stdout.write(preview(dir))
    else if (cmd === 'results') print(results(dir, { commit: opts.commit, write: opts.write, lang: opts.lang, date: opts.date }))
    else { console.error(USAGE); process.exit(2) }
  } catch (e) {
    print({ error: e.message })
    process.exitCode = 1
  }
}
