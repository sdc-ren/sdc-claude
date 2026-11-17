// What a /tf:* command accepts: any link, plain words, a key — and the task folder each one maps to.
// Run: node --test tests/sources.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { cookieSentTo, refreshedSession } from '../scripts/browser.mjs'
import { classify, configSources, strictKey } from '../scripts/sources.mjs'
import { slugFor, slugFromText } from '../scripts/task.mjs'

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'tf-src-')))

test('a key in the user\'s words is a key only when it looks like one', () => {
  assert.equal(strictKey('PROJ-301'), 'PROJ-301')
  assert.equal(strictKey('proj-301'), 'PROJ-301') // the whole input is a key
  assert.equal(strictKey('làm PROJ-12 phần header'), 'PROJ-12')
  assert.equal(strictKey('fix utf-8 encoding'), null)
  assert.equal(strictKey('fix UTF-8 encoding'), null)
  assert.equal(strictKey('dates as ISO-8601'), null)
  assert.equal(strictKey('làm proj-12 phần header'), null) // lowercase inside words: not a key…
  assert.equal(strictKey('làm proj-12 phần header', ['PROJ']), 'PROJ-12') // …unless the config lists the prefix
})

test('links are sorted by what they are and how to read them', () => {
  const r = tmp()
  const c = classify(r, 'dựng màn đặt lịch theo https://www.notion.so/a/Spec-123 và https://claude.ai/artifact/J1vh43YkirYZdRj5r1sZFu, xem https://acme.atlassian.net/browse/OPS-77 https://www.figma.com/design/AbC/x https://github.com/o/r/pull/5 https://github.com/o/web/issues/9 https://example.com/page')
  assert.deepEqual(c.sources.map((s) => s.kind), ['doc', 'artifact', 'tracker', 'figma', 'pr', 'issue', 'url'])
  assert.equal(c.key, 'OPS-77')
  assert.equal(c.hasTracker, true)
  assert.equal(c.request, 'dựng màn đặt lịch theo và xem')
  assert.equal(c.sources[1].id, 'J1vh43YkirYZdRj5r1sZFu')
  assert.equal(c.sources[5].key, 'GH-WEB-9')
})

test('plain words alone are a task with no sources', () => {
  const c = classify(tmp(), 'thêm nút xuất Excel cho báo cáo doanh thu')
  assert.deepEqual(c.sources, [])
  assert.equal(c.hasTracker, false)
  assert.equal(c.request, 'thêm nút xuất Excel cho báo cáo doanh thu')
})

test('the workspace config names trackers and their keys', () => {
  const r = tmp()
  mkdirSync(join(r, '.claude'))
  writeFileSync(join(r, '.claude', 'task-flow.md'), '# cfg\n\n## Sources\n- yt: https://yt.acme.io — tracker — browser.mjs auth yt — keys: ACME\n- wiki: wiki.acme.io — docs — public fetch\n\n## Other\n- x\n')
  const cfg = configSources(r)
  assert.deepEqual(cfg.keys, ['ACME'])
  assert.deepEqual(cfg.hosts.map((h) => [h.host, h.tracker]), [['yt.acme.io', true], ['wiki.acme.io', false]])
  const c = classify(r, 'https://yt.acme.io/x/ACME-5 https://wiki.acme.io/page acme-9 nữa')
  assert.deepEqual(c.sources.map((s) => s.kind), ['tracker', 'tracker', 'url'])
  assert.equal(c.key, 'ACME-9')
  // The old section name still works.
  writeFileSync(join(r, '.claude', 'task-flow.md'), '## Tracker and spec sources\n- Ticket tracker: https://jira.acme.io — browser\n')
  assert.equal(classify(r, 'https://jira.acme.io/some/page').sources[0].kind, 'tracker')
})

