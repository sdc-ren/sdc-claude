#!/usr/bin/env node
// task-flow evidence images: convert screenshots (PNG/JPEG) to WebP so EVD stays small (~60% of PNG).
// Encoder, first found: cwebp (`brew install webp`) → ffmpeg with libwebp (incl. keg-only ffmpeg-full)
// → Playwright's Chromium canvas.
//
//   node webp.mjs <file|dir>… [--quality 80] [--playwright <package.json>] [--keep]
//     → writes <name>.webp next to each input, prints the outputs, deletes the input unless --keep.

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { which } from './platform.mjs'
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const IMG = new Set(['.png', '.jpg', '.jpeg'])

function inputs(paths) {
  return paths.flatMap((p) => {
    const abs = resolve(p)
    if (!existsSync(abs)) return []
    if (statSync(abs).isDirectory()) return readdirSync(abs).map((f) => join(abs, f)).filter((f) => IMG.has(extname(f).toLowerCase()))
    return IMG.has(extname(abs).toLowerCase()) ? [abs] : []
  })
}
const outOf = (f) => f.slice(0, -extname(f).length) + '.webp'

function cwebp() {
  return which('cwebp') || ['/opt/homebrew/bin/cwebp', '/usr/local/bin/cwebp'].find(existsSync) || ''
}
function ffmpegWebp() {
  for (const bin of ['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/usr/local/opt/ffmpeg-full/bin/ffmpeg', which('ffmpeg')].filter(Boolean)) {
    try { if (execFileSync(bin, ['-hide_banner', '-encoders'], { stdio: 'pipe' }).toString().includes('libwebp')) return bin } catch {}
  }
  return ''
}

function playwright(from) {
  for (const c of [from, process.env.TF_PLAYWRIGHT, join(process.cwd(), 'package.json')].filter(Boolean)) {
    try { return createRequire(resolve(c))('@playwright/test') } catch {}
    try { return createRequire(resolve(c))('playwright') } catch {}
  }
  throw new Error('no ffmpeg with libwebp and no Playwright — pass --playwright <package.json that depends on @playwright/test>')
}

export async function toWebp(files, { quality = 80, playwrightFrom, keep = false } = {}) {
  const done = []
  const cw = cwebp()
  const ff = cw ? '' : ffmpegWebp()
  if (cw) {
    for (const f of files) {
      execFileSync(cw, ['-quiet', '-q', String(quality), f, '-o', outOf(f)])
      done.push(outOf(f))
    }
  } else if (ff) {
    for (const f of files) {
      execFileSync(ff, ['-y', '-loglevel', 'error', '-i', f, '-c:v', 'libwebp', '-quality', String(quality), outOf(f)])
      done.push(outOf(f))
    }
  } else if (files.length) {
    const { chromium } = playwright(playwrightFrom)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      for (const f of files) {
        const mime = extname(f).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'
        const src = `data:${mime};base64,${readFileSync(f).toString('base64')}`
        const data = await page.evaluate(async ({ src, q }) => {
          const img = new Image()
          img.src = src
          await img.decode()
          const c = document.createElement('canvas')
          c.width = img.naturalWidth
          c.height = img.naturalHeight
          c.getContext('2d').drawImage(img, 0, 0)
          return c.toDataURL('image/webp', q)
        }, { src, q: quality / 100 })
        writeFileSync(outOf(f), Buffer.from(data.split(',')[1], 'base64'))
        done.push(outOf(f))
      }
    } finally {
      await browser.close()
    }
  }
  // Delete an original only when its WebP really exists and is not empty.
  if (!keep) for (const f of files) if (existsSync(outOf(f)) && statSync(outOf(f)).size > 0) rmSync(f)
  return done
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : undefined }
  const quality = Number(flag('quality') || 80)
  const playwrightFrom = flag('playwright')
  const keep = args.includes('--keep')
  const files = inputs(args.filter((a) => a !== '--keep'))
  if (!files.length) { console.error('usage: webp.mjs <file|dir>… [--quality 80] [--playwright <package.json>] [--keep]'); process.exit(2) }
  for (const f of await toWebp(files, { quality, playwrightFrom, keep })) console.log(f)
}
