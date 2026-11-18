// /tf:e2e test cases gate: cases.md → validate → snapshot → status/scope → results.
// Run: node --test tests/cases.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { approve, caseRev, parse, parseCases, preview, results, safeId, scope, status, validate, validateParsed } from '../scripts/cases.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cases.mjs')
const cli = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { stdio: 'pipe' }).toString() } }
  catch (e) { return { code: e.status, out: String(e.stdout || '') } }
}

const CASES = `# Test cases — PROJ-7
Target: local

## Câu hỏi
- Q1 — "staff thấy gì" — A) tất cả B) của mình — đang giả định: A — ảnh hưởng: TC2 — hỏi: user

## Spec còn thiếu
- Màn hình "Lịch sử đơn" — chưa có thiết kế — bổ sung: --attach

## AC → TC
- AC1 — xem đơn: TC1, TC2
- AC2 — duyệt đơn: ⚠ chưa có TC — cần quyền admin

## Cases

### TC1 — Nhân viên xem đơn PENDING
- Nguồn: AC1
- Nền tảng: web
- Màn hình: /orders
- Data: user role=staff
- Bước:
  1. Đăng nhập staff
  2. Mở /orders
     rồi chờ bảng tải xong
- Mong đợi: đơn hiện ở tab "Chờ xử lý"
  nút "Duyệt" bật
- Ưu tiên: P1
- Ghi chú: không

### TC2: Danh sách trên app
- Nguồn: AC1
- Nền tảng: App
- Bước:
  - Mở app
  - Vào Đơn
- Mong đợi: thấy đơn
- Ưu tiên: p2
- Ghi chú: ⚠ giả định Q1=A
`

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'tf-cases-')))
// <root>/.pipeline/<SLUG> with cases.md, ticket.md, specs/.
function task(md = CASES, slug = 'PROJ-7') {
  const root = tmp()
  const dir = join(root, '.pipeline', slug)
  mkdirSync(join(dir, 'specs', 'ui'), { recursive: true })
  writeFileSync(join(dir, 'cases.md'), md)
  writeFileSync(join(dir, 'ticket.md'), '# PROJ-7\nStaff sees orders.\n\n## Clarifications\n- Q1: A\n\n## Comments\n- ok\n')
  writeFileSync(join(dir, 'specs', 'ui', 'orders.md'), 'orders spec')
  return { root, dir }
}
const flowsJson = (dir, cases, targets = {}) => writeFileSync(join(dir, 'flows.json'), JSON.stringify({ targets, cases }))
const flowFile = (dir, id) => { mkdirSync(join(dir, 'flows'), { recursive: true }); writeFileSync(join(dir, 'flows', `${id}.mjs`), '// flow') }
const edit = (dir, from, to) => { const f = join(dir, 'cases.md'); writeFileSync(f, readFileSync(f, 'utf8').replace(from, to)) }

test('parse reads every section, aliases and multi-line fields', () => {
  const p = parseCases(CASES)
  assert.equal(p.schemaVersion, 1)
  assert.equal(p.target, 'local')
  assert.equal(p.questions.length, 1)
  assert.equal(p.questions[0].id, 'Q1')
  assert.equal(p.missingSpecs.length, 1)
  assert.deepEqual(p.coverage, [
    { ac: 'AC1', summary: 'xem đơn', cases: ['TC1', 'TC2'], flagged: false },
    { ac: 'AC2', summary: 'duyệt đơn', cases: [], flagged: true },
  ])
  const [a, b] = p.cases
  assert.equal(a.id, 'TC1'); assert.equal(a.sourceId, 'TC1'); assert.equal(a.title, 'Nhân viên xem đơn PENDING')
  assert.equal(a.platform, 'Web'); assert.equal(a.screen, '/orders'); assert.equal(a.data, 'user role=staff')
  assert.deepEqual(a.steps, ['Đăng nhập staff', 'Mở /orders rồi chờ bảng tải xong'])
  assert.equal(a.expected, 'đơn hiện ở tab "Chờ xử lý"\nnút "Duyệt" bật')
  assert.equal(a.priority, 'P1'); assert.equal(a.flagged, false); assert.match(a.rev, /^[0-9a-f]{12}$/)
  assert.equal(b.title, 'Danh sách trên app'); assert.equal(b.platform, 'App'); assert.deepEqual(b.steps, ['Mở app', 'Vào Đơn'])
  assert.equal(b.priority, 'P2'); assert.equal(b.flagged, true)

  const en = parseCases(`# Test cases — X\nTarget: dev\n\n## Questions\n- none\n\n## Missing specs\n\n## Coverage\n- AC1: B-1\n\n## Cases\n\n### B-1 – English labels\n- Source: QC:B1\n- Platform: API\n- Screen: POST /orders\n- Steps:\n  1. call\n- Expected: 201\n- Priority: P3\n- Notes: n\n\n### C 2 - dash\n- Source: đề xuất\n- Platform: WEB\n- Steps: 1. one line\n- Expected: ok\n`)
  assert.equal(en.target, 'dev')
  assert.deepEqual(en.questions, [])
  assert.deepEqual(en.coverage[0].cases, ['B-1'])
  assert.deepEqual(en.cases.map((c) => [c.sourceId, c.title, c.platform]), [['B-1', 'English labels', 'API'], ['C 2', 'dash', 'Web']])
  assert.deepEqual(en.cases[1].steps, ['one line'])
  assert.equal(parseCases('## AC -> TC\n- AC1 — x: T1\n').coverage[0].cases[0], 'T1')
})

