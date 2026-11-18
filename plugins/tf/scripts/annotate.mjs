#!/usr/bin/env node
// task-flow evidence marks: draw the QC-style bug marks on an e2e screenshot — a red outline box (#e00, 2px)
// around the wrong element and a red label (white bold text, ≤ 3 lines) right next to it; several marks
// per image; plus a cropped close-up when every marked element is small.
// Engine, first available: Playwright's Chromium (boxes + labels, Vietnamese text via system fonts)
// → ffmpeg `drawbox` (boxes only: Homebrew ffmpeg has no drawtext) → nothing (engine: null, no files).
//
//   node annotate.mjs <image.png> --marks <marks.json> [--crop|--no-crop] [--out <file>] [--scale <n>] [--playwright <package.json>]
//     marks.json: [{ "box": [x, y, w, h] | null, "label": "…" }] in image pixels (or { "marks": [...] })
//     → writes <name>.marked.png (and <name>.crop.png), prints { marked, crop, engine }.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { which } from './platform.mjs'
import { playwright } from './webp.mjs'

const RED = '#e00'
const FONT = '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

// ── Layout (pure) ────────────────────────────────────────────────────────────
const metrics = (width, scale) => {
  const fontSize = 13 * scale
  return {
    fontSize,
    lineH: fontSize * 1.35,
    charW: 0.6 * fontSize,
    padV: 5 * scale,
    padH: 8 * scale,
    gap: 4 * scale,
    maxW: Math.max(40 * scale, Math.min(440 * scale, width - 16 * scale)),
  }
}

const chars = (s) => Array.from(s)

// Word-wrap to at most 3 lines of `max` characters; overflow ends the last line with "…".
function wrap(text, max) {
  max = Math.max(1, max)
  const lines = []
  for (const para of String(text).normalize('NFC').split(/\r?\n/)) {
    let cur = ''
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (chars(word).length > max) { // a word longer than a line is cut
        if (cur) { lines.push(cur); cur = '' }
        lines.push(chars(word).slice(0, max).join(''))
        word = chars(word).slice(max).join('')
      }
      const next = cur ? `${cur} ${word}` : word
      if (chars(next).length <= max) cur = next
      else { lines.push(cur); cur = word }
    }
    if (cur) lines.push(cur)
  }
  if (lines.length <= 3) return lines
  const kept = lines.slice(0, 3)
  const last = chars(kept[2])
  kept[2] = (last.length + 1 > max ? last.slice(0, max - 1).join('') : kept[2]).replace(/\s+$/, '') + '…'
  return kept
}

function clampBox(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4 || box.some((n) => !Number.isFinite(Number(n)))) return null
  const [x, y, w, h] = box.map(Number)
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y))
  const x1 = Math.min(width, Math.round(x + w)), y1 = Math.min(height, Math.round(y + h))
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const rect = ([x, y, w, h]) => ({ x, y, w, h })
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi))

export function layout(marks, width, height, { scale = 1 } = {}) {
  const m = metrics(width, scale)
  const maxChars = Math.floor((m.maxW - 2 * m.padH) / m.charW)
  const items = (marks || []).map((mk) => {
    const box = clampBox(mk?.box, width, height)
    const text = String(mk?.label ?? '').trim()
    if (!text) return { box, size: null }
    const lines = wrap(text, maxChars)
    const longest = Math.max(...lines.map((l) => chars(l).length))
    return { box, lines, size: { w: Math.ceil(longest * m.charW + 2 * m.padH), h: Math.ceil(lines.length * m.lineH + 2 * m.padV) } }
  })
  const placed = items.map(() => null)
  const labels = []
  // Labels with no element: stacked from the top-left corner.
  let top = Math.round(8 * scale)
  items.forEach((it, i) => {
    if (it.box || !it.size) return
    placed[i] = { x: Math.round(8 * scale), y: top, ...it.size, lines: it.lines }
    labels.push(placed[i])
    top += it.size.h + Math.round(m.gap)
  })
  // Labels next to their box: above, below, right, left, inside; else above, pushed down past earlier labels.
  items.forEach((it, i) => {
    if (!it.box || !it.size) return
    const { w, h } = it.size
    const [bx, by, bw, bh] = it.box
    const g = Math.round(m.gap)
    const others = items.filter((o, j) => j !== i && o.box).map((o) => rect(o.box))
    const fits = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= width && r.y + r.h <= height &&
      !labels.some((l) => overlaps(r, l)) && !others.some((b) => overlaps(r, b))
    const hx = clamp(bx, 0, width - w), vy = clamp(by, 0, height - h)
    const tries = [
      { x: hx, y: by - g - h },
      { x: hx, y: by + bh + g },
      { x: bx + bw + g, y: vy },
      { x: bx - g - w, y: vy },
      { x: bx + Math.round(2 * scale), y: by + Math.round(2 * scale) },
    ].map((p) => ({ ...p, w, h }))
    let r = tries.find(fits)
    if (!r) {
      r = { x: hx, y: clamp(by - g - h, 0, height - h), w, h }
      for (let n = 0; n < 100; n++) {
        const hit = labels.find((l) => overlaps(r, l))
        if (!hit) break
        r.y = hit.y + hit.h + Math.round(2 * scale)
      }
      r.y = clamp(r.y, 0, height - h)
    }
    placed[i] = { ...r, lines: it.lines }
    labels.push(placed[i])
  })
  return items.map((it, i) => ({ box: it.box, label: placed[i] }))
}

