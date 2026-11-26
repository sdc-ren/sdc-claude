#!/usr/bin/env node
// tf: read a Zalo Web conversation of the user's own account, for /tf:digest (docs/digest.md).
//
// Zalo Web keeps message metadata in the page's IndexedDB (`zdb_<account uid>`, store `message`): conversation
// (`toUid`, groups are `g<digits>`), sender (`fromUid`, "0" = the account itself), time (`sendDttm`, ms), type
// (`msgType`) and ids. The text itself is encrypted there, so it is read from the open conversation's page, where
// each message is `[id="bb_msg_id_<cliMsgId>"]` — the same id as the metadata. This script never decrypts
// anything and never calls Zalo's servers: it only reads what the page already shows, in the user's own Chrome.
//
//   window <when> [--tz Asia/Ho_Chi_Minh] [--root <cwd> --conv <id>]
//       when: today | yesterday | hôm nay | hôm qua | YYYY-MM-DD | DD/MM[/YYYY] | <from>..<to> (dates) |
//             <n>h | <n>d (the last n hours/days) | since-last (from the checkpoint of --conv; none → today)
//       → { start, end, label, tz, exclude[] }
//   js <step> '<json args>'   → JavaScript for Claude in Chrome's javascript_tool, run in the chat.zalo.me tab
//       steps: setup (once per page load; the others are then one-line calls) · account · find {name} · open {conv} · meta {conv,start,end} · collect {conv,budgetMs?} ·
//              lines {conv,from?,count?,lang?,tz?} · seek {conv,id,frameWidth?} · clear
//   config <root>             → the `## Chat sources` lines of <root>/.claude/task-flow.md
//   state <root>              → the checkpoint (.pipeline/digest/state.json)
//   mark <root> '<json>'      → record a finished digest: {account, conv, name, lastT, lastIds, file}
//   path <root> <name> <label> → where the digest file goes
//
//   import { windowOf, classify, render, coverage, discussed, chatSources } from './zalo.mjs'
import { configPath } from '../core/paths.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TZ = 'Asia/Ho_Chi_Minh'
const DAY = 86400e3

// ── time windows ────────────────────────────────────────────────────────────────────────────────────────────

const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').trim()

// The UTC offset (ms) of a time zone at a moment.
function offsetAt(tz, t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, +x.value]))
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000
}
// Midnight of a calendar day in a time zone.
export function dayStart(y, m, d, tz = TZ) {
  const guess = Date.UTC(y, m - 1, d)
  const t = guess - offsetAt(tz, guess)
  return guess - offsetAt(tz, t)
}
export function ymd(t, tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t))
}
const startOf = (t, tz) => { const [y, m, d] = ymd(t, tz).split('-').map(Number); return dayStart(y, m, d, tz) }
function dateOf(s, now, tz) {
  let m = String(s).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return dayStart(+m[1], +m[2], +m[3], tz)
  m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/)
  if (m) { const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : +ymd(now, tz).slice(0, 4); return dayStart(y, +m[2], +m[1], tz) }
  const w = fold(s)
  if (/^(today|hom nay|nay)$/.test(w)) return startOf(now, tz)
  if (/^(yesterday|hom qua|qua)$/.test(w)) return startOf(startOf(now, tz) - 1, tz)
  return null
}