test('internal ids come from any QC id: diacritics, spaces, clashes', () => {
  assert.equal(safeId('TC_1-a'), 'TC_1-a')
  assert.equal(safeId('Mục B3b'), 'Muc-B3b')
  assert.equal(safeId('Đơn #12 (đã hủy)'), 'Don-12-da-huy')
  assert.equal(safeId('QC:42'), 'QC-42')
  assert.equal(safeId('x'.repeat(60) + ' y').length, 40)
  assert.equal(safeId('???'), 'case')
  const md = (ids) => `Target: local\n## Cases\n${ids.map((i) => `### ${i} — t\n- Nguồn: AC1\n`).join('')}`
  const p = parseCases(md(['QC 1', 'QC-1', 'QC:1', 'Ả 5']))
  assert.deepEqual(p.cases.map((c) => c.id), ['QC-1', 'QC-1-2', 'QC-1-3', 'A-5'])
  assert.deepEqual(p.cases.map((c) => c.sourceId), ['QC 1', 'QC-1', 'QC:1', 'Ả 5'])
})

test('rev follows only what changes how a case runs', () => {
  const base = parseCases(CASES).cases[0]
  const same = (from, to) => parseCases(CASES.replace(from, to)).cases[0].rev
  assert.equal(same('- Ghi chú: không', '- Ghi chú: khác hẳn ⚠'), base.rev)
  assert.equal(same('- Ưu tiên: P1', '- Ưu tiên: P3'), base.rev)
  assert.equal(same('- Nguồn: AC1\n- Nền tảng: web', '- Nguồn: QC:9\n- Nền tảng: web'), base.rev)
  assert.equal(same('Nhân viên xem đơn PENDING', 'Tên mới'), base.rev)
  assert.equal(same('  1. Đăng nhập staff', '  1.   Đăng   nhập staff'), base.rev) // whitespace only
  assert.notEqual(same('  1. Đăng nhập staff', '  1. Đăng nhập admin'), base.rev)
  assert.notEqual(same('- Màn hình: /orders', '- Màn hình: /orders/2'), base.rev)
  assert.equal(caseRev(base), base.rev)
})

