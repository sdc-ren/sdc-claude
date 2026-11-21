// jira.mjs without Jira: markdown → Atlassian document, rendered HTML → text, the issue as markdown, and the CLI
// checks that run before any browser opens (dry run, key, site, placeholders).
// Run: node --test plugins/tf/tests/jira.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adf, htmlText, issueMarkdown } from '../scripts/jira.mjs'

const J = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'jira.mjs')
const cli = (...a) => spawnSync(process.execPath, [J, ...a], { encoding: 'utf8' })
const task = () => { const root = mkdtempSync(join(tmpdir(), 'tf-jira-')); const dir = join(root, '.pipeline', 'RVD-1'); mkdirSync(dir, { recursive: true }); return dir }
const SITE = ['--site', 'https://acme.atlassian.net']

test('markdown becomes headings, paragraphs with links and bold, lists and a table', () => {
  const doc = adf('## Kết quả\nMôi trường: **local** — [PR](https://github.com/o/r/pull/1)\n\n| ID | Kết quả |\n|---|---|\n| TC1 | PASS |\n- một\n- hai\n<!-- tf:cases -->')
  const types = doc.content.map((n) => n.type)
  assert.deepEqual(types, ['heading', 'paragraph', 'table', 'bulletList'])
  const p = doc.content[1].content
  assert.deepEqual(p[1], { type: 'text', text: 'local', marks: [{ type: 'strong' }] })
  assert.equal(p[3].marks[0].attrs.href, 'https://github.com/o/r/pull/1')
  const rows = doc.content[2].content
  assert.equal(rows.length, 2, 'the |---| line is not a row')
  assert.equal(rows[0].content[0].type, 'tableHeader')
  assert.equal(rows[1].content[1].content[0].content[0].text, 'PASS')
})

test('--mention turns the first @name into a real mention, and refuses a name that is not there', () => {
  const doc = adf('Gửi @Cường Nguyễn: đã sửa.', [{ id: '59fe012bf491f53c4fcb5820', name: 'Cường Nguyễn' }])
  const c = doc.content[0].content
  assert.deepEqual(c.map((n) => n.type), ['text', 'mention', 'text'])
  assert.equal(c[1].attrs.id, '59fe012bf491f53c4fcb5820')
  assert.throws(() => adf('no one here', [{ id: 'abcdef12', name: 'QC' }]), /"@QC" is not in the comment/)
})

test('rendered HTML reads as text; the issue becomes one markdown file', () => {
  assert.equal(htmlText('<p>Bước 1<br/>Bước 2</p><ul><li>a</li><li>b &amp; c</li></ul><a href="https://x/y">spec</a>'), 'Bước 1\nBước 2\n\n- a\n- b & c\nspec (https://x/y)')
  const md = issueMarkdown(
    { key: 'RVD-1', fields: { summary: 'Tạo giải', status: { name: 'QC' }, issuetype: { name: 'Bug' }, attachment: [{ filename: 's.png', mimeType: 'image/png', size: 2048, id: '9' }] }, renderedFields: { description: '<p>Mô tả</p>' } },
    [{ id: '11196', author: { displayName: 'Hiền' }, created: '2026-11-21T03:04:05.000+0700', renderedBody: '<p>L1 lỗi</p>' }])
  assert.match(md, /^# RVD-1 — Tạo giải/)
  assert.match(md, /Status: QC · Type: Bug/)
  assert.match(md, /- s\.png \(image\/png, 2 KB, 9\)/)
  assert.match(md, /### 11196 · Hiền · 2026-11-21 03:04\n\nL1 lỗi/)
})

test('comment without --confirm is a dry run: nothing opens, the text is shown', () => {
  const dir = task()
  writeFileSync(join(dir, 'c.md'), 'Kết quả: **PASS**\n')
  const r = cli('comment', dir, 'RVD-1', '--file', join(dir, 'c.md'), ...SITE)
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.dryRun, true); assert.equal(out.key, 'RVD-1'); assert.match(out.text, /Kết quả: PASS/)
})

test('bad key, bad site, leftover <evd:…> placeholders and bad ids are refused before any browser', () => {
  const dir = task()
  writeFileSync(join(dir, 'c.md'), 'Ảnh: <evd:TC1-after.webp>\n')
  const c = (...a) => cli('comment', dir, ...a)
  assert.match(c('rvd-1', '--file', join(dir, 'c.md'), ...SITE).stderr, /not an issue key/)
  assert.match(c('RVD-1', '--file', join(dir, 'c.md'), '--site', 'http://acme.atlassian.net').stderr, /plain https origin/)
  assert.match(c('RVD-1', '--file', join(dir, 'c.md'), '--site', 'https://acme.atlassian.net/rest?x=1').stderr, /plain https origin/)
  assert.match(c('RVD-1', '--file', join(dir, 'c.md'), ...SITE).stderr, /<evd:FILE> placeholders/)
  assert.match(c('RVD-1', '--file', join(dir, 'c.md'), ...SITE, '--reply-to', '12; rm').stderr, /--reply-to must be a comment id/)
})
