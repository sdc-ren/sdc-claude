// A Claude Design canvas → a clickable demo: template parsing, grouping by role, the export, and the runtime's
// rendering of holes, loops, branches, handlers and links (with a stub React, no browser).
// Run: node --test tests/canvas.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { exportDemo, layout, parseHtml, parseScreen, screenPath, summary } from '../scripts/canvas.mjs'

const S = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'tf-canvas-')))

const screen = (title, body, logic = 'class Component extends DCLogic { renderVals() { return {}; } }', size = '{"width":390,"height":844}') => `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>${title}</title>
<script src="./support.js"></script>
<link rel="stylesheet" href="ds/demo/tokens.css">
</head>
<body>
<x-dc>
<helmet><style>body{margin:0}</style></helmet>
${body}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"theme":{"editor":"enum","options":["light","dark"],"default":"light"},"$preview":${size}}'>
${logic}
</script>
</body>
</html>
`

function canvasFixture() {
  const root = tmp()
  const p = join(root, 'project')
  mkdirSync(join(p, 'ds', 'demo'), { recursive: true })
  writeFileSync(join(p, 'ds', 'demo', 'tokens.css'), ':root{--ink:#111}')
  writeFileSync(join(p, 'canvas.json'), JSON.stringify({
    v: 3, title: 'Shop demo', launch: { view: 'canvas' },
    boards: {
      'Main.dc.html': { x: 0, y: 0, w: 390, h: 844, title: 'App · Home', is_interactive: true },
      'Cart.dc.html': { x: 470, y: 0, w: 390, h: 844, title: 'App · Cart' },
      'Admin.dc.html': { x: 0, y: 1400, w: 1440, h: 900, expand: 'fill', title: 'Admin · Orders' },
      'Card.dc.html': { x: 940, y: 0, w: 300, h: 120, title: 'Card' },
    },
    order: ['Main.dc.html', 'Cart.dc.html', 'Admin.dc.html', 'Card.dc.html'],
    notes: {
      app: { x: 0, y: -400, text: 'Customer · App', kind: 'title1', size: 120, maxW: 2000 },
      appRow: { x: 0, y: -200, text: 'Buying', kind: 'title1', size: 40, maxW: 2000 },
      admin: { x: 0, y: 1100, text: 'Office · Web', kind: 'title1', size: 120, maxW: 2000 },
      sticky: { x: 1300, y: 0, w: 300, text: 'Prices are samples.' },
    },
  }))
  writeFileSync(join(p, 'Main.dc.html'), screen('Home', `<div class="fx" data-theme="{{theme}}" style="width: 390px; height: 844px; display: flex; flex-direction: column; -webkit-font-smoothing: antialiased">
  <h1 style="margin: 0">Hi {{name}} &amp; co</h1>
  <sc-for list="{{items}}" as="it" hint-placeholder-count="2"><button type="button" aria-pressed="{{it.on}}" onClick="{{it.pick}}">{{it.label}} #{{$index}}</button></sc-for>
  <sc-if value="{{picked}}" hint-placeholder-val="{{false}}"><p class="picked">Picked {{picked}}</p></sc-if>
  <table><tbody><sc-for list="{{items}}" as="r"><tr><td>{{r.label}}</td></tr></sc-for></tbody></table>
  <input value="typed" class="field">
  <svg viewBox="0 0 24 24" aria-hidden="true"><path stroke-width="2" d="M5 12l5 5L20 7"></path></svg>
  <dc-import name="Card" label="{{name}}" hint-size="300px,120px"></dc-import>
  <a href="Cart.dc.html" class="go">Cart</a>
  <a href="Missing.dc.html">Nowhere</a>
</div>`, `class Component extends DCLogic {
  constructor(props) { super(props); this.state = { picked: '' }; }
  renderVals() {
    const items = ['Tea', 'Cake'].map((label) => ({ label, on: this.state.picked === label ? 'true' : 'false', pick: () => this.setState({ picked: label }) }));
    return { theme: this.props.theme ?? 'light', name: 'Lan', items, picked: this.state.picked };
  }
}`))
  writeFileSync(join(p, 'Cart.dc.html'), screen('Cart', '<div><a href="Main.dc.html">Back</a></div>'))
  writeFileSync(join(p, 'Admin.dc.html'), screen('Orders', '<main style="min-height: 900px"><a href="/Main.dc.html">App</a></main>', undefined, '{"width":1440,"height":900}'))
  writeFileSync(join(p, 'Card.dc.html'), screen('Card', '<div class="card">Card for {{label}}</div>', 'class Component extends DCLogic { renderVals() { return { label: this.props.label }; } }', '{"width":300,"height":120}'))
  return root
}