export function cropRect(placed, width, height, pad = 120) {
  const rs = (placed || []).flatMap((p) => [p.box && rect(p.box), p.label].filter(Boolean))
  if (!rs.length) return null
  const x0 = Math.max(0, Math.min(...rs.map((r) => r.x)) - pad)
  const y0 = Math.max(0, Math.min(...rs.map((r) => r.y)) - pad)
  const x1 = Math.min(width, Math.max(...rs.map((r) => r.x + r.w)) + pad)
  const y1 = Math.min(height, Math.max(...rs.map((r) => r.y + r.h)) + pad)
  return x1 > x0 && y1 > y0 ? [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)] : null
}

export function needsCrop(placed, width, height) {
  const boxes = (placed || []).map((p) => p.box).filter(Boolean)
  return boxes.length > 0 && boxes.every(([, , w, h]) => w * h < 0.06 * width * height)
}

// ── Image size from the PNG header ───────────────────────────────────────────
export function pngSize(fileOrBuf) {
  const b = Buffer.isBuffer(fileOrBuf) ? fileOrBuf : readFileSync(fileOrBuf)
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) throw new Error('annotate: JPEG input is not supported — e2e screenshots must be PNG')
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length < 24 || sig.some((v, i) => b[i] !== v) || b.toString('ascii', 12, 16) !== 'IHDR') throw new Error('annotate: not a PNG image')
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

// ── Rendering ────────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const sibling = (file, suffix) => join(dirname(file), basename(file, extname(file)) + suffix)

