// /tf:digest — time windows, what counts as read, the transcript, the checkpoint, and the page steps run against
// a stub Zalo Web page (IndexedDB metadata + message frames), no browser.
// Run: node --test tests/digest.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

import { chatSources, classify, coverage, dayStart, digestPath, discussed, mark, namesOf, pageJs, readState, render, windowOf } from '../scripts/zalo.mjs'

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'tf-digest-')))
const TZ = 'Asia/Ho_Chi_Minh'
const H = 3600e3
const NOW = Date.parse('2026-11-15T18:30:00+07:00')
const D15 = Date.parse('2026-11-15T00:00:00+07:00')

test('time windows follow the words people use, in Vietnam time', () => {
  assert.equal(dayStart(2026, 11, 15, TZ), D15)
  const today = windowOf('hôm nay', { now: NOW })
  assert.deepEqual([today.start, today.end, today.label], [D15, NOW, '2026-11-15'])
  const y = windowOf('hôm qua', { now: NOW })
  assert.deepEqual([y.start, y.end, y.label], [D15 - 24 * H, D15, '2026-11-14'])
  assert.deepEqual(windowOf('yesterday', { now: NOW }).start, y.start)
  assert.equal(windowOf('2026-11-10', { now: NOW }).start, Date.parse('2026-11-10T00:00:00+07:00'))
  assert.equal(windowOf('10/11', { now: NOW }).label, '2026-11-10')
  const r = windowOf('12/11..14/11', { now: NOW })
  assert.deepEqual([r.start, r.end], [Date.parse('2026-11-12T00:00:00+07:00'), D15])
  assert.deepEqual([windowOf('6h', { now: NOW }).start, windowOf('3d', { now: NOW }).start], [NOW - 6 * H, NOW - 72 * H])
  // since-last: from the checkpoint, the messages at that exact time excluded; no checkpoint yet → today.
  const s = windowOf('since-last', { now: NOW, checkpoint: { lastT: NOW - 5 * H, lastIds: ['99'] } })
  assert.deepEqual([s.start, s.exclude], [NOW - 5 * H, ['99']])
  assert.equal(windowOf(undefined, { now: NOW }).start, D15)
  assert.throws(() => windowOf('next week', { now: NOW }), /not a time/)
})

// Metadata as the page has it: id = cliMsgId, type = msgType, from = fromUid ("0" = the account itself).
const M = (id, min, type, from) => ({ id: String(id), msgId: `m${id}`, t: D15 + 7 * H + min * 60e3 + (id % 1000), type, from: String(from) })
const META = [
  M(1, 0, 1, 'A'), M(2, 1, 1, 'A'), M(3, 2, 4, 'B'), // a sticker
  M(4, 3, 2, 'A'), M(5, 3, 2, 'A'), M(6, 3, 2, 'A'), // an album of three photos
  M(7, 4, 1, 'B'), M(8, 5, -1909, 'A'), M(9, 60, 1, '0'), M(10, 61, 19, 'B'), // system, me after a pause, a file
]

test('stickers and system notices have no line; an album is one photo frame', () => {
  const cls = classify(META)
  assert.deepEqual(cls.map((m) => m.kind), ['text', 'text', 'sticker', 'photo', 'album', 'album', 'text', 'system', 'text', 'other'])
  assert.equal(cls[3].photos, 3)
  assert.equal(cls[4].head, '4')
  assert.deepEqual(cls.filter((m) => m.frame).map((m) => m.id), ['1', '2', '4', '7', '9', '10'])
})

test('an album read under any of its photos counts; what was not read is listed, never dropped', () => {
  const cls = classify(META)
  const got = { 1: { text: 'a' }, 2: { text: 'b' }, 6: { text: '' }, 7: { text: 'c' } } // the album's frame carries id 6
  const c = coverage(cls, got)
  assert.deepEqual([c.total, c.framed, c.read], [10, 6, 4])
  assert.deepEqual(c.missing.map((m) => m.id), ['9', '10'])
  assert.deepEqual(c.otherTypes, { 19: 1 })
  assert.deepEqual(c.kinds, { text: 4, sticker: 1, photo: 1, album: 2, system: 1, other: 1 })
})