test('validate reports every error', () => {
  const ok = validateParsed(parseCases(CASES))
  assert.equal(ok.ok, true, ok.errors.join('; '))
  assert.deepEqual(ok.counts, { cases: 2, web: 1, app: 1, api: 0, flagged: 1, uncovered: 1 })
  assert.ok(ok.warnings.some((w) => /open question/.test(w)))
  assert.ok(ok.warnings.some((w) => /missing spec/.test(w)))
  assert.ok(ok.warnings.some((w) => /TC2: ⚠/.test(w)))

  const errs = (md, targets) => validateParsed(parseCases(md), targets ? { targets } : undefined).errors
  assert.deepEqual(errs('Target: local\n## Cases\n'), ['no cases'])
  assert.ok(errs(CASES + '\n### TC1 — again\n- Nguồn: AC1\n- Nền tảng: Web\n- Bước: x\n- Mong đợi: y\n- Ưu tiên: P1\n').includes('duplicate case ID: TC1'))
  const p = parseCases(CASES); p.cases[1].id = 'TC1'
  assert.ok(validateParsed(p).errors.includes('duplicate internal id: TC1'))
  const e = errs(CASES.replace('- Nguồn: AC1\n- Nền tảng: web', '- Nền tảng: web').replace('- Nền tảng: App\n', '').replace('- Mong đợi: thấy đơn\n', ''))
  assert.ok(e.includes('TC1: missing Nguồn'))
  assert.ok(e.includes('TC2: missing Nền tảng'))
  assert.ok(e.includes('TC2: missing Mong đợi'))
  assert.ok(errs(CASES.replace('  - Mở app\n  - Vào Đơn\n', '')).includes('TC2: missing Bước'))
  assert.ok(errs(CASES.replace('Nền tảng: web', 'Nền tảng: Desktop')).some((x) => /TC1: invalid Nền tảng/.test(x)))
  assert.ok(errs(CASES.replace('Ưu tiên: P1', 'Ưu tiên: cao')).some((x) => /TC1: invalid Ưu tiên/.test(x)))
  assert.ok(validateParsed(parseCases(CASES.replace('- Ưu tiên: P1\n', ''))).warnings.includes('TC1: no Ưu tiên'))
  assert.ok(errs(CASES.replace('TC1, TC2', 'TC1, TC9')).some((x) => /AC1: coverage names TC9/.test(x)))
  assert.ok(errs(CASES.replace('⚠ chưa có TC — cần quyền admin', '')).some((x) => /AC2: no case covers it/.test(x)))
  assert.ok(errs(CASES.replace('Target: local', 'Target:')).includes('empty Target'))
  assert.ok(errs(CASES.replace('Target: local', 'Target: staging')).some((x) => /Target "staging" is not known/.test(x)))
})

test('targets are known from flows.json and the workspace config ## Flows', () => {
  const { root, dir } = task(CASES.replace('Target: local', 'Target: staging'))
  assert.equal(validate(dir).ok, false)
  flowsJson(dir, {}, { staging: { BASE_URL: 'x' } })
  assert.equal(validate(dir).ok, true)
  const { root: r2, dir: d2 } = task(CASES.replace('Target: local', 'Target: dev'))
  mkdirSync(join(r2, '.claude'))
  writeFileSync(join(r2, '.claude', 'task-flow.md'), '## Flows (e2e)\n- Targets: `local` = the task\'s own ports; `dev` = <shared dev URL, or "not allowed">.\n')
  assert.equal(validate(d2).ok, false) // the template placeholder is not a target
  writeFileSync(join(r2, '.claude', 'task-flow.md'), '## Flows (e2e)\n- Targets: `local` = the task\'s own ports; `dev` = https://dev.acme.io\n\n## Servers\n- Targets: `prod` = no\n')
  assert.equal(validate(d2).ok, true)
  assert.ok(root)
})

test('approve writes the snapshot, refuses an invalid cases.md (CLI)', () => {
  const { dir } = task(CASES.replace('Target: local', 'Target: nowhere'))
  let r = cli('approve', dir)
  assert.equal(r.code, 1)
  assert.equal(existsSync(join(dir, 'cases.approved.json')), false)
  assert.equal(cli('validate', dir).code, 1)
  edit(dir, 'Target: nowhere', 'Target: local')
  assert.equal(cli('validate', dir).code, 0)
  r = cli('approve', dir)
  assert.equal(r.code, 0)
  const out = JSON.parse(r.out)
  assert.equal(out.approved, true); assert.equal(out.cases, 2)
  const snap = JSON.parse(readFileSync(join(dir, 'cases.approved.json'), 'utf8'))
  assert.equal(snap.schemaVersion, 1); assert.equal(snap.target, 'local'); assert.equal(snap.hash, out.hash)
  assert.match(snap.requirements, /^[0-9a-f]{64}$/)
  assert.deepEqual(snap.cases, parse(dir).cases)
  assert.ok(snap.approvedAt)
  const parsed = JSON.parse(cli('parse', dir).out)
  assert.equal(parsed.cases[0].id, 'TC1')
  assert.equal(cli('nope', dir).code, 2)
})