// What part of the conversation to read. `checkpoint` = { lastT, lastIds } of the last digest of this conversation.
export function windowOf(when, { now = Date.now(), tz = TZ, checkpoint = null } = {}) {
  const w = fold(when || 'since-last')
  const out = (start, end, label, exclude = []) => ({ start, end: Math.min(end, now), label, tz, exclude })
  if (/^(since-last|tu lan truoc|moi)$/.test(w)) {
    if (checkpoint && checkpoint.lastT) return out(checkpoint.lastT, now, `since-${ymd(checkpoint.lastT, tz)}`, checkpoint.lastIds || [])
    const s = startOf(now, tz)
    return out(s, s + DAY, ymd(s, tz))
  }
  let m = w.match(/^(\d{1,3})\s*(h|gio|d|ngay)$/)
  if (m) { const ms = +m[1] * (/^(h|gio)$/.test(m[2]) ? 3600e3 : DAY); return out(now - ms, now, `last-${m[1]}${m[2][0]}`) }
  m = String(when).split('..')
  if (m.length === 2) {
    const a = dateOf(m[0], now, tz), b = dateOf(m[1], now, tz)
    if (a == null || b == null || b < a) throw new Error(`not a date range: ${when}`)
    return out(a, startOf(b + DAY + 3600e3, tz), `${ymd(a, tz)}..${ymd(b, tz)}`)
  }
  const a = dateOf(when, now, tz)
  if (a == null) throw new Error(`not a time: ${when} (today, yesterday, YYYY-MM-DD, DD/MM, A..B, 6h, 3d, since-last)`)
  return out(a, startOf(a + DAY + 3600e3, tz), ymd(a, tz))
}

// ── messages (shared with the page: these functions are sent to it as source, so they use nothing outside) ──

// meta: [{ id (cliMsgId), msgId, t, type, from }] sorted by time → each with `kind` and whether it has a frame
// of its own on the page. Photos sent together are one album: one frame, the others ride on it.
export function classify(meta) {
  const out = []
  let album = null
  for (const m of meta) {
    const type = +m.type
    let kind = type === 1 ? 'text' : type === 2 ? 'photo' : type === 4 ? 'sticker' : type < 0 ? 'system' : 'other'
    if (kind === 'photo' && album && album.from === m.from && m.t - album.t <= 3000) { kind = 'album'; album.n++; album.t = m.t; album.ids.push(m.id) } else if (kind === 'photo') album = { from: m.from, t: m.t, n: 1, ids: [m.id], head: m.id }
    else album = null
    const rec = { ...m, type, kind, frame: kind === 'text' || kind === 'photo' || kind === 'other' }
    if (kind === 'photo') rec.album = album
    if (kind === 'album') rec.head = album.head
    out.push(rec)
  }
  for (const r of out) if (r.album) { r.photos = r.album.n; delete r.album }
  return out
}

// An album's frame on the page carries the id of one of its photos, not always the first: a frame read under
// any member counts for the whole album.
export function credited(cls, got) {
  const out = { ...got }
  for (const m of cls) if (m.kind === 'album' && got[m.id] && !out[m.head]) out[m.head] = got[m.id]
  return out
}

// Who wrote what: the page shows a sender's name only on the first message of a run, so names come from those
// and are keyed by sender id, never by position.
export function namesOf(cls, got, me, lang = 'vi') {
  const names = {}
  for (const m of cls) { const g = got[m.id]; if (g && g.name && !names[m.from]) names[m.from] = g.name }
  const you = lang === 'vi' ? 'Bạn' : 'You'
  names['0'] = you
  if (me) names[String(me)] = you
  return names
}

const hhmm = (t, tz) => new Date(t).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })

// The transcript Claude reads: one line per message, stickers and system notices left out, photos as one line
// per album, quotes kept so a reply carries what it answers. A message that has a frame but was not read is
// marked, never dropped.
export function render(cls, got, { names = {}, tz = 'Asia/Ho_Chi_Minh', lang = 'vi', gapMin = 45 } = {}) {
  got = credited(cls, got)
  const vi = lang === 'vi'
  const L = { photo: vi ? 'ảnh' : 'photo', unread: vi ? 'không đọc được' : 'not read', other: vi ? 'loại' : 'type' }
  const lines = []
  let prev = 0
  for (const m of cls) {
    if (!m.frame) continue
    if (prev && m.t - prev > gapMin * 60e3) lines.push('—')
    prev = m.t
    const who = names[m.from] || `u${String(m.from).slice(-4)}`
    const g = got[m.id]
    const head = `${hhmm(m.t, tz)} ${who}:`
    if (!g) { lines.push(`${head} [${m.kind === 'photo' ? L.photo + (m.photos > 1 ? ' ×' + m.photos : '') + ', ' : ''}${L.unread}]`); continue }
    const one = (s) => String(s || '').replace(/\s*\n+\s*/g, ' / ').trim()
    const q = g.quote && (g.quote.who || g.quote.what) ? ` ↪(${one(g.quote.who)}: ${one(g.quote.what).slice(0, 90)})` : ''
    let body = one(g.text)
    if (m.kind === 'photo') body = `[${L.photo}${m.photos > 1 ? ' ×' + m.photos : ''}]${body ? ' ' + body : ''}`
    else if (m.kind === 'other') body = `[${L.other} ${m.type}${g.kinds && g.kinds.length ? ': ' + g.kinds.join(' ') : ''}]${body || g.other ? ' ' + (body || one(g.other).slice(0, 200)) : ''}`
    lines.push(`${head}${q} ${body}`.replace(/\s+$/, ''))
  }
  return lines
}