function html(src, width, height, placed, scale) {
  const m = metrics(width, scale)
  const px = (n) => `${Math.round(n * 100) / 100}px`
  const parts = placed.flatMap(({ box, label }) => [
    box && `<div class="b" style="left:${box[0]}px;top:${box[1]}px;width:${box[2]}px;height:${box[3]}px"></div>`,
    label && `<div class="l" style="left:${label.x}px;top:${label.y}px">${esc(label.lines.join('\n'))}</div>`,
  ].filter(Boolean))
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:#fff}
img{position:absolute;left:0;top:0;width:${width}px;height:${height}px;display:block}
.b{position:absolute;box-sizing:border-box;border:${px(2 * scale)} solid ${RED}}
.l{position:absolute;box-sizing:border-box;width:max-content;max-width:${px(m.maxW)};background:${RED};color:#fff;font:700 ${px(m.fontSize)}/1.35 ${FONT};padding:${px(m.padV)} ${px(m.padH)};border-radius:2px;white-space:pre-line}
</style></head><body><img src="${src}">${parts.join('')}</body></html>`
}

function ffmpegBin() {
  return which('ffmpeg') || ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg'].find(existsSync) || ''
}

function loadPlaywright(from) {
  for (const c of [from, process.env.PLAYWRIGHT_FROM].filter(Boolean)) {
    try { return playwright(c) } catch {}
  }
  try { return playwright() } catch { return null } // TF_PLAYWRIGHT, then cwd package.json
}

function prepare(job) {
  const file = resolve(job.file)
  const { width, height } = pngSize(file)
  const scale = Number(job.scale) > 0 ? Number(job.scale) : 1
  const placed = layout(job.marks || [], width, height, { scale })
  const wantCrop = job.crop === true || (job.crop !== false && needsCrop(placed, width, height))
  const clip = wantCrop ? cropRect(placed, width, height) : null
  return {
    file, width, height, scale, placed, clip,
    out: resolve(job.out || sibling(file, '.marked.png')),
    cropOut: resolve(job.cropOut || sibling(file, '.crop.png')),
  }
}

// Playwright's own Chromium; when its build is not downloaded, the installed Chrome or Edge.
export async function launch(pw) {
  let first
  for (const o of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await pw.chromium.launch(o) } catch (e) { first ||= e }
  }
  throw first
}

async function withChromium(pw, jobs) {
  const browser = await launch(pw)
  try {
    const results = []
    for (const j of jobs) {
      const ctx = await browser.newContext({ viewport: { width: j.width, height: j.height }, deviceScaleFactor: 1 })
      try {
        const page = await ctx.newPage()
        const src = `data:image/png;base64,${readFileSync(j.file).toString('base64')}`
        await page.setContent(html(src, j.width, j.height, j.placed, j.scale), { waitUntil: 'load' })
        await page.evaluate(async (W) => {
          await document.fonts.ready
          await document.querySelector('img').decode().catch(() => {})
          // Real text may be a little wider than the estimate: keep every label inside the image.
          for (const l of document.querySelectorAll('.l')) {
            const r = l.getBoundingClientRect()
            if (r.right > W) l.style.left = `${Math.max(0, W - r.width)}px`
          }
        }, j.width)
        await page.screenshot({ path: j.out })
        let crop = null
        if (j.clip) {
          const [x, y, width, height] = j.clip
          await page.screenshot({ path: j.cropOut, clip: { x, y, width, height } })
          crop = j.cropOut
        }
        results.push({ marked: j.out, crop, engine: 'chromium' })
      } finally {
        await ctx.close()
      }
    }
    return results
  } finally {
    await browser.close()
  }
}

function withFfmpeg(bin, j, scale) {
  const t = Math.max(1, Math.round(2 * scale))
  const boxes = j.placed.map((p) => p.box).filter(Boolean)
  const vf = boxes.length ? boxes.map(([x, y, w, h]) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=0xEE0000:t=${t}`).join(',') : 'null'
  execFileSync(bin, ['-y', '-loglevel', 'error', '-i', j.file, '-vf', vf, '-frames:v', '1', '-update', '1', j.out], { stdio: 'pipe' })
  let crop = null
  if (j.clip) {
    const [x, y, w, h] = j.clip
    execFileSync(bin, ['-y', '-loglevel', 'error', '-i', j.out, '-vf', `crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-update', '1', j.cropOut], { stdio: 'pipe' })
    crop = j.cropOut
  }
  return { marked: j.out, crop, engine: 'ffmpeg' }
}

// Many images, one Chromium. jobs: [{ file, marks, crop, scale, out, cropOut }].
// opts.engine: 'chromium' | 'ffmpeg' forces one engine (no fallback to the other).
export async function annotateAll(jobs, { playwrightFrom, engine } = {}) {
  const prepared = (jobs || []).map(prepare)
  const none = () => prepared.map(() => ({ marked: null, crop: null, engine: null }))
  if (!prepared.length) return []
  if (engine !== 'ffmpeg') {
    const pw = loadPlaywright(playwrightFrom)
    if (pw?.chromium) {
      try { return await withChromium(pw, prepared) } catch (e) {
        if (engine === 'chromium') throw e
      }
    }
    if (engine === 'chromium') return none()
  }
  const bin = ffmpegBin()
  if (!bin) return none()
  try {
    return prepared.map((j) => withFfmpeg(bin, j, j.scale))
  } catch {
    return none()
  }
}

export async function annotate(file, marks, { out, crop, cropOut, scale, playwrightFrom, engine } = {}) {
  const [r] = await annotateAll([{ file, marks, crop, cropOut, out, scale }], { playwrightFrom, engine })
  return r
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : undefined }
  const marksFile = flag('marks')
  const out = flag('out')
  const scale = flag('scale')
  const playwrightFrom = flag('playwright')
  const crop = args.includes('--crop') ? true : args.includes('--no-crop') ? false : undefined
  const [file] = args.filter((a) => !a.startsWith('--'))
  if (!file || !marksFile) {
    console.error('usage: annotate.mjs <image.png> --marks <marks.json> [--crop|--no-crop] [--out <file>] [--scale <n>] [--playwright <package.json>]')
    process.exit(2)
  }
  const raw = JSON.parse(readFileSync(marksFile, 'utf8'))
  const marks = Array.isArray(raw) ? raw : raw.marks || []
  console.log(JSON.stringify(await annotate(file, marks, { out, crop, scale: scale ? Number(scale) : undefined, playwrightFrom }), null, 2))
}