test('status: edited, requirementsChanged', () => {
  const { dir } = task()
  let s = status(dir)
  assert.equal(s.approved, false); assert.equal(s.valid, true); assert.equal(s.edited, false)
  assert.deepEqual(s.cases.map((c) => [c.id, c.flow, c.result]), [['TC1', 'missing', 'none'], ['TC2', 'missing', 'none']])
  approve(dir)
  s = status(dir)
  assert.equal(s.approved, true); assert.equal(s.edited, false); assert.equal(s.requirementsChanged, false)
  edit(dir, '- Ghi chú: không', '- Ghi chú: có') // notes do not change rev but do change the approved text
  assert.equal(status(dir).edited, true)
  edit(dir, '- Ghi chú: có', '- Ghi chú: không')
  assert.equal(status(dir).edited, false)
  // Only the Clarifications answer changes: same requirements.
  writeFileSync(join(dir, 'ticket.md'), '# PROJ-7\nStaff sees orders.\n\n## Clarifications\n- Q1: B, after all\n\n## Comments\n- ok\n')
  assert.equal(status(dir).requirementsChanged, false)
  writeFileSync(join(dir, 'ticket.md'), '# PROJ-7\nStaff sees ALL orders.\n\n## Clarifications\n- Q1: B, after all\n\n## Comments\n- ok\n')
  assert.equal(status(dir).requirementsChanged, true)
  approve(dir)
  assert.equal(status(dir).requirementsChanged, false)
  writeFileSync(join(dir, 'specs', 'ui', 'new.png'), 'img')
  assert.equal(status(dir).requirementsChanged, true)
})

test('status: flow fresh/stale/missing, result valid/invalid by rev, target and commit; scope (CLI)', () => {
  const { dir } = task()
  approve(dir)
  const [a, b] = parse(dir).cases
  flowFile(dir, 'TC1'); flowFile(dir, 'TC2')
  flowsJson(dir, {
    TC1: { caseRev: a.rev, lastResult: 'PASS', lastTarget: 'local', commit: 'abc' },
    TC2: { caseRev: 'old', lastResult: 'PASS', lastTarget: 'local', commit: 'abc' },
  })
  let s = status(dir)
  assert.deepEqual(s.cases.map((c) => [c.id, c.flow, c.result, c.lastResult]), [['TC1', 'fresh', 'valid', 'PASS'], ['TC2', 'stale', 'invalid', 'PASS']])
  assert.equal(status(dir, { commit: 'abc' }).cases[0].result, 'valid')
  assert.equal(status(dir, { commit: 'def' }).cases[0].result, 'invalid')
  assert.deepEqual(scope(dir), ['TC2'])
  assert.deepEqual(scope(dir, { commit: 'def' }), ['TC1', 'TC2'])
  flowsJson(dir, { TC1: { caseRev: a.rev, lastResult: 'FAIL', lastTarget: 'dev' }, TC2: { caseRev: b.rev } })
  s = status(dir)
  assert.deepEqual(s.cases.map((c) => [c.flow, c.result]), [['fresh', 'invalid'], ['fresh', 'none']])
  // Old flows.json with nothing in it never crashes.
  writeFileSync(join(dir, 'flows.json'), '{}')
  assert.deepEqual(status(dir).cases.map((c) => c.flow), ['stale', 'stale'])
  const out = join(dir, 'scope.json')
  const r = cli('scope', dir, '--commit', 'x', '--out', out)
  assert.equal(r.code, 0)
  assert.deepEqual(JSON.parse(r.out), ['TC1', 'TC2'])
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), ['TC1', 'TC2'])
  assert.equal(JSON.parse(cli('status', dir).out).approved, true)
})

test('preview is a table plus one line of counts', () => {
  const { dir } = task(CASES.replace('### TC2: Danh', '### QC 2: Danh'))
  flowFile(dir, 'TC1')
  const r = cli('preview', dir)
  assert.equal(r.code, 0)
  const lines = r.out.trim().split('\n')
  assert.equal(lines[0], '| ID | Tên | Nền tảng | Flow | ⚠ |')
  assert.equal(lines[2], '| TC1 | Nhân viên xem đơn PENDING | Web | stale |  |')
  assert.equal(lines[3], '| QC 2 (QC-2) | Danh sách trên app | App | missing | ⚠ |')
  assert.ok(lines.includes('- AC1: coverage names TC2, which is not a case')) // errors follow the counts
  assert.match(lines.find((l) => l.startsWith('2 TC')), /^2 TC · 1 AC chưa có TC · 1 ⚠ · 1 câu hỏi · 1 spec còn thiếu · target: local$/)
  assert.match(preview(dir), /Nhân viên/)
})