test('the transcript: names by sender id, quotes kept, one line per album, pauses and unread marked', () => {
  const cls = classify(META)
  const got = {
    1: { name: 'Hùng', text: 'Demo đây\nxem thử' }, 2: { name: null, text: 'ok' }, 6: { text: 'màn tạo đơn' },
    7: { name: 'Linh', text: 'Chỗ này lỗi', quote: { who: 'Hùng', what: '[Hình ảnh]' } }, 9: { name: 'Sơn', text: 'chốt nhé' },
  }
  const names = namesOf(cls, got, 'U9', 'vi')
  assert.equal(names.A, 'Hùng')
  assert.equal(names['0'], 'Bạn') // the account itself, whatever name the page shows
  assert.equal(names.U9, 'Bạn')
  assert.deepEqual(render(cls, got, { names, tz: TZ }), [
    '07:00 Hùng: Demo đây / xem thử',
    '07:01 Hùng: ok',
    '07:03 Hùng: [ảnh ×3] màn tạo đơn',
    '07:04 Linh: ↪(Hùng: [Hình ảnh]) Chỗ này lỗi',
    '—',
    '08:00 Bạn: chốt nhé',
    '08:01 Linh: [không đọc được]',
  ])
  assert.equal(render(cls, got, { names: namesOf(cls, got, null, 'en'), tz: TZ, lang: 'en' })[2], '07:03 Hùng: [photo ×3] màn tạo đơn')
})

test('photos worth a look are the ones people answered', () => {
  const meta = [M(1, 0, 2, 'A'), M(2, 1, 1, 'B'), M(3, 2, 1, 'B'), M(4, 30, 2, 'A'), M(5, 50, 1, 'A')]
  const got = { 1: {}, 2: { text: 'lỗi', quote: { who: 'A', what: '[Hình ảnh]' } }, 3: { text: 'ừ' }, 4: {}, 5: { text: 'tiếp' } }
  assert.deepEqual(discussed(classify(meta), got).map((p) => p.id), ['1'])
})

test('chat sources come from the workspace config, keyed by conversation id', () => {
  const r = tmp()
  mkdirSync(join(r, '.claude'))
  writeFileSync(join(r, '.claude', 'task-flow.md'), '## Sources\n- x: y\n\n## Chat sources\n- NhatLinh: zalo g1705741417791397411 — 8fix; demo feedback\n- Kho: zalo `g 123456789` \n- <name>: zalo <conversation id>\n\n## Other\n')
  assert.deepEqual(chatSources(r), [
    { name: 'NhatLinh', app: 'zalo', conv: 'g1705741417791397411', about: '8fix; demo feedback' },
    { name: 'Kho', app: 'zalo', conv: 'g123456789', about: '' },
  ])
  assert.deepEqual(chatSources(tmp()), [])
})

test('the checkpoint only moves forward, for one account, after the file is written', () => {
  const r = tmp()
  assert.deepEqual(readState(r), { account: null, convs: {} })
  mark(r, { account: 'A1', conv: 'g1', name: 'NhatLinh', lastT: 200, lastIds: ['m9'], file: 'x.md' })
  assert.equal(readState(r).convs.g1.lastT, 200)
  assert.equal(mark(r, { account: 'A1', conv: 'g1', lastT: 100 }).skipped, true)
  assert.equal(readState(r).convs.g1.lastT, 200)
  assert.throws(() => mark(r, { account: 'B2', conv: 'g1', lastT: 300 }), /another|belongs/)
  assert.throws(() => mark(r, { account: 'A1', conv: 'g1' }), /lastT/)
  assert.equal(digestPath(r, 'Nhật Linh', '2026-11-15'), join(r, '.pipeline', 'digest', 'nhat-linh', '2026-11-15.md'))
})

// ── the page steps, against a stub chat.zalo.me ─────────────────────────────────────────────────────────────

function stubPage(rows, frames) {
  const el = (cls, text = '', kids = {}) => ({ className: cls, innerText: text, textContent: text, querySelector: (s) => kids[s] || null, querySelectorAll: () => [], cloneNode() { return this } })
  const sc = { scrollTop: 400, scrollHeight: 800, clientHeight: 400 }
  const frameEls = frames.map((f) => {
    const kids = {}
    if (f.name) kids['.message-sender-name-content'] = el('n', f.name)
    if (f.text != null) kids['.text-message__container'] = el('t', f.text)
    if (f.quote) kids['.message-quote-fragment__container'] = el('q', '', { '.message-quote-fragment__title': el('', f.quote.who), '.message-quote-fragment__description': el('', f.quote.what) })
    const fr = el('chat-message', f.text || '', kids)
    fr.querySelectorAll = () => []
    return { id: f.domId, closest: () => fr }
  })
  const store = { index: () => ({ getAll: () => { const r = {}; setTimeout(() => { r.result = rows; r.onsuccess() }); return r } }) }
  const db = { transaction: () => ({ objectStore: () => store }), close() {} }
  const window = {}
  const ctx = {
    window, setTimeout, Date, Math, JSON, Object, Array, Set, Map, String, Number, Promise, Intl, RegExp, Infinity,
    IDBKeyRange: { bound: (a, b) => [a, b] },
    indexedDB: { databases: async () => [{ name: 'zdb_777' }], open: () => { const r = {}; setTimeout(() => { r.result = db; r.onsuccess() }); return r } },
    document: {
      title: 'Zalo', querySelectorAll: (s) => (s.startsWith('[id^="bb_msg_id_"]') ? frameEls : s === '.zl-modal' ? [] : []),
      getElementById: (id) => (id === 'messageViewScroll' ? { parentElement: sc } : id === 'conversationList' ? {} : null),
    },
    getComputedStyle: () => ({ overflowY: 'scroll' }), innerWidth: 1000, innerHeight: 800,
  }
  ctx.window = ctx
  return vm.createContext(ctx)
}

