// flow-run.mjs against fake flows (no browser, no app): a flow here writes its verdict the way flow-kit does.
// Covers the strict runner (missing ids, empty runs, unsaved targets), --ensure-target, --mark-written, kept
// metadata, and the chain the e2e fast path relies on: cases.md → approve → flows → run → status → results.
// Run: node --test plugins/tf/tests/flow-run.mjs
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const S = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const RUN = join(S, 'flow-run.mjs')
const CASES = join(S, 'cases.mjs')

function task() {
  const root = mkdtempSync(join(tmpdir(), 'tf-flowrun-'))
  const dir = join(root, '.pipeline', 'T-1')
  mkdirSync(join(dir, 'flows'), { recursive: true })
  return { root, dir }
}
// A flow that writes a verdict like flow-kit: status, shots, marks.
function flow(dir, id, { status = 'PASS', shots = [], marks = [], png = false } = {}) {
  const body = `import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const E = process.env.EVD_DIR
${png ? `writeFileSync(join(E, '${id}-fail-x.png'), Buffer.from('${pngB64()}', 'base64'))` : ''}
writeFileSync(join(E, process.env.CASE + '.verdict.json'), JSON.stringify({ case: process.env.CASE, status: '${status}', platform: 'web', runId: process.env.RUN_ID,
  shots: ${JSON.stringify(shots)}, marks: ${JSON.stringify(marks)}, captions: {}, crop: [], error: '${status === 'PASS' ? '' : 'expect failed: x'}', durationMs: 1 }))
process.exitCode = ${status === 'PASS' ? 0 : 1}
`
  writeFileSync(join(dir, 'flows', `${id}.mjs`), body)
}
const run = (args) => {
  const r = spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf8' })
  let json = null
  try { json = JSON.parse(r.stdout) } catch {}
  return { code: r.status, json, out: r.stdout, err: r.stderr }
}
const cases = (args) => JSON.parse(execFileSync(process.execPath, [CASES, ...args], { encoding: 'utf8' }))
const manifest = (dir) => JSON.parse(readFileSync(join(dir, 'flows.json'), 'utf8'))

// A tiny valid PNG (64x48, white), for the marked-evidence path.
function crc32(buf) {
  let c, crc = 0xffffffff
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c }
  return (crc ^ 0xffffffff) >>> 0
}
function pngB64(w = 64, h = 48) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h, 255); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}

test('an id with no flow, an empty selection and an unsaved target are errors, never a green run', () => {
  const { dir } = task()
  flow(dir, 'A')
  let r = run([dir, '--cases', 'A,B'])
  assert.equal(r.code, 2); assert.deepEqual(r.json.missing, ['B'])
  assert.equal(run([dir, '--cases', 'A']).code, 0)
  r = run([dir, '--cases', 'A', '--failed'])
  assert.equal(r.code, 2); assert.match(r.json.error, /nothing to run/)
  r = run([dir, '--cases', 'A', '--target', 'dev'])
  assert.equal(r.code, 2); assert.match(r.json.error, /not saved/)
  r = run([dir, '--cases', 'bad id'])
  assert.equal(r.code, 2); assert.deepEqual(r.json.bad, ['bad id'])
  const empty = task()
  r = run([empty.dir])
  assert.equal(r.code, 2)
})

test('--cases-file runs exactly the listed ids and reports requested', () => {
  const { dir } = task()
  flow(dir, 'A'); flow(dir, 'B'); flow(dir, 'C')
  const f = join(dir, 'scope.json'); writeFileSync(f, JSON.stringify(['A', 'C']))
  const r = run([dir, '--cases-file', f, '--commit', 'be:1'])
  assert.equal(r.code, 0)
  assert.deepEqual(r.json.requested, ['A', 'C'])
  assert.deepEqual(r.json.results.map((x) => x.case), ['A', 'C'])
  assert.equal(manifest(dir).cases.A.commit, 'be:1')
  assert.equal(manifest(dir).cases.B, undefined)
})

test('--ensure-target: saved, copied from another task, built from servers.json, or an error', () => {
  const { root, dir } = task()
  let r = run([dir, '--ensure-target', 'local'])
  assert.equal(r.code, 2)
  writeFileSync(join(dir, 'servers.json'), JSON.stringify({ be: 3302, fe: 3303 }))
  r = run([dir, '--ensure-target', 'local'])
  assert.equal(r.code, 0)
  assert.deepEqual(manifest(dir).targets.local, { BASE_URL: 'http://localhost:3303', API_URL: 'http://localhost:3302' })
  mkdirSync(join(root, '.pipeline', '_regression'), { recursive: true })
  writeFileSync(join(root, '.pipeline', '_regression', 'flows.json'), JSON.stringify({ targets: { dev: { BASE_URL: 'https://dev.example' } } }))
  r = run([dir, '--ensure-target', 'dev'])
  assert.equal(r.code, 0); assert.equal(manifest(dir).targets.dev.BASE_URL, 'https://dev.example')
  r = run([dir, '--ensure-target', 'dev'])
  assert.equal(r.json.source, 'saved')
  r = run([dir, '--ensure-target', 'staging'])
  assert.equal(r.code, 2)
})