test('a local file the user points at is a source', () => {
  const r = tmp()
  writeFileSync(join(r, 'spec.md'), '# spec')
  const c = classify(r, 'làm theo ./spec.md nhé')
  assert.deepEqual(c.sources.map((s) => [s.kind, s.ref]), [['file', join(r, 'spec.md')]])
})

test('every input maps to a stable, readable folder name', () => {
  const r = tmp()
  assert.equal(slugFor(r, 'PROJ-301'), 'PROJ-301')
  assert.equal(slugFor(r, 'fix utf-8 encoding in export'), 'fix-utf-8-encoding-export')
  assert.equal(slugFor(r, 'tôi muốn dựng demo màn hình đặt lịch cho khách xem'), 'dung-demo-man-hinh-dat')
  assert.equal(slugFor(r, 'https://linear.app/acme/issue/ENG-42/login'), 'ENG-42')
  const notion = slugFor(r, 'https://www.notion.so/team/Checkout-redesign-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d')
  assert.match(notion, /^notion-checkout-redesign-[0-9a-f]{6}$/)
  assert.equal(slugFor(r, 'https://www.notion.so/team/Checkout-redesign-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'), notion)
  assert.notEqual(slugFor(r, 'https://www.notion.so/team/Other-page'), notion)
  assert.equal(slugFor(r, 'https://claude.ai/artifact/J1vh43YkirYZdRj5r1sZFu'), 'artifact-j1vh43yk')
  assert.equal(slugFor(r, 'anything', '8fix · Màn hình mới theo vai trò'), '8fix-man-hinh-moi-theo')
  assert.equal(slugFor(r, 'anything', 'OPS-3'), 'OPS-3')
  // The slug typed back resolves to the same folder.
  assert.equal(slugFromText('dung-demo-man-hinh-dat'), 'dung-demo-man-hinh-dat')
})

test('a saved login is refreshed from the browser that used it, unless the session was lost', () => {
  const ck = (domain, value) => ({ name: 's', value, domain, path: '/', expires: 2e9 })
  const saved = { cookies: [ck('.atlassian.net', 'old'), ck('acme.atlassian.net', 'old')], origins: [{ origin: 'https://acme.atlassian.net', localStorage: [] }] }
  const used = {
    cookies: [ck('.atlassian.net', 'new'), ck('acme.atlassian.net', 'new'), ck('dev.app.test', 'x')],
    origins: [{ origin: 'https://acme.atlassian.net', localStorage: [{ name: 'k', value: 'v' }] }, { origin: 'https://dev.app.test', localStorage: [] }],
  }
  const next = refreshedSession(saved, used, ['https://acme.atlassian.net/browse/PROJ-1'])
  assert.deepEqual(next.cookies.map((c) => `${c.domain}=${c.value}`), ['.atlassian.net=new', 'acme.atlassian.net=new'], 'rotated cookies kept, other sites dropped')
  assert.deepEqual(next.origins.map((o) => o.origin), ['https://acme.atlassian.net'])
  assert.equal(refreshedSession(saved, used, ['https://id.atlassian.com/login?continue=x']), null, 'on a login page: keep the old file')
  assert.equal(refreshedSession(saved, { cookies: [ck('.atlassian.net', 'new')], origins: [] }, []), null, 'a cookie domain went missing: keep the old file')
  assert.equal(refreshedSession(saved, { cookies: [], origins: [] }, []), null)
})

test('a cookie belongs to a site only at a domain boundary', () => {
  assert.ok(cookieSentTo('acme.atlassian.net', 'acme.atlassian.net'))
  assert.ok(cookieSentTo('.atlassian.net', 'acme.atlassian.net'))
  assert.ok(cookieSentTo('.example.co.uk', 'app.example.co.uk'))
  assert.ok(!cookieSentTo('.example.com', 'notexample.com'), 'a longer name that merely ends the same is another site')
  assert.ok(!cookieSentTo('.co.uk', 'example.com'))
  assert.ok(!cookieSentTo('other.atlassian.net', 'acme.atlassian.net'))
})