// How much of the window was read. `missing` lists messages that have a frame and were not read.
export function coverage(cls, got) {
  got = credited(cls, got)
  const by = {}
  for (const m of cls) by[m.kind] = (by[m.kind] || 0) + 1
  const framed = cls.filter((m) => m.frame)
  const missing = framed.filter((m) => !got[m.id]).map((m) => ({ id: m.id, t: m.t, kind: m.kind, type: m.type }))
  const otherTypes = {}
  for (const m of cls) if (m.kind === 'other') otherTypes[m.type] = (otherTypes[m.type] || 0) + 1
  const t = cls.map((m) => m.t)
  return { total: cls.length, kinds: by, framed: framed.length, read: framed.length - missing.length, missing, otherTypes, first: t.length ? Math.min(...t) : null, last: t.length ? Math.max(...t) : null, senders: [...new Set(cls.map((m) => m.from))].length }
}

// Photos people talked about: replied to by quote, or followed by someone else's message within a few minutes
// while the sender also wrote about it. Those are worth looking at; the rest stay "[photo]".
export function discussed(cls, got, { max = 8, windowMin = 10 } = {}) {
  got = credited(cls, got)
  const photos = cls.filter((m) => m.kind === 'photo')
  const score = []
  for (const p of photos) {
    let s = 0
    const after = cls.filter((m) => m.t > p.t && m.t - p.t <= windowMin * 60e3 && m.kind === 'text')
    for (const m of after) {
      const g = got[m.id]
      if (!g) continue
      if (g.quote && /h[iì]nh\s*[aả]nh|\[ảnh\]|photo|image/i.test(String(g.quote.what || '')) && m.from !== p.from) s += 3
      else if (m.from !== p.from && s < 3) s += 1
    }
    if (got[p.id] && String(got[p.id].text || '').trim()) s += 1
    if (s >= 2) score.push({ id: p.id, t: p.t, from: p.from, photos: p.photos || 1, score: s })
  }
  return score.sort((a, b) => b.score - a.score || a.t - b.t).slice(0, max).sort((a, b) => a.t - b.t)
}

// ── the page side ───────────────────────────────────────────────────────────────────────────────────────────
// Each step is the body of an async function run in the chat.zalo.me tab with `A` = its args. State between
// calls lives in window.__tfz (cleared by `clear`). Every loop stops well inside javascript_tool's 45 s limit.