const CASES_MD = `# Test cases — T-1
Target: local

## AC → TC
- AC1 — xem đơn: TC1, TC2

## Cases

### TC1 — Xem đơn
- Nguồn: AC1
- Nền tảng: Web
- Bước:
  1. Mở /orders
- Mong đợi: thấy đơn
- Ưu tiên: P1

### TC2 — Duyệt đơn
- Nguồn: AC1
- Nền tảng: Web
- Bước:
  1. Bấm Duyệt
- Mong đợi: đơn chuyển trạng thái
- Ưu tiên: P1
`

test('approved cases → flows marked written → run → status valid → results verified; a new commit invalidates', () => {
  const { dir } = task()
  writeFileSync(join(dir, 'cases.md'), CASES_MD)
  writeFileSync(join(dir, 'ticket.md'), '# T-1\n')
  assert.equal(run([dir, '--mark-written', 'TC1']).code, 2) // no snapshot yet
  assert.equal(cases(['approve', dir]).approved, true)
  flow(dir, 'TC1'); flow(dir, 'TC2')
  assert.equal(run([dir, '--mark-written', 'TC1,TC9']).code, 2) // TC9 is not an approved case
  assert.equal(run([dir, '--mark-written', 'TC1,TC2']).code, 0)
  let st = cases(['status', dir, '--commit', 'be:1'])
  assert.deepEqual(st.cases.map((c) => c.flow), ['fresh', 'fresh'])
  assert.deepEqual(cases(['scope', dir, '--commit', 'be:1']), ['TC1', 'TC2'])
  writeFileSync(join(dir, 'flows.json'), JSON.stringify({ ...manifest(dir), targets: { local: { BASE_URL: 'http://localhost:1' } } }))
  const r = run([dir, '--cases', 'TC1,TC2', '--target', 'local', '--commit', 'be:1'])
  assert.equal(r.code, 0)
  const m = manifest(dir)
  assert.ok(m.cases.TC1.caseRev, 'caseRev kept after a run')
  st = cases(['status', dir, '--commit', 'be:1'])
  assert.deepEqual(st.cases.map((c) => c.result), ['valid', 'valid'])
  assert.deepEqual(cases(['scope', dir, '--commit', 'be:1']), [])
  assert.equal(cases(['results', dir, '--commit', 'be:1']).verdict, 'verified')
  assert.deepEqual(cases(['scope', dir, '--commit', 'be:2']), ['TC1', 'TC2'])
  assert.equal(cases(['results', dir, '--commit', 'be:2']).verdict, 'incomplete')
  // Unknown code under test (no worktree): nothing recorded is reused.
  assert.deepEqual(cases(['scope', dir, '--commit', '']), ['TC1', 'TC2'])
})

test('a failed case keeps its marks; a marked copy is drawn when an engine is available', async () => {
  const { dir } = task()
  writeFileSync(join(dir, 'flows.json'), JSON.stringify({ targets: { local: { BASE_URL: 'http://localhost:1' } } }))
  flow(dir, 'F1', { status: 'FAIL', png: true, shots: ['F1-fail-x.png'], marks: [{ file: 'F1-fail-x.png', box: [4, 4, 20, 10], label: 'Nút bị khoá', expected: 'bật', actual: 'khoá', step: 'x' }] })
  const r = run([dir, '--cases', 'F1', '--target', 'local', '--commit', 'be:1'])
  assert.equal(r.code, 1)
  const c = manifest(dir).cases.F1
  assert.deepEqual(c.marks, [{ label: 'Nút bị khoá', expected: 'bật', actual: 'khoá', step: 'x' }])
  const { annotate } = await import(join(S, 'annotate.mjs'))
  const probe = join(dir, 'probe.png'); writeFileSync(probe, Buffer.from(pngB64(), 'base64'))
  const engine = (await annotate(probe, [{ box: [1, 1, 5, 5], label: 'x' }], { crop: false })).engine
  if (!engine) return // no Chromium and no ffmpeg on this machine: nothing to draw with
  assert.ok(Array.isArray(c.marked) && c.marked.length, 'marked evidence recorded')
  assert.equal(c.marked[0].caption, 'Nút bị khoá')
  assert.ok(c.marked.every((x) => existsSync(join(dir, 'evd', x.file)) || existsSync(join(dir, 'evd', x.file.replace(/\.webp$/, '.png')))))
})
