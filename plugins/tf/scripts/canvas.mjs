#!/usr/bin/env node
// tf: a Claude Design canvas → a clickable demo, and a summary agents can plan from. Deterministic, no model.
//
// A canvas keeps every screen as project/<path>.dc.html (template + `class Component extends DCLogic`), the layout
// in project/canvas.json (frames, title notes, order) and its design system under project/ds/<folder>/. The
// orchestrator downloads those files with the Artifact tool (docs/demo.md); this script does the rest.
//
//   node canvas.mjs export <src> <out> [--lang vi|en] [--title T] [--url <canvas url>] [--feedback <mailto:… | https://…>]
//       <src> = the folder holding project/ (or project/ itself). Writes <out>/index.html (role picker + screen list),
//       one <out>/<path>.html per screen, the design-system files, _demo/ (runtime + css) and demo.json.
//       Every screen gets a Feedback button: inside a published artifact it opens claude.ai's own comment box on
//       that screen (anchor `#screen-<file>`); elsewhere, or for a viewer who cannot comment, it opens --feedback
//       (an email with the screen filled in, or a form URL; {screen} {title} {demo} {url} are filled in). With
//       neither available the button stays hidden.
//       Prints JSON { out, title, screens, groups[{slug,name,start,count}], warnings[] }.
//   node canvas.mjs summary <src> [--url <canvas url>]   markdown for specs/: groups, screens, devices, links, notes
//   node canvas.mjs blobs <src>                          uploaded assets the screens use: [{ id, have }] — fetch the
//                                                        missing ones into <src>/_blob/ (Artifact read by id) first
//   node canvas.mjs serve <out> [--port 4173]            static server for the demo (foreground; run it in background)
//   import { parseHtml, readCanvas, layout, exportDemo } from './canvas.mjs'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const REACT = 'https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js'
const REACT_DOM = 'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js'

// ── HTML tokenizer (the canvas format is well-formed: every element closed, every attribute quoted) ──────────
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const RAW = new Set(['script', 'style', 'textarea', 'title'])
const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…',
  copy: '©', reg: '®', trade: '™', times: '×', divide: '÷', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', bull: '•', rarr: '→', larr: '←', uarr: '↑', darr: '↓', harr: '↔', deg: '°', plusmn: '±', minus: '−',
  check: '✓', thinsp: ' ', ensp: ' ', emsp: ' ', zwj: '‍', zwnj: '‌', euro: '€', pound: '£', yen: '¥',
}
export const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m }
  return ENT[e.toLowerCase()] ?? m
})