test('the page steps read a conversation end to end: count, read, transcript', async () => {
  const at = (min) => D15 + 9 * H + min * 60e3
  const rows = [
    { cliMsgId: 50, msgId: 950, sendDttm: String(at(-600)), msgType: 1, fromUid: 'A', toUid: 'g1' }, // before the window
    { cliMsgId: 51, msgId: 951, sendDttm: String(at(0)), msgType: 1, fromUid: 'A', toUid: 'g1' },
    { cliMsgId: 52, msgId: 952, sendDttm: String(at(1)), msgType: 4, fromUid: 'B', toUid: 'g1' },
    { cliMsgId: 53, msgId: 953, sendDttm: String(at(2)), msgType: 2, fromUid: 'B', toUid: 'g1' },
    { cliMsgId: 54, msgId: 954, sendDttm: String(at(2) + 40), msgType: 2, fromUid: 'B', toUid: 'g1' },
    { cliMsgId: 55, msgId: 955, sendDttm: String(at(3)), msgType: 1, fromUid: '0', toUid: 'g1' },
  ]
  const frames = [
    { domId: 'bb_msg_id_50', name: 'Hùng', text: 'hôm trước' },
    { domId: 'bb_msg_id_51', name: 'Hùng', text: 'Bản demo mới' },
    { domId: 'bb_msg_id_52', name: 'Linh' },
    { domId: 'bb_msg_id_54_777_g1', name: 'Linh' }, // an album's frame, under its second photo
    { domId: 'bb_msg_id_55', text: 'ok chốt', quote: { who: 'Linh', what: '[Hình ảnh]' } },
  ]
  const page = stubPage(rows, frames)
  assert.equal(vm.runInContext(pageJs('setup'), page), 'tf zalo reader ready')
  // Results cross from the page's realm: compare them as plain data.
  const run = async (step, args) => JSON.parse(JSON.stringify(await vm.runInContext(`(async () => ${pageJs(step, args)})()`, page)))
  assert.deepEqual(await run('account'), { ok: true, account: '777', title: 'Zalo' })
  const meta = await run('meta', { conv: 'g 1', start: at(0), end: at(60) })
  assert.deepEqual([meta.total, meta.framed, meta.cached], [5, 3, 6])
  const c = await run('collect', { conv: 'g1', budgetMs: 2000 })
  assert.deepEqual([c.done, c.read, c.of, c.reachedStart], [true, 3, 3, true])
  const l = await run('lines', { conv: 'g1', tz: TZ })
  assert.deepEqual(l.lines, ['09:00 Hùng: Bản demo mới', '09:02 Linh: [ảnh ×2]', '09:03 Bạn: ↪(Linh: [Hình ảnh]) ok chốt'])
  assert.equal(l.coverage.read, 3)
  assert.equal(l.lastIds[0], '955')
  assert.deepEqual(l.names.sort(), ['Bạn', 'Hùng', 'Linh'])
  assert.deepEqual(await run('clear', {}), { ok: true })
  assert.equal(vm.runInContext('typeof window.__tfzRun', page), 'undefined')
})

test('each step is a one-line call once set up, and stands alone when asked', () => {
  assert.doesNotThrow(() => new Function(pageJs('setup')))
  assert.match(pageJs('lines', { conv: 'g1' }), /^await \(window\.__tfzRun \? window\.__tfzRun\("lines"/)
  assert.ok(!pageJs('lines', { conv: 'g1' }).includes('\n'))
  assert.doesNotThrow(() => new Function(`return (async () => { ${pageJs('collect', { conv: 'g1' }, { standalone: true })} })`))
  assert.throws(() => pageJs('send'), /unknown step/)
  assert.ok(pageJs('setup').length < 15000)
})