const PAGE = {
  account: `
    const db = (await indexedDB.databases()).map((d) => d.name).find((n) => /^zdb_\\d+$/.test(n))
    if (!db) return { ok: false, reason: 'not-signed-in' }
    // Zalo Web runs in one tab at a time: another tab (or a long idle) shows a modal with an activate button.
    const modal = [...document.querySelectorAll('.zl-modal')].find((m) => /tab kh[aá]c|another tab/i.test(m.textContent))
    if (modal) return { ok: false, reason: 'inactive-tab', account: db.slice(4), text: modal.textContent.trim().slice(0, 160) }
    if (!document.getElementById('conversationList')) return { ok: false, reason: 'still-loading', account: db.slice(4) }
    return { ok: true, account: db.slice(4), title: document.title }`,

  // The conversation list is virtualized: scroll it top to bottom once and collect every item's id and name.
  find: `
    const list = document.getElementById('conversationList')
    if (!list) return { ok: false, reason: 'no-conversation-list' }
    const sc = [list, list.parentElement, list.parentElement?.parentElement].find((e) => e && e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY)) || list.parentElement
    const want = fold(A.name)
    const seen = new Map()
    const grab = () => { for (const it of list.querySelectorAll('.msg-item[anim-data-id]')) { const n = it.querySelector('.conv-item-title__name'); if (n) seen.set(it.getAttribute('anim-data-id'), n.textContent.trim()) } }
    const top0 = sc.scrollTop; sc.scrollTop = 0; await sleep(300)
    const t0 = Date.now(); let same = 0
    while (Date.now() - t0 < 20000) { grab(); const before = sc.scrollTop; sc.scrollTop += sc.clientHeight * 0.8; await sleep(250); if (sc.scrollTop === before) { if (++same > 2) break } else same = 0 }
    grab(); sc.scrollTop = top0
    // The id is shown as "g 1705…" (a space after the prefix): a bare long id is hidden by some tool outputs.
    const all = [...seen].map(([conv, name]) => ({ conv: conv.replace(/^(\\D*)(\\d+)$/, '$1 $2'), name, group: conv.startsWith('g') }))
    const exact = all.filter((c) => fold(c.name) === want)
    return { ok: true, scanned: all.length, matches: exact.length ? exact : all.filter((c) => fold(c.name).includes(want)).slice(0, 10) }`,

  // Metadata of the window, and the time of every cached message of the conversation (to know where the
  // scroll is). Nothing here is message content.
  meta: `
    const name = (await indexedDB.databases()).map((d) => d.name).find((n) => /^zdb_\\d+$/.test(n))
    if (!name) return { ok: false, reason: 'not-signed-in' }
    const db = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
    const st = db.transaction('message').objectStore('message')
    const rows = await new Promise((ok) => { const r = st.index('userId_sendDttm_msgId').getAll(IDBKeyRange.bound([A.conv], [A.conv, []])); r.onsuccess = () => ok(r.result); r.onerror = () => ok(null) })
      || (await new Promise((ok) => { const r = st.getAll(); r.onsuccess = () => ok(r.result) })).filter((m) => m.toUid === A.conv)
    db.close()
    const all = rows.map((m) => ({ id: String(m.cliMsgId), msgId: String(m.msgId), t: +m.sendDttm, type: +m.msgType, from: String(m.fromUid) })).sort((a, b) => a.t - b.t)
    const ex = new Set(A.exclude || [])
    const win = all.filter((m) => m.t >= A.start && m.t < A.end && !ex.has(m.msgId))
    const T = (window.__tfz ||= {})
    T[A.conv] = { meta: win, times: Object.fromEntries(all.map((m) => [m.id, m.t])), got: {}, start: A.start, end: A.end }
    const cls = classify(win)
    return { ok: true, account: name.slice(4), cached: all.length, cachedFrom: all.length ? all[0].t : null, ...coverage(cls, {}), missing: undefined }`,

  // Open a conversation by clicking its item in the list (scrolled into view first), then check the page shows it.
  open: `
    const list = document.getElementById('conversationList')
    if (!list) return { ok: false, reason: 'no-conversation-list' }
    const sc = [list, list.parentElement, list.parentElement?.parentElement].find((e) => e && e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY)) || list.parentElement
    let it = null; sc.scrollTop = 0; await sleep(250)
    const t0 = Date.now(); let same = 0
    while (!(it = list.querySelector('.msg-item[anim-data-id="' + A.conv + '"]')) && Date.now() - t0 < 15000) { const b = sc.scrollTop; sc.scrollTop += sc.clientHeight * 0.8; await sleep(250); if (sc.scrollTop === b && ++same > 2) break }
    if (!it) return { ok: false, reason: 'not-in-list' }
    it.scrollIntoView({ block: 'center' }); await sleep(200)
    const el = it.querySelector('.conv-item-title__name') || it
    for (const ev of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }))
    await sleep(2500)
    const T = window.__tfz && window.__tfz[A.conv]
    const ids = [...document.querySelectorAll('[id^="bb_msg_id_"]')].map((f) => frameId(f))
    const mine = T ? ids.filter((id) => id in T.times).length : null
    return { ok: ids.length > 0 && (mine === null || mine > 0), frames: ids.length, ofThisConversation: mine, name: el.textContent.trim() }`,

  // Scroll up from where the view is, reading every message frame on the way, until the window is covered.
  collect: `
    const T = window.__tfz && window.__tfz[A.conv]
    if (!T) return { ok: false, reason: 'run meta first' }
    const anchor = document.getElementById('messageViewScroll')
    if (!anchor) return { ok: false, reason: 'no-open-conversation' }
    const sc = anchor.parentElement
    const txt = (e) => (e ? e.innerText.replace(/\\s+\\n/g, '\\n').trim() : '')
    const cls = classify(T.meta)
    const left = () => coverage(cls, T.got).missing.length
    const grab = () => {
      let oldest = Infinity, seen = 0
      for (const f of document.querySelectorAll('[id^="bb_msg_id_"]')) {
        const id = frameId(f)
        if (!(id in T.times)) continue
        seen++; oldest = Math.min(oldest, T.times[id])
        if (T.got[id] || T.times[id] < T.start || T.times[id] >= T.end) continue
        const fr = f.closest('.chat-message') || f
        const name = fr.querySelector('.message-sender-name-content')
        const q = fr.querySelector('.message-quote-fragment__container')
        const body = fr.querySelector('.text-message__container')
        let text = ''
        if (body) { const c = body.cloneNode(true); c.querySelectorAll('.message-quote-fragment__container').forEach((x) => x.remove()); text = txt(c) }
        const kinds = [...new Set([...fr.querySelectorAll('[class]')].flatMap((e) => String(e.className).split(/\\s+/)).filter((c) => /^(img-msg|photo-message|link|file|voice|video|poll|note|card-link|contact|location|gif)/i.test(c)))].slice(0, 6)
        T.got[id] = { name: name ? txt(name) : null, text, quote: q ? { who: txt(q.querySelector('.message-quote-fragment__title')), what: txt(q.querySelector('.message-quote-fragment__description')) } : null, kinds, other: body ? '' : txt(fr.querySelector('.message-action') || fr).slice(0, 300) }
      }
      return { oldest, seen }
    }
    const budget = Math.min(A.budgetMs || 25000, 30000), t0 = Date.now()
    if (!T.started) { sc.scrollTop = sc.scrollHeight; await sleep(1500); T.started = true }
    // The view starts at the newest message and only moves up, so once a message older than the window is on
    // screen every message of the window has been on screen too.
    let top = 0, r = grab(), steps = 0
    while (Date.now() - t0 < budget && r.oldest >= T.start && left() > 0) {
      if (sc.scrollTop <= 0) { if (++top > 6) break } else top = 0
      sc.scrollTop = Math.max(0, sc.scrollTop - 250); steps++
      await sleep(top ? 900 : 450)
      r = grab()
    }
    const cov = coverage(cls, T.got)
    const reachedStart = r.oldest < T.start
    return { ok: true, done: !cov.missing.length || reachedStart || top > 6, read: cov.read, of: cov.framed, reachedStart, atTop: top > 6, steps, secs: Math.round((Date.now() - t0) / 1000) }`,

  // The transcript, a page at a time, with how much was read and the photos worth a look.
  lines: `
    const T = window.__tfz && window.__tfz[A.conv]
    if (!T) return { ok: false, reason: 'run meta first' }
    const cls = classify(T.meta)
    const me = ((await indexedDB.databases()).map((d) => d.name).find((n) => /^zdb_\\d+$/.test(n)) || '').slice(4)
    const names = namesOf(cls, T.got, me, A.lang || 'vi')
    const all = render(cls, T.got, { names, tz: A.tz || 'Asia/Ho_Chi_Minh', lang: A.lang || 'vi' })
    const from = A.from || 0, count = A.count || 120
    const cov = coverage(cls, T.got)
    const last = T.meta.length ? T.meta[T.meta.length - 1].t : null
    return { ok: true, total: all.length, from, lines: all.slice(from, from + count), more: from + count < all.length,
      ...(from ? {} : { coverage: { ...cov, missing: cov.missing.slice(0, 20) }, names: [...new Set(Object.values(names))], discussed: discussed(cls, T.got).map((p) => ({ ...p, who: names[p.from] || p.from })), lastT: last, lastIds: T.meta.filter((m) => m.t === last).map((m) => m.msgId) }) }`,

  // Bring one message (a photo) on screen and say where it is, for a zoomed screenshot.
  seek: `
    const T = window.__tfz && window.__tfz[A.conv]
    if (!T || !(A.id in T.times)) return { ok: false, reason: 'unknown message' }
    const sc = document.getElementById('messageViewScroll')?.parentElement
    if (!sc) return { ok: false, reason: 'no-open-conversation' }
    const want = T.times[A.id], t0 = Date.now()
    let el
    while (!(el = document.querySelector('[id="bb_msg_id_' + A.id + '"],[id^="bb_msg_id_' + A.id + '_"]')) && Date.now() - t0 < 20000) {
      const ts = [...document.querySelectorAll('[id^="bb_msg_id_"]')].map((f) => T.times[frameId(f)]).filter(Boolean)
      const down = ts.length && want > Math.max(...ts)
      const b = sc.scrollTop
      sc.scrollTop = down ? sc.scrollTop + 250 : Math.max(0, sc.scrollTop - 250)
      await sleep(400)
      if (sc.scrollTop === b) break
    }
    if (!el) return { ok: false, reason: 'not-found' }
    const fr = el.closest('.chat-message') || el
    fr.scrollIntoView({ block: 'center' }); await sleep(800)
    // The photos' box (not the whole row), in the screenshot's coordinate frame when its width is given.
    const boxes = [...fr.querySelectorAll('img.zimg-el')].map((i) => i.getBoundingClientRect())
    const rs = boxes.length ? boxes : [fr.getBoundingClientRect()]
    const k = A.frameWidth ? A.frameWidth / innerWidth : 1
    const rect = [Math.min(...rs.map((r) => r.left)), Math.min(...rs.map((r) => r.top)), Math.max(...rs.map((r) => r.right)), Math.max(...rs.map((r) => r.bottom))]
      .map((v, i) => Math.round(Math.max(0, Math.min(v, i % 2 ? innerHeight : innerWidth)) * k))
    return { ok: true, rect, photos: boxes.length }`,

  clear: `delete window.__tfz; delete window.__tfzRun; return { ok: true }`,
}