// A task with an approved snapshot of three cases and flows.json results.
function ran(entries, md) {
  const { dir } = task(md || CASES + `
### Mục B3b — Ô lỗi | khuất
- Nguồn: QC:B3b
- Nền tảng: Web
- Bước:
  1. Mở form
- Mong đợi: thấy câu báo lỗi
- Ưu tiên: P2
`)
  approve(dir)
  const cases = parse(dir).cases
  const rev = Object.fromEntries(cases.map((c) => [c.id, c.rev]))
  const all = {}
  for (const [id, e] of Object.entries(entries)) all[id] = { caseRev: rev[id], lastTarget: 'local', commit: 'c1', ...e }
  flowsJson(dir, all)
  mkdirSync(join(dir, 'evd'), { recursive: true })
  return dir
}

test('results: verified, verified-bugs, incomplete', () => {
  let dir = ran({ TC1: { lastResult: 'PASS' }, TC2: { lastResult: 'PASS' }, 'Muc-B3b': { lastResult: 'PASS' } })
  let r = results(dir)
  assert.equal(r.verdict, 'verified')
  assert.deepEqual(r.counts, { pass: 3, fail: 0, blocked: 0, unverified: 0 })
  assert.equal(results(dir, { commit: 'other' }).verdict, 'incomplete')

  dir = ran({ TC1: { lastResult: 'PASS' }, TC2: { lastResult: 'FAIL', error: 'boom' }, 'Muc-B3b': { lastResult: 'PASS' } })
  r = results(dir, { commit: 'c1' })
  assert.equal(r.verdict, 'verified-bugs')
  assert.equal(r.cases[1].status, 'FAIL'); assert.equal(r.cases[1].error, 'boom')

  dir = ran({ TC1: { lastResult: 'PASS' }, TC2: { lastResult: 'FAIL' } }) // B3b never ran
  r = results(dir)
  assert.equal(r.verdict, 'incomplete')
  assert.deepEqual(r.counts, { pass: 1, fail: 1, blocked: 0, unverified: 1 })
  assert.equal(r.cases[2].status, 'unverified')

  dir = ran({ TC1: { lastResult: 'PASS' }, TC2: { lastResult: 'PASS' }, 'Muc-B3b': { lastResult: 'BLOCKED', error: 'no emulator' } })
  assert.equal(results(dir).verdict, 'incomplete')
  dir = ran({ TC1: { lastResult: 'PASS', lastTarget: 'dev' }, TC2: { lastResult: 'PASS' }, 'Muc-B3b': { lastResult: 'PASS' } })
  assert.equal(results(dir).cases[0].status, 'unverified') // ran against another target
})

