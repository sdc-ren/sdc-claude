// tf demo runtime — runs one screen exported from a Claude Design canvas (`canvas.mjs export`) as a plain web page.
// The canvas stores each screen as a .dc.html Design Component: a template (`{{holes}}`, <sc-for>, <sc-if>,
// <dc-import>, <x-import>) plus a `class Component extends DCLogic` whose renderVals() feeds it. The exporter turns
// the template into a JSON tree (so the browser's HTML parser never reshapes it, e.g. a <sc-for> inside <tbody>);
// this file rebuilds it as React 18 elements on every render, so state, handlers and links work as on the canvas.
//
// Page contract (written by canvas.mjs):
//   <script type="application/json" id="dc-page">{ "root": "../", "props": {…}, "main": "<name>" }</script>
//   <script type="application/json" data-dc-tpl="<name>">[tree]</script>   one per component (the screen + imports)
//   <script type="text/plain" data-dc-logic="<name>">class Component extends DCLogic { … }</script>
// Tree nodes: a string (text) or [tag, [[attr, value], …], [children…]].
;(function (G) {
  'use strict'
  const HOLE = /\{\{\s*([^{}]+?)\s*\}\}/g
  const WHOLE = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/
  const LITERAL = { true: true, false: false, null: null, undefined: undefined }

  function lookup(scope, path) {
    path = String(path).trim()
    if (path in LITERAL) return LITERAL[path]
    if (/^-?\d+(?:\.\d+)?$/.test(path)) return Number(path)
    const q = path.match(/^(['"])(.*)\1$/)
    if (q) return q[2]
    let v = scope
    for (const k of path.split('.')) {
      if (v == null) return undefined
      v = v[k]
    }
    return v
  }
  const text = (v) => (v == null || v === false || v === true ? '' : String(v))
  const interpolate = (s, scope) => String(s).replace(HOLE, (_, p) => text(lookup(scope, p)))
  function value(s, scope) {
    if (typeof s !== 'string' || s.indexOf('{{') < 0) return s
    const m = s.match(WHOLE)
    return m ? lookup(scope, m[1]) : interpolate(s, scope)
  }

  // ── attributes → React props ───────────────────────────────────────────────
  const RENAME = {
    class: 'className', for: 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength',
    minlength: 'minLength', colspan: 'colSpan', rowspan: 'rowSpan', autocomplete: 'autoComplete',
    autofocus: 'autoFocus', contenteditable: 'contentEditable', crossorigin: 'crossOrigin', enctype: 'encType',
    srcset: 'srcSet', novalidate: 'noValidate', spellcheck: 'spellCheck', inputmode: 'inputMode',
    enterkeyhint: 'enterKeyHint', datetime: 'dateTime', frameborder: 'frameBorder', allowfullscreen: 'allowFullScreen',
    playsinline: 'playsInline', referrerpolicy: 'referrerPolicy', 'xlink:href': 'xlinkHref', 'xml:space': 'xmlSpace',
    usemap: 'useMap', formaction: 'formAction', accesskey: 'accessKey', cellpadding: 'cellPadding', cellspacing: 'cellSpacing',
  }
  const BOOL = new Set(['disabled', 'checked', 'selected', 'readonly', 'required', 'hidden', 'autofocus', 'multiple',
    'open', 'novalidate', 'muted', 'loop', 'autoplay', 'controls', 'playsinline', 'reversed', 'default', 'inert'])
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  // CSS property → React style key: custom properties stay as written, -ms- → ms…, -webkit-/-moz- → Webkit…/Moz….
  function cssKey(k) {
    k = k.toLowerCase().startsWith('--') ? k : k.toLowerCase()
    if (k.startsWith('--')) return k
    if (k.startsWith('-ms-')) return camel(k.slice(1))
    if (k.startsWith('-')) { const c = camel(k.slice(1)); return c[0].toUpperCase() + c.slice(1) }
    return camel(k)
  }
  function styleObject(css) {
    if (css && typeof css === 'object') return css
    const out = {}
    let depth = 0, start = 0
    const s = String(css || '')
    const parts = []
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (c === '(') depth++
      else if (c === ')') depth = Math.max(0, depth - 1)
      else if (c === ';' && !depth) { parts.push(s.slice(start, i)); start = i + 1 }
    }
    parts.push(s.slice(start))
    for (const p of parts) {
      const i = p.indexOf(':')
      if (i < 0) continue
      const k = p.slice(0, i).trim()
      const v = p.slice(i + 1).trim()
      if (!k) continue
      out[cssKey(k)] = v
    }
    return out
  }
  // A link to another screen of the canvas becomes the exported page next to it.
  function href(h, root) {
    if (typeof h !== 'string') return h
    const m = h.match(/^(\/?)([^?#]*?)\.dc\.html(.*)$/)
    if (!m || /^[a-z]+:/i.test(h)) return h
    return (m[1] ? root : '') + m[2] + '.html' + m[3]
  }
  const TABLE_PARTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup', 'select', 'optgroup'])

  function props(tag, attrs, scope, ctx) {
    const p = {}
    const low = tag.toLowerCase()
    let hasChange = false
    for (const [k0, raw] of attrs) {
      const k = k0.toLowerCase()
      if (k.startsWith('hint-')) continue
      if (/^on[a-z]/i.test(k0)) {
        const fn = value(raw, scope)
        if (typeof fn !== 'function') continue // string inline handlers (onclick="…") are not supported
        const name = 'on' + k0.slice(2, 3).toUpperCase() + k0.slice(3)
        if (name === 'onChange' || name === 'onInput') hasChange = true
        p[name] = fn
        continue
      }
      let v = value(raw, scope)
      if (k === 'style') { p.style = styleObject(v); continue }
      if (k === 'href' || k === 'xlink:href') v = href(v, ctx.root)
      if (BOOL.has(k) && raw === '') v = true
      if (BOOL.has(k) && (v === 'false' || v == null)) v = false
      const name = RENAME[k] || (k.startsWith('aria-') || k.startsWith('data-') || !k.includes('-') ? (RENAME[k0] || k0) : camel(k0))
      p[name] = v
    }
    // Uncontrolled unless the screen handles changes itself: the canvas lets a viewer type into any field.
    if (/^(input|textarea|select)$/.test(low) && !hasChange) {
      if ('value' in p) { p.defaultValue = p.value; delete p.value }
      if ('checked' in p) { p.defaultChecked = p.checked; delete p.checked }
    }
    if (low === 'a' && typeof p.href === 'string' && /^https?:/i.test(p.href) && !p.target) { p.target = '_blank'; p.rel = 'noopener noreferrer' }
    return p
  }

  // ── template → React elements ──────────────────────────────────────────────
  function build(nodes, scope, ctx, parent) {
    const R = ctx.React
    const out = []
    nodes.forEach((n, i) => {
      if (typeof n === 'string') {
        if (parent && TABLE_PARTS.has(parent) && !n.trim()) return
        const t = n.indexOf('{{') < 0 ? n : interpolate(n, scope)
        if (t) out.push(t)
        return
      }
      const [tag, attrs, kids] = n
      const low = tag.toLowerCase()
      const at = (name) => { const a = attrs.find((x) => x[0].toLowerCase() === name); return a ? a[1] : undefined }
      if (low === 'sc-for') {
        const list = value(at('list'), scope)
        const as = at('as') || 'item'
        if (!Array.isArray(list)) return
        list.forEach((item, j) => {
          const s = Object.create(scope)
          s[as] = item
          s.$index = j
          out.push(R.createElement(R.Fragment, { key: `${i}.${j}` }, ...build(kids, s, ctx, parent)))
        })
        return
      }
      if (low === 'sc-if') {
        if (value(at('value'), scope)) out.push(R.createElement(R.Fragment, { key: i }, ...build(kids, scope, ctx, parent)))
        return
      }
      if (low === 'dc-import') {
        const name = at('name')
        const C = ctx.components[name]
        if (!C) { out.push(R.createElement('span', { key: i, style: { color: '#c00' } }, `[missing ${name}]`)); return }
        const cp = { key: i }
        for (const [k, raw] of attrs) if (!/^(name|hint-.*)$/i.test(k)) cp[camel(k.toLowerCase())] = value(raw, scope)
        out.push(R.createElement(C, cp))
        return
      }
      if (low === 'x-import') {
        const path = at('component-from-global-scope') || ''
        const C = path.split('.').reduce((o, k) => (o == null ? o : o[k]), G)
        const cp = { key: i }
        for (const [k, raw] of attrs) {
          if (/^component-from-global-scope$/i.test(k) || /^hint-/i.test(k)) continue
          if (k.toLowerCase() === 'style') { cp.style = styleObject(value(raw, scope)); continue }
          cp[camel(k.toLowerCase())] = value(raw, scope)
        }
        if (!C) { out.push(R.createElement('span', { key: i, style: { color: '#c00' } }, `[missing ${path}]`)); return }
        out.push(R.createElement(C, cp, ...build(kids, scope, ctx, low)))
        return
      }
      const p = props(tag, attrs, scope, ctx)
      p.key = i
      if (low === 'textarea') {
        const t = kids.filter((k) => typeof k === 'string').join('')
        if (t && !('value' in p) && !('defaultValue' in p)) p.defaultValue = interpolate(t, scope)
        out.push(R.createElement(tag, p))
        return
      }
      if (low === 'style' || low === 'script') return // page CSS lives in <head>; screens never script-build UI
      out.push(R.createElement(tag, p, ...(kids.length ? build(kids, scope, ctx, low) : [])))
    })
    return out
  }

  // ── components ─────────────────────────────────────────────────────────────
  function makeComponents(R, sources, root) {
    const ctx = { React: R, components: {}, root }
    class DCLogic extends R.Component {
      constructor(p) { super(p); this.state = {} }
      renderVals() { return {} }
      render() {
        const vals = this.renderVals() || {}
        return R.createElement(R.Fragment, null, ...build(this.__tpl, vals, ctx, null))
      }
    }
    for (const [name, src] of Object.entries(sources)) {
      class Base extends DCLogic {}
      Base.prototype.__tpl = src.tpl
      let C
      try {
        // The logic class is the canvas's own screen code (classic JS, no imports).
        C = new Function('DCLogic', 'React', `${src.logic || 'class Component extends DCLogic {}'}\n;return Component;`)(Base, R)
      } catch (e) {
        C = function Broken() { return R.createElement('pre', { style: { color: '#c00', padding: 16 } }, `Screen script error (${name}): ${e.message}`) }
      }
      ctx.components[name] = C
    }
    return ctx
  }

  function mount() {
    const R = G.React
    const RD = G.ReactDOM
    const doc = G.document
    const page = JSON.parse(doc.getElementById('dc-page').textContent)
    const sources = {}
    for (const el of doc.querySelectorAll('script[data-dc-tpl]')) (sources[el.getAttribute('data-dc-tpl')] ||= {}).tpl = JSON.parse(el.textContent)
    for (const el of doc.querySelectorAll('script[data-dc-logic]')) (sources[el.getAttribute('data-dc-logic')] ||= {}).logic = el.textContent
    const ctx = makeComponents(R, sources, page.root || '')
    // ?theme=dark&kind=shop → props, so one exported screen can show its variants.
    const q = {}
    try { new URLSearchParams(G.location.search).forEach((v, k) => { q[k] = v }) } catch {}
    const Main = ctx.components[page.main]
    class Boundary extends R.Component {
      constructor(p) { super(p); this.state = { err: null } }
      static getDerivedStateFromError(err) { return { err } }
      render() { return this.state.err ? R.createElement('pre', { style: { color: '#c00', padding: 16, whiteSpace: 'pre-wrap' } }, `This screen failed to render: ${this.state.err.message}`) : this.props.children }
    }
    RD.createRoot(doc.getElementById('dc-root')).render(R.createElement(Boundary, null, R.createElement(Main, { ...(page.props || {}), ...q })))
  }

  G.DCRuntime = { lookup, interpolate, value, styleObject, href, build, makeComponents, mount }
  if (G.document && G.document.getElementById && G.document.getElementById('dc-page')) {
    if (G.document.readyState === 'loading') G.document.addEventListener('DOMContentLoaded', mount)
    else mount()
  }
})(typeof window !== 'undefined' ? window : globalThis)