test('the template parser keeps loops inside tables and decodes entities', () => {
  const t = parseHtml('<table><tbody><sc-for list="{{rows}}" as="r"><tr><td>{{r.a}} &amp; b</td></tr></sc-for></tbody></table><br><input value="x &lt; y">')
  assert.equal(t[0][0], 'table')
  const tbody = t[0][2][0]
  assert.equal(tbody[2][0][0], 'sc-for')
  assert.equal(tbody[2][0][2][0][2][0][2][0], '{{r.a}} & b')
  assert.deepEqual(t[1], ['br', [], []])
  assert.deepEqual(t[2][1], [['value', 'x < y']])
})

test('a screen file splits into template, logic, head lines and prop defaults', () => {
  const sc = parseScreen(screen('Home', '<p>{{x}}</p>'))
  assert.equal(sc.title, 'Home')
  assert.deepEqual(sc.props, { theme: 'light' })
  assert.match(sc.logic, /class Component extends DCLogic/)
  assert.ok(sc.headLines.some((l) => l.includes('tokens.css')))
  assert.ok(!sc.headLines.some((l) => l.includes('support.js')))
  assert.equal(sc.helmet, '<style>body{margin:0}</style>')
})

test('screens are grouped by the canvas\'s biggest titles, sectioned by the smaller ones', () => {
  const root = canvasFixture()
  const canvas = JSON.parse(readFileSync(join(root, 'project', 'canvas.json'), 'utf8'))
  const g = layout(canvas)
  assert.deepEqual(g.map((x) => [x.slug, x.name, x.start, x.screens.map((s) => s.file)]), [
    ['customer', 'Customer · App', 'Main.dc.html', ['Main.dc.html', 'Cart.dc.html', 'Card.dc.html']],
    ['office', 'Office · Web', 'Admin.dc.html', ['Admin.dc.html']],
  ])
  assert.equal(g[0].screens[0].section, 'Buying')
  assert.deepEqual(g[0].notes, ['Prices are samples.'])
})