test('results --write: comment images, results.json, ticket-comment.md, HANDOFF block (CLI)', () => {
  const dir = ran({
    TC1: { lastResult: 'PASS', shots: ['TC1-01-list.webp'] },
    TC2: { lastResult: 'BLOCKED', error: 'no emulator\nmore' },
    'Muc-B3b': {
      lastResult: 'FAIL', error: 'expect failed: thấy câu báo lỗi', shots: ['Muc-B3b-fail.webp'],
      marked: [{ file: 'Muc-B3b-fail.marked.webp', caption: 'Lỗi khuất bên dưới' }, { file: 'evd/Muc-B3b-crop.marked.webp', caption: 'Cận cảnh ô lỗi' }, { file: 'gone.webp', caption: 'x' }],
      marks: [{ label: 'Không có câu báo lỗi', expected: 'Có câu báo lỗi', actual: 'Không có gì', step: 'submit' }, { label: 'Nút khoá', expected: 'Nút bật', actual: 'Nút bị khoá' }],
    },
  })
  for (const f of ['TC1-01-list.webp', 'Muc-B3b-fail.webp', 'Muc-B3b-fail.marked.webp', 'Muc-B3b-crop.marked.webp']) writeFileSync(join(dir, 'evd', f), f)
  mkdirSync(join(dir, 'evd', 'comment'))
  writeFileSync(join(dir, 'evd', 'comment', 'PROJ-7-0101-old.webp'), 'stale')
  writeFileSync(join(dir, 'HANDOFF.md'), '# Handoff\n\n<!-- tf:cases -->\nold\n<!-- /tf:cases -->\n\n## Next\n- x\n')

  const r = cli('results', dir, '--write', '--date', '1811', '--commit', 'c1')
  assert.equal(r.code, 0)
  assert.equal(JSON.parse(r.out).verdict, 'incomplete')
  assert.deepEqual(readdirSync(join(dir, 'evd', 'comment')).sort(), [
    'PROJ-7-1811-Muc-B3ba-loi-khuat-ben-duoi.webp',
    'PROJ-7-1811-Muc-B3bb-can-canh-o-loi.webp',
    'PROJ-7-1811-TC1a-tc1-01-list.webp',
  ])
  assert.equal(readFileSync(join(dir, 'evd', 'comment', 'PROJ-7-1811-Muc-B3ba-loi-khuat-ben-duoi.webp'), 'utf8'), 'Muc-B3b-fail.marked.webp')
  const saved = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'))
  assert.equal(saved.verdict, 'incomplete'); assert.equal(saved.commit, 'c1')
  assert.deepEqual(saved.cases[2].comment.map((x) => x.file), ['evd/comment/PROJ-7-1811-Muc-B3ba-loi-khuat-ben-duoi.webp', 'evd/comment/PROJ-7-1811-Muc-B3bb-can-canh-o-loi.webp'])

  const md = readFileSync(join(dir, 'ticket-comment.md'), 'utf8').split('\n')
  assert.equal(md[0], 'Môi trường: local')
  assert.equal(md[2], '| ID | TC | Kết quả | Evidence |')
  assert.equal(md[4], '| TC1 | Nhân viên xem đơn PENDING | PASS | <evd:PROJ-7-1811-TC1a-tc1-01-list.webp> |')
  assert.equal(md[5], '| TC2 | Danh sách trên app | Not tested — no emulator |  |')
  assert.equal(md[6], '| Mục B3b | Ô lỗi \\| khuất | Failed — BUG: Không có câu báo lỗi | <evd:PROJ-7-1811-Muc-B3ba-loi-khuat-ben-duoi.webp> <evd:PROJ-7-1811-Muc-B3bb-can-canh-o-loi.webp> |')
  assert.equal(md[8], 'Chi tiết lỗi:')
  assert.equal(md[10], '| # | Vấn đề | Hiện tại | Mong muốn | Evidence |')
  assert.equal(md[12], '| Mục B3b | Ô lỗi \\| khuất<br>Nguồn: QC:B3b | • Không có gì<br>• Nút bị khoá | • Có câu báo lỗi<br>• Nút bật | <evd:PROJ-7-1811-Muc-B3ba-loi-khuat-ben-duoi.webp><br>_Lỗi khuất bên dưới_<br><evd:PROJ-7-1811-Muc-B3bb-can-canh-o-loi.webp><br>_Cận cảnh ô lỗi_ |')

  const h = readFileSync(join(dir, 'HANDOFF.md'), 'utf8')
  assert.doesNotMatch(h, /\nold\n/)
  assert.match(h, /<!-- tf:cases -->\nKết luận: incomplete\n\n\| ID \| TC \| Kết quả \| Flow \|\n/)
  assert.match(h, /\| TC2 \| Danh sách trên app \| BLOCKED \| — \|/)
  assert.match(h, /<!-- \/tf:cases -->\n\n## Next\n- x\n$/)
  assert.equal((h.match(/<!-- tf:cases -->/g) || []).length, 1)
})

test('results --write in English, unverified reason, fail without marks, HANDOFF block appended', () => {
  const dir = ran({ TC1: { lastResult: 'FAIL', error: 'timeout waiting for table\nstack' } })
  writeFileSync(join(dir, 'HANDOFF.md'), '# Handoff\n')
  results(dir, { write: true, lang: 'en', date: '0102' })
  const md = readFileSync(join(dir, 'ticket-comment.md'), 'utf8').split('\n')
  assert.equal(md[0], 'Environment: local')
  assert.equal(md[2], '| ID | TC | Result | Evidence |')
  assert.equal(md[4], '| TC1 | Nhân viên xem đơn PENDING | Failed — BUG: timeout waiting for table |  |')
  assert.equal(md[5], '| TC2 | Danh sách trên app | Not tested — no valid result |  |')
  assert.equal(md[8], 'Bug details:')
  assert.equal(md[10], '| # | Issue | Actual | Expected | Evidence |')
  assert.equal(md[12], '| TC1 | Nhân viên xem đơn PENDING<br>Source: AC1 | • timeout waiting for table | • đơn hiện ở tab "Chờ xử lý"<br>nút "Duyệt" bật |  |')
  const h = readFileSync(join(dir, 'HANDOFF.md'), 'utf8')
  assert.match(h, /^# Handoff\n\n<!-- tf:cases -->\nVerdict: incomplete\n/)
  assert.match(h, /\| TC2 \| Danh sách trên app \| unverified \| — \|\n\| Mục B3b \| Ô lỗi \\\| khuất \| unverified \| — \|\n<!-- \/tf:cases -->\n$/)
})
