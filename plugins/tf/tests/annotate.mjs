// Bug marks on e2e evidence: red box + red label next to the wrong element, close-up crop when small.
// Run: node --test tests/annotate.mjs   (rendering tests skip without Playwright / ffmpeg)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'

import { annotate, annotateAll, cropRect, launch, layout, needsCrop, pngSize } from '../scripts/annotate.mjs'
import { which } from '../scripts/platform.mjs'

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'tf-ann-')))

// ── A minimal valid PNG (RGB, 8 bit) ─────────────────────────────────────────
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(width, height, color = (x, y) => [245, 246, 248]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit RGB
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) raw.set(color(x, y), row + 1 + x * 3)
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const R = ([x, y, w, h]) => ({ x, y, w, h })
const inside = (l, W, H) => l.x >= 0 && l.y >= 0 && l.x + l.w <= W && l.y + l.h <= H

// ── Layout ───────────────────────────────────────────────────────────────────
test('the label sits right above the box when there is room', () => {
  const [p] = layout([{ box: [100, 200, 150, 40], label: 'Sai thứ hạng' }], 800, 600)
  assert.deepEqual(p.box, [100, 200, 150, 40])
  assert.equal(p.label.x, 100)
  assert.equal(p.label.y + p.label.h, 200 - 4)
  assert.deepEqual(p.label.lines, ['Sai thứ hạng'])
})

test('below when the box touches the top, right/left when neither fits', () => {
  const [below] = layout([{ box: [100, 0, 150, 40], label: 'Ở trên cùng' }], 800, 600)
  assert.equal(below.label.y, 44)
  const [right] = layout([{ box: [10, 0, 100, 600], label: 'Cột cao' }], 800, 600)
  assert.equal(right.label.x, 114)
  assert.ok(inside(right.label, 800, 600))
  const [left] = layout([{ box: [700, 0, 100, 600], label: 'Cột phải' }], 800, 600)
  assert.equal(left.label.x + left.label.w, 696)
  assert.ok(inside(left.label, 800, 600))
  const [inner] = layout([{ box: [0, 0, 800, 600], label: 'Cả màn' }], 800, 600)
  assert.deepEqual([inner.label.x, inner.label.y], [2, 2])
})

test('labels of adjacent boxes overlap neither each other nor the other box', () => {
  const marks = [
    { box: [100, 100, 200, 30], label: 'Để trống: không có câu báo lỗi dưới ô' },
    { box: [100, 140, 200, 30], label: 'Nút bị khoá, BTC không biết vì sao' },
  ]
  const [a, b] = layout(marks, 800, 600)
  assert.ok(!overlap(a.label, b.label))
  assert.ok(!overlap(a.label, R(marks[1].box)))
  assert.ok(!overlap(b.label, R(marks[0].box)))
  assert.ok(inside(a.label, 800, 600) && inside(b.label, 800, 600))
})

test('long Vietnamese text wraps to at most 3 lines and ends with "…"', () => {
  const long = 'Bảng xếp hạng không cập nhật sau khi trọng tài nhập kết quả trận đấu → đội FP-1 vẫn đứng hạng 1 dù đã thua hai trận liên tiếp và bị trừ điểm kỷ luật theo quy định của giải đấu năm nay'
  const [p] = layout([{ box: [50, 300, 300, 40], label: long }], 800, 600)
  assert.equal(p.label.lines.length, 3)
  assert.ok(p.label.lines[2].endsWith('…'))
  assert.ok(p.label.w <= 440)
  const short = layout([{ box: [50, 300, 300, 40], label: 'A → B' }], 800, 600)[0]
  assert.deepEqual(short.label.lines, ['A → B'])
})

test('labels with no element stack from the top-left corner', () => {
  const [a, b] = layout([{ box: null, label: 'Bước 3: hết thời gian chờ' }, { box: null, label: 'Không thấy nút Lưu' }], 800, 600)
  assert.equal(a.box, null)
  assert.deepEqual([a.label.x, a.label.y], [8, 8])
  assert.equal(b.label.x, 8)
  assert.ok(b.label.y >= a.label.y + a.label.h)
})

test('boxes are clamped to the image; one fully outside has no box', () => {
  const [a, b] = layout([{ box: [-20, 550, 100, 100], label: 'x' }, { box: [900, 700, 50, 50], label: 'y' }], 800, 600)
  assert.deepEqual(a.box, [0, 550, 80, 50])
  assert.equal(b.box, null)
  assert.deepEqual([b.label.x, b.label.y], [8, 8])
})

test('scale multiplies the label sizes', () => {
  const [one] = layout([{ box: [100, 300, 100, 40], label: 'Sai' }], 1600, 1200)
  const [two] = layout([{ box: [100, 300, 100, 40], label: 'Sai' }], 1600, 1200, { scale: 2 })
  assert.ok(Math.abs(two.label.h - 2 * one.label.h) <= 1)
  assert.ok(Math.abs(two.label.w - 2 * one.label.w) <= 1)
  assert.equal(two.label.y + two.label.h, 300 - 8)
})