const SHARED = [classify, credited, namesOf, render, coverage, discussed]

const helpers = () => [
  'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))',
  // A frame is bb_msg_id_<cliMsgId>, or bb_msg_id_<cliMsgId>_<photo group>_<conversation> for an album.
  'const frameId = (f) => f.id.slice(10).split(\'_\')[0]',
  `const fold = ${fold.toString()}`,
  `const hhmm = ${hhmm.toString()}`,
  ...SHARED.map((f) => f.toString()),
].join('\n')

// `setup` installs every step in the page once (window.__tfzRun); after it each step is a one-line call, so the
// long code is sent to the tab once per run, not once per step. `pageJs(step, args, { standalone: true })`
// gives a self-contained snippet instead.
export function pageJs(step, args = {}, { standalone = false } = {}) {
  if (step === 'setup') {
    const steps = Object.entries(PAGE).map(([k, body]) => `${JSON.stringify(k)}: async (A) => {\n${body}\n}`).join(',\n')
    const code = `window.__tfzRun = (() => {\n${helpers()}\nconst S = {\n${steps}\n}\nreturn (step, A = {}) => S[step]({ ...A, conv: A.conv && String(A.conv).replace(/\\s+/g, '') })\n})(); 'tf zalo reader ready'`
    // Sent as a tool argument: drop comment lines, indentation and blank lines.
    return code.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).join('\n')
  }
  if (!PAGE[step]) throw new Error(`unknown step: ${step} (setup, ${Object.keys(PAGE).join(', ')})`)
  if (standalone) return `await (async (A) => {\n${helpers()}\n${PAGE[step]}\n})(${JSON.stringify(args)})`
  return `await (window.__tfzRun ? window.__tfzRun(${JSON.stringify(step)}, ${JSON.stringify(args)}) : { ok: false, reason: 'run setup first' })`
}