test('the export writes one page per screen, the design system, the runtime and an index', () => {
  const root = canvasFixture()
  const out = join(tmp(), 'demo')
  const r = exportDemo(root, out, { lang: 'vi', url: 'https://claude.ai/artifact/abcdefghijk' })
  assert.equal(r.screens, 4)
  assert.deepEqual(r.groups.map((x) => [x.slug, x.startHref, x.count]), [['customer', 'Main.html', 3], ['office', 'Admin.html', 1]])
  assert.deepEqual(r.warnings, ['Main.dc.html: links to Missing.dc.html, which is not on the canvas'])
  for (const f of ['index.html', 'Main.html', 'Cart.html', 'Admin.html', 'ds/demo/tokens.css', '_demo/dc-runtime.js', '_demo/demo.css', 'demo.json']) assert.ok(existsSync(join(out, f)), f)
  const main = readFileSync(join(out, 'Main.html'), 'utf8')
  assert.match(main, /<body class="dc-phone">/)
  assert.match(main, /data-dc-tpl="Card"/) // the imported child travels with the page
  assert.match(main, /href="index.html#customer"/)
  assert.doesNotMatch(main, /support\.js/)
  assert.match(readFileSync(join(out, 'Admin.html'), 'utf8'), /<body class="dc-web">/)
  const index = readFileSync(join(out, 'index.html'), 'utf8')
  assert.match(index, /Customer · App/)
  assert.match(index, /Bắt đầu/)
  const manifest = JSON.parse(readFileSync(join(out, 'demo.json'), 'utf8'))
  assert.deepEqual(manifest.screens.find((s) => s.file === 'Main.dc.html').links, ['Cart.dc.html', 'Missing.dc.html'])
  assert.match(summary(root), /## Customer · App — start: Main\.dc\.html/)
})

test('a screen whose script throws is reported, not silently exported', () => {
  const root = canvasFixture()
  writeFileSync(join(root, 'project', 'Cart.dc.html'), screen('Cart', '<button onClick="{{boom}}">x</button>', 'class Component extends DCLogic { renderVals() { return { boom: () => { throw new Error("kaput") } }; } }'))
  const r = exportDemo(root, join(tmp(), 'demo'))
  assert.ok(r.warnings.some((w) => /Cart\.dc\.html: .*onClick handler: kaput/.test(w)), r.warnings.join('\n'))
})

test('the runtime renders holes, loops, branches, handlers, imports and links like the canvas', () => {
  const root = canvasFixture()
  const out = join(tmp(), 'demo')
  exportDemo(root, out)
  const html = readFileSync(join(out, 'Main.html'), 'utf8')
  const sources = {}
  for (const m of html.matchAll(/data-dc-tpl="([^"]+)">([\s\S]*?)<\/script>/g)) (sources[m[1]] ||= {}).tpl = JSON.parse(m[2])
  for (const m of html.matchAll(/data-dc-logic="([^"]+)">([\s\S]*?)<\/script>/g)) (sources[m[1]] ||= {}).logic = m[2]
  // Stub React: elements are plain objects; class components render on demand.
  const R = {
    Fragment: 'F',
    Component: class { constructor(p) { this.props = p || {}; this.state = {} } setState(u) { this.state = { ...this.state, ...u } } },
    createElement: (t, p, ...c) => ({ t, p: p || {}, c }),
  }
  const box = {}
  vm.createContext(box)
  vm.runInContext(readFileSync(join(S, 'canvas-runtime.js'), 'utf8'), box)
  const ctx = box.DCRuntime.makeComponents(R, sources, '')
  const app = new ctx.components.main({ theme: 'light' })
  const flat = (e, out = []) => { if (e == null) return out; if (typeof e === 'string') { out.push(e); return out } if (typeof e.t === 'function') { flat(new e.t(e.p).render(), out); return out } out.push(e); (e.c || []).forEach((x) => flat(x, out)); return out }
  const els = (tree) => flat(tree).filter((x) => typeof x === 'object')
  const text = (tree) => flat(tree).filter((x) => typeof x === 'string').join('|')
  let tree = app.render()
  assert.match(text(tree), /Hi Lan & co/)
  assert.match(text(tree), /Tea #0\|Cake #1/)
  assert.doesNotMatch(text(tree), /Picked/)
  assert.match(text(tree), /Card for Lan/)
  const root0 = els(tree).find((e) => e.t === 'div')
  assert.equal(root0.p['data-theme'], 'light')
  assert.equal(root0.p.style.flexDirection, 'column')
  assert.equal(root0.p.style.WebkitFontSmoothing, 'antialiased')
  assert.equal(els(tree).find((e) => e.t === 'input').p.defaultValue, 'typed')
  assert.equal(els(tree).find((e) => e.t === 'path').p.strokeWidth, '2')
  assert.equal(els(tree).find((e) => e.t === 'svg').p.viewBox, '0 0 24 24')
  assert.equal(els(tree).find((e) => e.t === 'a').p.href, 'Cart.html')
  assert.ok(!els(tree).some((e) => e.t === 'tbody' && e.c.some((c) => typeof c === 'string')), 'no whitespace text inside tbody')
  // Press "Cake": state changes, the branch appears, aria-pressed follows.
  els(tree).filter((e) => e.t === 'button')[1].p.onClick()
  tree = app.render()
  assert.match(text(tree), /Picked Cake/)
  assert.deepEqual(els(tree).filter((e) => e.t === 'button').map((b) => b.p['aria-pressed']), ['false', 'true'])
  // A link with a leading slash points at the demo root from a nested page.
  assert.equal(box.DCRuntime.href('/Main.dc.html#top', '../'), '../Main.html#top')
  assert.equal(box.DCRuntime.href('https://x.dev/a.dc.html', ''), 'https://x.dev/a.dc.html')
})

test('each screen has a Feedback button: claude.ai comments first, the --feedback link otherwise', async () => {
  const root = canvasFixture()
  const out = join(tmp(), 'demo')
  const r = exportDemo(root, out, { lang: 'vi', title: 'Shop', feedback: 'mailto:pm@example.com' })
  assert.deepEqual(r.warnings, ['Main.dc.html: links to Missing.dc.html, which is not on the canvas'])
  const page = readFileSync(join(out, 'Cart.html'), 'utf8')
  assert.match(page, /<div id="screen-Cart" class="dc-stage"/)
  assert.match(page, /_demo\/feedback\.js/)
  assert.equal(JSON.parse(readFileSync(join(out, 'demo.json'), 'utf8')).screens.find((s) => s.file === 'Cart.dc.html').anchor, 'screen-Cart')
  const cfg = page.match(/id="dc-feedback">([\s\S]*?)<\/script>/)[1]
  const js = readFileSync(join(out, '_demo', 'feedback.js'), 'utf8')
  // A tiny DOM: the button, the stage, the config, and links the script opens.
  const run = (cfgText, claude) => {
    const opened = []
    const btn = { hidden: true, on: null, addEventListener: (_, f) => { btn.on = f } }
    const stage = { id: 'screen-Cart' }
    const document = {
      getElementById: (id) => (id === 'dc-feedback' ? { textContent: cfgText } : id === 'dc-fb' ? btn : null),
      querySelector: () => stage,
      createElement: () => ({ click() { opened.push(this.href) }, remove() {} }),
      body: { appendChild() {} },
    }
    const window = { claude }
    vm.runInNewContext(js, { document, window, location: { href: 'https://x/Cart.html' }, encodeURIComponent, JSON })
    return { btn, stage, opened }
  }
  // Inside an artifact where the viewer can comment: the button opens claude.ai's composer on this screen.
  const calls = []
  const a = run(cfg, { use: async (n) => (n === 'comments' ? { openComposer: async (t) => { calls.push(t); return { opened: true } } } : null) })
  await new Promise((ok) => setTimeout(ok, 0))
  assert.equal(a.btn.hidden, false)
  a.btn.on()
  assert.equal(calls[0].element, a.stage)
  assert.deepEqual(a.opened, [])
  // No comments here (local demo, or a viewer who cannot comment): an email about this screen.
  const b = run(cfg, undefined)
  assert.equal(b.btn.hidden, false)
  b.btn.on()
  assert.match(b.opened[0], /^mailto:pm@example\.com\?subject=%5BShop%5D%20App%20%C2%B7%20Cart&body=M%C3%A0n%20h%C3%ACnh%3A%20App%20%C2%B7%20Cart%20\(Cart\.dc\.html\)%0ALink%3A%20https%3A%2F%2Fx%2FCart\.html/)
  // A form link gets the screen filled in.
  const c = run(cfg.replace('mailto:pm@example.com', 'https://forms.example.com/f?entry.1={screen}'), undefined)
  c.btn.on()
  assert.equal(c.opened[0], 'https://forms.example.com/f?entry.1=Cart.dc.html')
  // Neither: no button.
  assert.equal(run(cfg.replace('"mailto:pm@example.com"', 'null'), undefined).btn.hidden, true)
  // A bare address is an email; a re-export without --feedback keeps it; a bad value is reported and dropped.
  const d2 = join(tmp(), 'd2')
  exportDemo(root, d2, { feedback: 'qc@example.com' })
  exportDemo(root, d2)
  assert.equal(JSON.parse(readFileSync(join(d2, 'demo.json'), 'utf8')).feedback, 'mailto:qc@example.com')
  assert.ok(exportDemo(root, join(tmp(), 'd3'), { feedback: 'ftp://x' }).warnings.some((w) => /--feedback ftp:\/\/x: not a mailto/.test(w)))
})

test('a screen named by the canvas is a .dc.html file inside the canvas folder, or nothing', () => {
  const proj = realpathSync(mkdtempSync(join(tmpdir(), 'tf-cv-')))
  assert.equal(screenPath(proj, 'admin/Home.dc.html'), join(proj, 'admin', 'Home.dc.html'))
  assert.equal(screenPath(proj, '../secret.dc.html'), '', 'no climbing out with ..')
  assert.equal(screenPath(proj, 'a/../../secret.dc.html'), '')
  assert.equal(screenPath(proj, join(tmpdir(), 'x.dc.html')), '', 'no absolute path')
  assert.equal(screenPath(proj, '../canary.txt'), '', 'only screen files')
  // A `file` field inside a board does not replace the board's key.
  const l = layout({ boards: { 'Home.dc.html': { file: '../canary.txt', x: 0, y: 0, w: 10, h: 10 } }, notes: {} })
  assert.deepEqual(l.flatMap((g) => g.screens.map((s) => s.file)), ['Home.dc.html'])
})