// → nodes: string | [tag, [[name, value]], children]
export function parseHtml(src) {
  const root = ['#root', [], []]
  const stack = [root]
  let i = 0
  const s = String(src)
  const top = () => stack[stack.length - 1]
  while (i < s.length) {
    if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i + 4); i = e < 0 ? s.length : e + 3; continue }
    if (s.startsWith('<!', i) || s.startsWith('<?', i)) { const e = s.indexOf('>', i); i = e < 0 ? s.length : e + 1; continue }
    if (s[i] === '<' && s[i + 1] === '/') {
      const m = s.slice(i).match(/^<\/\s*([A-Za-z][\w:.-]*)\s*>/)
      if (m) {
        const name = m[1].toLowerCase()
        const at = stack.map((n) => n[0].toLowerCase()).lastIndexOf(name)
        if (at > 0) stack.length = at
        i += m[0].length
        continue
      }
    }
    if (s[i] === '<' && /[A-Za-z]/.test(s[i + 1] || '')) {
      const m = s.slice(i).match(/^<([A-Za-z][\w:.-]*)/)
      let j = i + m[0].length
      const attrs = []
      let self = false
      for (;;) {
        while (j < s.length && /\s/.test(s[j])) j++
        if (s[j] === '>') { j++; break }
        if (s[j] === '/' && s[j + 1] === '>') { self = true; j += 2; break }
        if (j >= s.length) break
        const a = s.slice(j).match(/^([^\s=>/"']+)/)
        if (!a) { j++; continue }
        j += a[0].length
        while (/\s/.test(s[j] || '')) j++
        let v = ''
        if (s[j] === '=') {
          j++
          while (/\s/.test(s[j] || '')) j++
          const q = s[j]
          if (q === '"' || q === "'") { const e = s.indexOf(q, j + 1); v = s.slice(j + 1, e < 0 ? s.length : e); j = e < 0 ? s.length : e + 1 } else { const u = s.slice(j).match(/^[^\s>]*/)[0]; v = u; j += u.length }
        }
        attrs.push([a[1], decode(v)])
      }
      const tag = m[1]
      const low = tag.toLowerCase()
      const el = [tag, attrs, []]
      top()[2].push(el)
      if (RAW.has(low) && !self) {
        const e = s.toLowerCase().indexOf(`</${low}`, j)
        const body = s.slice(j, e < 0 ? s.length : e)
        if (body) el[2].push(low === 'textarea' || low === 'title' ? decode(body) : body)
        const close = e < 0 ? s.length : s.indexOf('>', e) + 1
        i = close
        continue
      }
      if (!self && !VOID.has(low)) stack.push(el)
      i = j
      continue
    }
    const e = s.indexOf('<', i + 1)
    const t = s.slice(i, e < 0 ? s.length : e)
    top()[2].push(decode(t))
    i = e < 0 ? s.length : e
  }
  return root[2]
}
const attr = (el, name) => { const a = el[1].find((x) => x[0].toLowerCase() === name); return a ? a[1] : undefined }
function find(nodes, pred, out = []) {
  for (const n of nodes) if (Array.isArray(n)) { if (pred(n)) out.push(n); find(n[2], pred, out) }
  return out
}
const slice = (src, tag) => { const m = String(src).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i')); return m ? m[1] : '' }

// ── one .dc.html screen ──────────────────────────────────────────────────────
export function parseScreen(text) {
  const head = slice(text, 'head')
  const body = slice(text, 'body') || text
  const xdc = slice(body, 'x-dc')
  const helmet = slice(xdc, 'helmet')
  const tplSrc = xdc.replace(/<helmet\b[^>]*>[\s\S]*?<\/helmet>/i, '')
  const sm = body.match(/<script\b([^>]*\bdata-dc-script\b[^>]*)>([\s\S]*?)<\/script>/i)
  let props = {}
  if (sm) {
    const pa = parseHtml(`<x ${sm[1]}></x>`)[0]
    try { props = JSON.parse(attr(pa, 'data-props') || '{}') } catch {}
  }
  const defaults = {}
  for (const [k, v] of Object.entries(props)) if (!k.startsWith('$') && v && typeof v === 'object' && 'default' in v) defaults[k] = v.default
  // <head> lines the screen needs (design-system css, fonts); the canvas's own support.js is not part of a demo.
  const headLines = (head.match(/<link\b[^>]*>|<style\b[\s\S]*?<\/style>|<script\b[^>]*\bsrc=[^>]*><\/script>|<meta\b[^>]*>/gi) || [])
    .filter((l) => !/support\.js/.test(l) && !/<meta\b[^>]*charset/i.test(l) && !/name=["']viewport/i.test(l))
  const lang = (text.match(/<html\b[^>]*\blang=["']([^"']+)/i) || [])[1] || ''
  const title = decode((head.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim()
  return { tpl: parseHtml(tplSrc), logic: sm ? sm[2] : '', helmet: helmet.trim(), headLines, props: defaults, preview: props.$preview || null, lang, title }
}

// ── the canvas ───────────────────────────────────────────────────────────────
export function readCanvas(src) {
  let proj = resolve(src)
  if (!existsSync(join(proj, 'canvas.json')) && existsSync(join(proj, 'project', 'canvas.json'))) proj = join(proj, 'project')
  const f = join(proj, 'canvas.json')
  const canvas = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { boards: {}, notes: {} }
  // Every .dc.html shows on the canvas, listed or not (the type's rule): pick up unlisted ones too.
  const files = walk(proj).filter((p) => p.endsWith('.dc.html') && !p.startsWith(`ds${sep}`) && !p.startsWith('ds/')).map((p) => p.split(sep).join('/'))
  canvas.boards ||= {}
  for (const p of files) if (!canvas.boards[p]) canvas.boards[p] = { x: 0, y: 1e7 + files.indexOf(p) * 1000, w: 1280, h: 800, unlisted: true }
  return { proj, canvas, files }
}
function walk(dir, base = dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) { if (n !== 'node_modules' && n !== '_blob') walk(p, base, out) } else out.push(relative(base, p))
  }
  return out
}
const NOTE_SIZE = { s: 24, m: 40, l: 56, xl: 72, xxl: 96 }
const noteSize = (n) => (typeof n.size === 'number' ? n.size : NOTE_SIZE[n.size] ?? 72)
export const slugify = (t) => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'screens'
export const deviceOf = (b) => (b.expand === 'fill' ? 'web' : b.w <= 500 ? 'phone' : 'fixed')

// Screens grouped the way the canvas reads: the biggest title notes are groups (usually one per role or flow),
// smaller title notes are sections inside them; a frame belongs to the nearest title above it that spans it.
export function layout(canvas) {
  const boards = Object.entries(canvas.boards || {}).map(([file, b]) => ({ file, ...b }))
  const titles = Object.entries(canvas.notes || {}).map(([id, n]) => ({ id, ...n })).filter((n) => n.kind === 'title1' && n.text)
  const max = titles.length ? Math.max(...titles.map(noteSize)) : 0
  const big = titles.filter((n) => noteSize(n) === max)
  const small = titles.filter((n) => noteSize(n) !== max)
  const pageOf = (x) => x.page || ''
  const spans = (n, b) => b.x + (b.w || 0) > n.x && b.x < n.x + (n.maxW || 8000)
  // The nearest title above that spans the frame; else the nearest above that starts left of it (a row can run
  // wider than its title's maxW). Sections only count below their group's title.
  const owner = (list, b, minY = -Infinity) => {
    const above = list.filter((n) => pageOf(n) === pageOf(b) && n.y <= b.y && n.y >= minY && n.x < b.x + Math.max(1, b.w || 0))
    const near = (arr) => arr.sort((a, c) => c.y - a.y || c.x - a.x)[0]
    return near(above.filter((n) => spans(n, b))) || near([...above]) || null
  }
  const pages = Object.fromEntries((canvas.pages || []).map((p) => [p.id, p.name]))
  const groups = new Map()
  const first = (t) => String(t).split('\n')[0].trim()
  for (const b of boards) {
    const g = owner(big, b)
    const sec = owner(small, b, g ? g.y : -Infinity)
    const key = g ? g.id : pageOf(b) ? `page:${pageOf(b)}` : '_'
    const name = g ? first(g.text) : pageOf(b) ? pages[pageOf(b)] || pageOf(b) : ''
    if (!groups.has(key)) groups.set(key, { key, name, y: g ? g.y : 1e9, x: g ? g.x : 0, screens: [] })
    b.section = sec ? first(sec.text) : ''
    b.sectionY = sec ? sec.y : g ? g.y : -1e9
    groups.get(key).screens.push(b)
  }
  const out = [...groups.values()].sort((a, c) => a.y - c.y || a.x - c.x)
  const used = new Set()
  for (const g of out) {
    g.screens.sort((a, c) => a.sectionY - c.sectionY || a.y - c.y || a.x - c.x)
    const short = g.name.split(/\s+·\s+/)[0]
    let slug = slugify(short || g.name || 'screens')
    for (let n = 2; used.has(slug); n++) slug = `${slugify(short || 'screens')}-${n}`
    used.add(slug)
    g.slug = slug
    if (!g.name) g.name = out.length > 1 ? 'Other screens' : 'Screens'
    const launch = canvas.launch && canvas.launch.file
    g.start = (g.screens.find((s) => s.file === launch) || g.screens.find((s) => /(^|\/)Main\.dc\.html$/.test(s.file)) || g.screens[0] || {}).file
    // Notes (stickies) placed inside the group's band: design decisions an agent should read.
    g.notes = Object.values(canvas.notes || {}).filter((n) => !n.kind && n.text && owner(big, { x: n.x, y: n.y, w: n.w || 300, page: n.page }) === (big.find((b) => b.id === g.key) || null)).map((n) => n.text)
  }
  return out
}
const linksOf = (sc) => {
  const out = new Set()
  for (const el of find(sc.tpl, (n) => n[0].toLowerCase() === 'a')) { const h = attr(el, 'href'); if (h && /\.dc\.html(#.*)?$/.test(h)) out.add(h.replace(/#.*$/, '')) }
  for (const m of sc.logic.matchAll(/['"`]([\w./-]+\.dc\.html)/g)) out.add(m[1])
  return [...out]
}
const resolveLink = (from, h) => (h.startsWith('/') ? h.slice(1) : join(dirname(from), h).split(sep).join('/'))

// Render each screen once in Node with a stub React: catches screens whose script throws before a browser does.
function smoke(name, sources) {
  const R = {
    Fragment: 'F',
    Component: class { constructor(p) { this.props = p || {}; this.state = {} } setState(u) { this.state = { ...this.state, ...(typeof u === 'function' ? u(this.state, this.props) : u) } } forceUpdate() {} },
    createElement: (t, p, ...c) => ({ t, p, c }),
  }
  const sandbox = { console: { log() {}, warn() {}, error() {} } }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(join(HERE, 'canvas-runtime.js'), 'utf8'), sandbox, { timeout: 2000 })
  const ctx = sandbox.DCRuntime.makeComponents(R, sources, '')
  const C = ctx.components[name]
  const inst = new C(sources[name].props || {})
  // Render, then press every handler once (click, change…) and render again: a button whose handler throws
  // shows up here instead of in front of a client.
  const handlers = []
  const walkEl = (e) => {
    if (!e || typeof e !== 'object') return
    if (typeof e.t === 'function') { const c = new e.t(e.p || {}); walkEl(c.render ? c.render() : null) }
    for (const [k, v] of Object.entries(e.p || {})) if (/^on[A-Z]/.test(k) && typeof v === 'function') handlers.push([k, v])
    ;(e.c || []).forEach(walkEl)
  }
  const check = (tree) => { if (tree && tree.c && tree.c[0] && tree.c[0].t === 'pre') throw new Error(tree.c[0].c.join('')) }
  let tree = inst.render()
  check(tree)
  walkEl(tree)
  const ev = { preventDefault() {}, stopPropagation() {}, target: { value: '', checked: true }, currentTarget: { value: '', checked: true }, key: 'Enter' }
  for (const [k, fn] of handlers.slice(0, 200)) {
    try { fn(ev) } catch (e) { throw new Error(`${k} handler: ${e.message}`) }
    tree = inst.render()
    check(tree)
  }
}

const json = (x) => JSON.stringify(x).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`)
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const L = {
  en: { screens: 'screens', start: 'Start', all: 'All roles', phone: 'App', web: 'Web', fixed: 'Frame', open: 'Open', list: 'Screens', groups: 'groups', back: 'All screens', made: 'Clickable demo exported from the design canvas', missing: 'not in this demo', feedback: 'Feedback on this screen', screen: 'Screen', link: 'Link' },
  vi: { screens: 'màn hình', start: 'Bắt đầu', all: 'Tất cả', phone: 'App', web: 'Web', fixed: 'Khung', open: 'Mở', list: 'Danh sách màn hình', groups: 'nhóm', back: 'Tất cả màn hình', made: 'Bản demo bấm được, xuất từ canvas thiết kế', missing: 'không có trong demo', feedback: 'Góp ý màn hình này', screen: 'Màn hình', link: 'Link' },
}

const DEMO_CSS = `html,body{margin:0}
body.dc-phone,body.dc-fixed{height:100vh;background:#1c2027;overflow:hidden}
#dc-stage,.dc-stage{position:relative}
body.dc-phone .dc-stage,body.dc-fixed .dc-stage{position:fixed;left:50%;top:50%;overflow:hidden;transform:translate(-50%,-50%) scale(var(--dc-k,1));transform-origin:center center;background:#fff}
body.dc-phone .dc-stage{border-radius:44px;box-shadow:0 0 0 10px #0b0d10,0 0 0 11px #3a3f48,0 30px 80px rgba(0,0,0,.55)}
body.dc-fixed .dc-stage{box-shadow:0 20px 60px rgba(0,0,0,.45)}
@media (max-width:520px){body.dc-phone{height:auto;overflow:auto;background:none}body.dc-phone .dc-stage{position:relative;left:auto;top:auto;border-radius:0;box-shadow:none;transform:none}}
.dc-demo-nav{position:fixed;right:14px;bottom:14px;z-index:2147483000;width:38px;height:38px;border-radius:19px;display:grid;place-items:center;background:rgba(20,24,32,.72);color:#fff;text-decoration:none;opacity:.55;transition:opacity .15s;box-shadow:0 4px 14px rgba(0,0,0,.25)}
.dc-demo-fb{right:60px;border:0;padding:0;cursor:pointer;font:inherit}
.dc-demo-fb[hidden]{display:none}
.dc-demo-nav:hover,.dc-demo-nav:focus-visible{opacity:1}
.dc-demo-nav svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2}
`
const FIT = `(function(){var s=document.querySelector('.dc-stage');var b=document.body;if(!s||!/dc-(phone|fixed)/.test(b.className))return;function f(){var w=s.offsetWidth,h=s.offsetHeight,k=Math.min(1,(innerWidth-48)/w,(innerHeight-48)/h);s.style.setProperty('--dc-k',String(k))}addEventListener('resize',f);f()})();`
const NAV_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/></svg>'

const FB_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/></svg>'
// The Feedback button (one file for every screen). claude.ai's comment box first — the composer-only grant, so
// nothing is posted by the page and nobody is asked for consent; the --feedback link when that box is not here.
const FEEDBACK_JS = `(function(){var cfg;try{cfg=JSON.parse(document.getElementById('dc-feedback').textContent)}catch(e){return}
var btn=document.getElementById('dc-fb'),stage=document.querySelector('.dc-stage');if(!btn||!stage)return;var comments=null;
function show(){btn.hidden=!(comments||cfg.to)}
function enc(k){return encodeURIComponent(k==='url'?location.href:cfg[k]||'')}
function open(href){var a=document.createElement('a');a.href=href;a.target='_blank';a.rel='noopener';document.body.appendChild(a);a.click();a.remove()}
function fallback(){var to=cfg.to;if(!to)return;var q=to.indexOf('?')<0?'?':'&';
if(/^mailto:/i.test(to)){open(to+q+'subject='+encodeURIComponent('['+cfg.demo+'] '+cfg.title)+'&body='+encodeURIComponent(cfg.labels.screen+': '+cfg.title+' ('+cfg.screen+')\\n'+cfg.labels.link+': '+location.href+'\\n\\n'));return}
open(/\\{(screen|title|demo|url)\\}/.test(to)?to.replace(/\\{(screen|title|demo|url)\\}/g,function(m,k){return enc(k)}):to+q+'screen='+enc('screen'))}
btn.addEventListener('click',function(){if(!comments)return fallback();comments.openComposer({element:stage}).catch(function(e){var c=e&&e.code;if(c==='rate_limited')return;if(c==='unavailable'){comments=null;show()}fallback()})});
show();
try{if(window.claude&&typeof window.claude.use==='function')window.claude.use('comments').then(function(c){comments=c||null;show()},function(){})}catch(e){}})();
`
// A stable, unique element id per screen: the comment anchor claude.ai stores, and how feedback maps back to a file.
export const anchorOf = (file) => `screen-${String(file).replace(/\.dc\.html$|\.html$/, '').replace(/[^A-Za-z0-9_-]+/g, '-')}`

function pageHtml({ file, sc, imports, board, group, lang, t, blob, anchor, feedback, demo }) {
  const depth = file.split('/').length - 1
  const root = '../'.repeat(depth)
  const dev = deviceOf(board)
  const w = (sc.preview && sc.preview.width) || board.w
  const h = (sc.preview && sc.preview.height) || board.h
  const head = [...new Set([...sc.headLines, ...imports.flatMap((x) => x.sc.headLines)])].map(blob).join('\n')
  const helmets = [sc.helmet, ...imports.map((x) => x.sc.helmet)].filter(Boolean).map(blob).join('\n')
  const stage = dev === 'web' ? '' : ` style="width:${w}px;height:${h}px"`
  const comps = [{ name: 'main', sc }, ...imports]
  return `<!doctype html>
<html lang="${esc(sc.lang || lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(board.title || sc.title || file)}</title>
${head}
${helmets}
<link rel="stylesheet" href="${root}_demo/demo.css">
</head>
<body class="dc-${dev}">
<div id="${esc(anchor)}" class="dc-stage"${stage}><div id="dc-root"></div></div>
<a class="dc-demo-nav" href="${root}index.html#${esc(group)}" title="${esc(t.list)}" aria-label="${esc(t.list)}" data-uncommentable>${NAV_ICON}</a>
<button type="button" id="dc-fb" class="dc-demo-nav dc-demo-fb" title="${esc(t.feedback)}" aria-label="${esc(t.feedback)}" data-uncommentable hidden>${FB_ICON}</button>
<script type="application/json" id="dc-feedback">${json({ screen: board.file, title: board.title || sc.title || file, demo, to: feedback || null, labels: { screen: t.screen, link: t.link } })}</script>
<script type="application/json" id="dc-page">${json({ root, main: 'main', props: sc.props })}</script>
${comps.map((c) => `<script type="application/json" data-dc-tpl="${esc(c.name)}">${json(blob(c.sc.tpl))}</script>\n<script type="text/plain" data-dc-logic="${esc(c.name)}">${blob(c.sc.logic).replace(/<\/script/gi, '<\\/script')}</script>`).join('\n')}
<script src="${REACT}" crossorigin="anonymous"></script>
<script src="${REACT_DOM}" crossorigin="anonymous"></script>
<script src="${root}_demo/dc-runtime.js"></script>
<script>${FIT}</script>
<script src="${root}_demo/feedback.js"></script>
</body>
</html>
`
}

function indexHtml({ title, groups, lang, t, url }) {
  const card = (g) => {
    const devs = [...new Set(g.screens.map((s) => s.device))].map((d) => t[d]).join(' · ')
    return `<article class="card"><h2>${esc(g.name)}</h2><p class="meta">${g.screens.length} ${esc(t.screens)} · ${esc(devs)}</p>
<div class="row"><a class="btn primary" href="${esc(g.startHref)}">${esc(t.start)}</a><a class="btn" href="#${esc(g.slug)}">${esc(t.list)}</a></div></article>`
  }
  const list = (g) => {
    const secs = []
    for (const s of g.screens) { const last = secs[secs.length - 1]; if (!last || last.name !== s.section) secs.push({ name: s.section, items: [s] }); else last.items.push(s) }
    return `<section class="group" id="g-${esc(g.slug)}" data-slug="${esc(g.slug)}"><div class="ghead"><h2>${esc(g.name)}</h2><a class="btn primary" href="${esc(g.startHref)}">${esc(t.start)}</a></div>
${secs.map((s) => `${s.name ? `<h3>${esc(s.name)}</h3>` : ''}<ul>${s.items.map((x) => `<li><a href="${esc(x.href)}"><span class="dev dev-${x.device}">${esc(t[x.device])}</span><span class="name">${esc(x.title)}</span>${x.file === g.start ? `<span class="tag">${esc(t.start)}</span>` : ''}</a></li>`).join('')}</ul>`).join('\n')}
</section>`
  }
  const total = groups.reduce((n, g) => n + g.screens.length, 0)
  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f4f5f7;--fg:#151a22;--muted:#5d6672;--card:#fff;--line:#e3e6eb;--accent:#0a4fb0;--on-accent:#fff;--soft:#e9eef7}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1217;--fg:#e8ebf0;--muted:#9aa3af;--card:#181c23;--line:#2a2f38;--accent:#6ea0ff;--on-accent:#0b1220;--soft:#1d2533}}
:root[data-theme="dark"]{--bg:#0f1217;--fg:#e8ebf0;--muted:#9aa3af;--card:#181c23;--line:#2a2f38;--accent:#6ea0ff;--on-accent:#0b1220;--soft:#1d2533}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1120px;margin:0 auto;padding:40px 16px 64px}
header h1{margin:0;font-size:28px;line-height:1.25}header p{margin:6px 0 0;color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;margin:28px 0 40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;display:flex;flex-direction:column;gap:6px}
.card h2{margin:0;font-size:18px;line-height:1.3}.meta{margin:0;color:var(--muted);font-size:13px}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.btn{display:inline-flex;align-items:center;min-height:40px;padding:0 14px;border-radius:10px;border:1px solid var(--line);color:var(--fg);text-decoration:none;font-weight:600;font-size:14px}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.group{margin-top:28px}.ghead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 8px}.group h2{font-size:20px;margin:0}.group h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:18px 0 6px}
ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:6px}
li a{display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;background:var(--card);border:1px solid var(--line);color:var(--fg);text-decoration:none;min-height:44px}
li a:hover{border-color:var(--accent)}.name{flex:1;min-width:0}
.dev{font-size:11px;font-weight:700;padding:2px 7px;border-radius:6px;background:var(--soft);color:var(--accent);flex:none}
.tag{font-size:11px;color:var(--muted);flex:none}
.only .card,.only .group{display:none}.only .group.on{display:block}.back{display:none}.only .back{display:inline-flex}
</style>
</head>
<body>
<main>
<header><h1>${esc(title)}</h1><p>${esc(t.made)} · ${groups.length > 1 ? `${groups.length} ${esc(t.groups)} · ` : ''}${total} ${esc(t.screens)}</p>
<div class="row"><a class="btn back" href="#">${esc(t.back)}</a></div></header>
${groups.length > 1 ? `<div class="cards">${groups.map(card).join('\n')}</div>` : ''}
${groups.map(list).join('\n')}
${url ? `<p class="meta" style="margin-top:40px">Canvas: ${esc(url)}</p>` : ''}
</main>
<script>
(function(){function f(){var h=decodeURIComponent(location.hash.slice(1));var gs=document.querySelectorAll('.group');var hit=false;gs.forEach(function(g){var on=g.getAttribute('data-slug')===h;g.classList.toggle('on',on);if(on)hit=true});document.body.classList.toggle('only',hit);if(hit)scrollTo(0,0)}addEventListener('hashchange',f);f()})();
</script>
</body>
</html>
`
}

export function exportDemo(src, out, { lang = 'en', title, url, feedback } = {}) {
  const { proj, canvas } = readCanvas(src)
  const t = L[lang] || L.en
  out = resolve(out)
  mkdirSync(out, { recursive: true })
  const warnings = []
  // A bare address is an email; no --feedback on a re-export keeps the one the last export used.
  if (!feedback && existsSync(join(out, 'demo.json'))) try { feedback = JSON.parse(readFileSync(join(out, 'demo.json'), 'utf8')).feedback || null } catch {}
  if (feedback && /^[^\s@:/]+@[^\s@/]+\.[a-z]{2,}$/i.test(feedback)) feedback = `mailto:${feedback}`
  if (feedback && !/^(mailto:[^\s]+|https?:\/\/[^\s]+)$/i.test(feedback)) { warnings.push(`--feedback ${feedback}: not a mailto: or http(s) link — ignored`); feedback = null }
  const demoName = title || canvas.title || 'Demo'
  const groups = layout(canvas)
  const exists = new Set(Object.keys(canvas.boards))
  const blobDir = join(resolve(proj, '..'), '_blob')
  const blobDir2 = join(proj, '_blob')
  const blobFiles = {}
  for (const d of [blobDir, blobDir2]) if (existsSync(d)) for (const n of readdirSync(d)) blobFiles[n.replace(/\.[^.]+$/, '')] = join(d, n)
  const missingBlobs = new Set()
  const usedBlobs = new Set()
  const blobFix = (root) => (x) => {
    const fix = (s) => s.replace(/(?:\.\.\/)*\/?_blob\/([A-Za-z0-9_-]+)/g, (m, id) => {
      if (!blobFiles[id]) { missingBlobs.add(id); return m }
      usedBlobs.add(id)
      return `${root}_blob/${relative(dirname(blobFiles[id]), blobFiles[id])}`
    })
    if (typeof x === 'string') return fix(x)
    return JSON.parse(fix(JSON.stringify(x)))
  }
  const cache = {}
  const screen = (file) => (cache[file] ||= (() => { const p = join(proj, file); return existsSync(p) ? parseScreen(readFileSync(p, 'utf8')) : null })())
  const screens = []
  for (const g of groups) {
    for (const b of g.screens) {
      const sc = screen(b.file)
      if (!sc) { warnings.push(`${b.file}: listed in canvas.json but the file is missing`); continue }
      // Child components (<dc-import name="Card">) are sibling files; collect them and theirs.
      const imports = []
      const seen = new Set([b.file])
      const visit = (from, s) => {
        for (const el of find(s.tpl, (n) => n[0].toLowerCase() === 'dc-import')) {
          const name = attr(el, 'name')
          const f = join(dirname(from), `${name}.dc.html`).split(sep).join('/')
          if (seen.has(f)) continue
          seen.add(f)
          const c = screen(f)
          if (!c) { warnings.push(`${b.file}: <dc-import name="${name}"> — ${f} not found`); continue }
          imports.push({ name, sc: c })
          visit(f, c)
        }
      }
      visit(b.file, sc)
      const links = linksOf(sc).map((h) => resolveLink(b.file, h))
      for (const l of links) if (!exists.has(l)) warnings.push(`${b.file}: links to ${l}, which is not on the canvas`)
      const sources = Object.fromEntries([['main', { tpl: sc.tpl, logic: sc.logic, props: sc.props }], ...imports.map((x) => [x.name, { tpl: x.sc.tpl, logic: x.sc.logic, props: x.sc.props }])])
      try { smoke('main', sources) } catch (e) { warnings.push(`${b.file}: screen script fails in a test render — ${String(e.message || e).split('\n')[0]}`) }
      const outFile = b.file.replace(/\.dc\.html$/, '.html')
      const depth = outFile.split('/').length - 1
      mkdirSync(dirname(join(out, outFile)), { recursive: true })
      const anchor = anchorOf(b.file)
      writeFileSync(join(out, outFile), pageHtml({ file: outFile, sc, imports, board: b, group: g.slug, lang, t, blob: blobFix('../'.repeat(depth)), anchor, feedback, demo: demoName }))
      screens.push({ file: b.file, page: outFile, title: b.title || sc.title || b.file, group: g.slug, section: b.section, device: deviceOf(b), w: b.w, h: b.h, interactive: !!b.is_interactive, links, anchor })
    }
  }
  // Design-system files and any other support file the screens reference (css, fonts, images, json).
  for (const rel of walk(proj)) {
    const p = rel.split(sep).join('/')
    if (p.endsWith('.dc.html') || p === 'canvas.json') continue
    mkdirSync(dirname(join(out, p)), { recursive: true })
    copyFileSync(join(proj, rel), join(out, p))
  }
  for (const id of usedBlobs) { mkdirSync(join(out, '_blob'), { recursive: true }); copyFileSync(blobFiles[id], join(out, '_blob', relative(dirname(blobFiles[id]), blobFiles[id]))) }
  if (missingBlobs.size) warnings.push(`uploaded assets not downloaded (run \`canvas.mjs blobs\`): ${[...missingBlobs].join(', ')}`)
  mkdirSync(join(out, '_demo'), { recursive: true })
  writeFileSync(join(out, '_demo', 'demo.css'), DEMO_CSS)
  writeFileSync(join(out, '_demo', 'feedback.js'), FEEDBACK_JS)
  copyFileSync(join(HERE, 'canvas-runtime.js'), join(out, '_demo', 'dc-runtime.js'))
  const byFile = Object.fromEntries(screens.map((s) => [s.file, s]))
  const gs = groups.map((g) => ({
    slug: g.slug, name: g.name, start: g.start, startHref: (byFile[g.start] || {}).page || '',
    screens: g.screens.filter((b) => byFile[b.file]).map((b) => ({ ...byFile[b.file], href: byFile[b.file].page })),
  })).filter((g) => g.screens.length)
  const name = demoName
  writeFileSync(join(out, 'index.html'), indexHtml({ title: name, groups: gs, lang, t, url }))
  const manifest = { title: name, url: url || '', exportedAt: new Date().toISOString(), feedback: feedback || null, groups: gs.map(({ slug, name: n, start, startHref, screens: s }) => ({ slug, name: n, start, startHref, count: s.length })), screens, warnings }
  writeFileSync(join(out, 'demo.json'), JSON.stringify(manifest, null, 2))
  return { out, title: name, screens: screens.length, groups: manifest.groups, files: walk(out).length, warnings }
}

export function summary(src, { url } = {}) {
  const { proj, canvas } = readCanvas(src)
  const groups = layout(canvas)
  const ds = (canvas.designSystems || []).map((d) => `${d.title} (ds/${d.namespace}/)`).join(', ') || 'none installed'
  const lines = [`# Canvas: ${canvas.title || 'untitled'}`, '', `Source: ${url || '(local copy)'} · ${Object.keys(canvas.boards).length} screens · design system: ${ds}`,
    `Screen sources (exact markup, states, copy): \`${proj}/<file>\`. Clickable reference: the \`demo/\` folder next to them (\`canvas.mjs serve\`).`, '']
  for (const g of groups) {
    lines.push(`## ${g.name} — start: ${g.start}`)
    for (const n of g.notes) lines.push(`> ${n.replace(/\n+/g, ' ').slice(0, 400)}`)
    let sec = null
    for (const b of g.screens) {
      if (b.section !== sec) { sec = b.section; if (sec) lines.push('', `### ${sec}`); lines.push('', '| Screen | File | Device | Size | Links to |', '|---|---|---|---|---|') }
      let links = []
      try { const sc = parseScreen(readFileSync(join(proj, b.file), 'utf8')); links = linksOf(sc).map((h) => resolveLink(b.file, h)) } catch {}
      lines.push(`| ${(b.title || b.file).replace(/\|/g, '/')} | ${b.file} | ${deviceOf(b)}${b.is_interactive ? ' · interactive' : ''} | ${b.w}×${b.h} | ${links.join(', ') || '–'} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function blobs(src) {
  const { proj } = readCanvas(src)
  const ids = new Set()
  for (const rel of walk(proj)) if (/\.(html|css|json|js|svg)$/i.test(rel)) for (const m of readFileSync(join(proj, rel), 'utf8').matchAll(/_blob\/([A-Za-z0-9_-]{6,})/g)) ids.add(m[1])
  const have = new Set()
  for (const d of [join(resolve(proj, '..'), '_blob'), join(proj, '_blob')]) if (existsSync(d)) for (const n of readdirSync(d)) have.add(n.replace(/\.[^.]+$/, ''))
  return [...ids].map((id) => ({ id, have: have.has(id) }))
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.ico': 'image/x-icon', '.mp4': 'video/mp4' }
export function serve(dir, port = 4173) {
  dir = resolve(dir)
  return new Promise((ok) => {
    const srv = createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      if (p.endsWith('/')) p += 'index.html'
      const f = resolve(dir, `.${p}`)
      if (!(f === dir || f.startsWith(dir + sep)) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'content-type': TYPES[extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' })
      res.end(readFileSync(f))
    })
    const tryPort = (n, left) => {
      srv.once('error', (e) => { if (e.code === 'EADDRINUSE' && left) tryPort(n + 1, left - 1); else throw e })
      srv.listen(n, '127.0.0.1', () => ok({ url: `http://localhost:${n}/`, port: n, close: () => srv.close() }))
    }
    tryPort(Number(port) || 4173, 20)
  })
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, b, ...rest] = process.argv.slice(2)
  const all = process.argv.slice(2)
  const flag = (n) => { const i = all.indexOf(`--${n}`); return i >= 0 ? all[i + 1] : undefined }
  const usage = () => { console.error('usage: canvas.mjs export <src> <out> [--lang vi|en] [--title T] [--url U] [--feedback mailto:…|https://…] | summary <src> [--url U] | blobs <src> | serve <out> [--port N]'); process.exit(2) }
  void rest
  if (cmd === 'export' && a && b) console.log(JSON.stringify(exportDemo(a, b, { lang: flag('lang'), title: flag('title'), url: flag('url'), feedback: flag('feedback') }), null, 2))
  else if (cmd === 'summary' && a) console.log(summary(a, { url: flag('url') }))
  else if (cmd === 'blobs' && a) console.log(JSON.stringify(blobs(a)))
  else if (cmd === 'serve' && a) serve(a, flag('port')).then((s) => console.log(JSON.stringify({ url: s.url, port: s.port })))
  else usage()
}