// ── workspace side: which chats, checkpoint, files ──────────────────────────────────────────────────────────

// `## Chat sources` of <root>/.claude/task-flow.md:
//   - <name>: zalo <conversation id> [— <what the chat is about, what to watch for>]
export function chatSources(root) {
  const f = configPath(root)
  if (!existsSync(f)) return []
  const sec = readFileSync(f, 'utf8').match(/^##\s+Chat sources\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m)
  if (!sec) return []
  const out = []
  for (const line of sec[1].split('\n')) {
    const m = line.match(/^\s*[-*]\s*([^:]+?)\s*:\s*zalo\s+`?(g?\s?\d{6,})`?\s*(?:[—–-]+\s*(.*))?$/i)
    if (m) out.push({ name: m[1].trim(), app: 'zalo', conv: m[2].replace(/\s+/g, ''), about: (m[3] || '').trim() })
  }
  return out
}

const stateFile = (root) => join(resolve(root || '.'), '.pipeline', 'digest', 'state.json')
export function readState(root) {
  try { return JSON.parse(readFileSync(stateFile(root), 'utf8')) } catch { return { account: null, convs: {} } }
}
// Advance a conversation's checkpoint. Only after the digest file is written, and only forward.
export function mark(root, { account, conv, name, lastT, lastIds = [], file }) {
  if (!conv || !lastT) throw new Error('mark needs conv and lastT')
  const s = readState(root)
  if (s.account && account && s.account !== account) throw new Error(`checkpoint belongs to Zalo account ${s.account}, this page is ${account}`)
  s.account = s.account || account || null
  const prev = s.convs[conv] || {}
  if (prev.lastT && prev.lastT > lastT) return { ...s, skipped: true }
  s.convs[conv] = { name: name || prev.name || conv, lastT, lastIds, file: file || null, at: new Date().toISOString() }
  mkdirSync(join(resolve(root || '.'), '.pipeline', 'digest'), { recursive: true })
  writeFileSync(stateFile(root), JSON.stringify(s, null, 2) + '\n')
  return s
}
export const slugOf = (name) => fold(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'chat'
export const digestPath = (root, name, label) => join(resolve(root || '.'), '.pipeline', 'digest', slugOf(name), `${label}.md`)

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2)
  const flag = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined }
  const pos = rest.filter((x, i) => !x.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')))
  const print = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2))
  try {
    if (cmd === 'window') {
      const root = flag('root'), conv = flag('conv')
      print(windowOf(pos[0], { tz: flag('tz') || TZ, checkpoint: root && conv ? readState(root).convs[conv] : null }))
    } else if (cmd === 'js') print(pageJs(pos[0], pos[1] ? JSON.parse(pos[1]) : {}))
    else if (cmd === 'config') print(chatSources(pos[0]))
    else if (cmd === 'state') print(readState(pos[0]))
    else if (cmd === 'mark') print(mark(pos[0], JSON.parse(pos[1])))
    else if (cmd === 'path') print(digestPath(pos[0], pos[1], pos[2]))
    else { console.error('usage: zalo.mjs window|js|config|state|mark|path … (see the header)'); process.exit(2) }
  } catch (e) { console.error(e.message); process.exit(1) }
}