test('the crop covers every box and label, padded and clamped', () => {
  const placed = layout([{ box: [100, 200, 50, 20], label: 'a' }, { box: [400, 300, 50, 20], label: 'b' }], 800, 600)
  const [x, y, w, h] = cropRect(placed, 800, 600)
  assert.equal(x, 0) // 100 - 120 clamped
  assert.ok(y <= 200 - 120 - placed[0].label.h)
  assert.equal(x + w, 570)
  assert.equal(y + h, 440)
  assert.equal(cropRect([], 800, 600), null)
  assert.equal(needsCrop(placed, 800, 600), true)
  assert.equal(needsCrop(layout([{ box: [0, 0, 400, 300], label: 'big' }], 800, 600), 800, 600), false)
  assert.equal(needsCrop(layout([{ box: null, label: 'no box' }], 800, 600), 800, 600), false)
})

test('the image size comes from the PNG header; JPEG is refused', () => {
  const d = tmp()
  writeFileSync(join(d, 'a.png'), png(37, 21))
  assert.deepEqual(pngSize(join(d, 'a.png')), { width: 37, height: 21 })
  assert.throws(() => pngSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), /JPEG/)
  assert.throws(() => pngSize(Buffer.from('not an image')), /PNG/)
})

// ── Rendering ────────────────────────────────────────────────────────────────
// A Playwright that loads AND starts a browser, else the rendering tests skip.
async function pwSource() {
  for (const c of [process.env.TF_PLAYWRIGHT]) {
    if (!c || !existsSync(c)) continue
    for (const name of ['@playwright/test', 'playwright']) {
      try {
        const browser = await launch(createRequire(resolve(c))(name))
        await browser.close()
        return c
      } catch {}
    }
  }
  return ''
}
const PW = await pwSource()
const screen = (x, y) => (y < 60 ? [30, 60, 120] : x > 250 && x < 550 && y > 200 && y < 240 ? [255, 255, 255] : [240, 242, 245])
const sample = [
  { box: [250, 200, 300, 40], label: 'Để trống: không có câu báo lỗi dưới ô' },
  { box: [250, 300, 120, 36], label: 'Nút bị khoá → BTC không biết vì sao' },
]

test('Chromium draws boxes and labels, and a smaller close-up', { skip: !PW && 'no Playwright that starts a browser (set TF_PLAYWRIGHT)' }, async () => {
  const d = tmp()
  const f = join(d, 'shot.png')
  writeFileSync(f, png(800, 600, screen))
  const r = await annotate(f, sample, { playwrightFrom: PW, crop: true, engine: 'chromium' })
  assert.equal(r.engine, 'chromium')
  assert.equal(r.marked, join(d, 'shot.marked.png'))
  assert.deepEqual(pngSize(r.marked), { width: 800, height: 600 })
  assert.equal(r.crop, join(d, 'shot.crop.png'))
  const c = pngSize(r.crop)
  assert.ok(c.width < 800 || c.height < 600)
})

test('annotateAll renders many images with one browser', { skip: !PW && 'no Playwright that starts a browser (set TF_PLAYWRIGHT)' }, async () => {
  const d = tmp()
  const a = join(d, 'a.png'), b = join(d, 'b.png')
  writeFileSync(a, png(800, 600, screen))
  writeFileSync(b, png(400, 300))
  const rs = await annotateAll([{ file: a, marks: sample, crop: false }, { file: b, marks: [{ box: null, label: 'Bước 2 lỗi' }] }], { playwrightFrom: PW, engine: 'chromium' })
  assert.deepEqual(rs.map((r) => r.engine), ['chromium', 'chromium'])
  assert.deepEqual(pngSize(rs[0].marked), { width: 800, height: 600 })
  assert.deepEqual(pngSize(rs[1].marked), { width: 400, height: 300 })
  assert.equal(rs[0].crop, null)
})

const FF = which('ffmpeg') || ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync) || ''
test('ffmpeg fallback draws boxes only', { skip: !FF && 'no ffmpeg' }, async () => {
  const d = tmp()
  const f = join(d, 'shot.png')
  writeFileSync(f, png(800, 600, screen))
  const r = await annotate(f, sample, { engine: 'ffmpeg' })
  assert.equal(r.engine, 'ffmpeg')
  assert.deepEqual(pngSize(r.marked), { width: 800, height: 600 })
  assert.ok(r.crop && existsSync(r.crop)) // both boxes are small → close-up by default
  assert.ok(pngSize(r.crop).width < 800)
})

test('the CLI prints the result', { skip: !FF && 'no ffmpeg' }, () => {
  const d = tmp()
  const f = join(d, 'shot.png')
  writeFileSync(f, png(200, 100))
  writeFileSync(join(d, 'marks.json'), JSON.stringify([{ box: [10, 10, 50, 20], label: 'x' }]))
  const out = execFileSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'annotate.mjs'), f, '--marks', join(d, 'marks.json'), '--no-crop'], { env: { ...process.env, TF_PLAYWRIGHT: '', PLAYWRIGHT_FROM: '' }, cwd: d }).toString()
  const r = JSON.parse(out)
  assert.equal(r.marked, join(d, 'shot.marked.png'))
  assert.equal(r.crop, null)
  assert.ok(['chromium', 'ffmpeg'].includes(r.engine))
})
