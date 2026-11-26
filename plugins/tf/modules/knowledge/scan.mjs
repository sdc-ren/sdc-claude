// tf knowledge — reading source text without a parser: where a match is (line), the arguments of a call
// (brackets balanced, strings and comments skipped), string literals, and URL paths normalised so a route and a
// call to it compare equal. Good enough for maps that say how much they recognised; never used to change code.

/** 1-based line of an index. */
export function lineAt(src, i) {
  let n = 1
  for (let k = src.indexOf('\n'); k !== -1 && k < i; k = src.indexOf('\n', k + 1)) n++
  return n
}

/**
 * The same text with comments blanked out (newlines kept, so indexes and lines still match). Strings stay: route
 * paths live in them. `//` inside a string or a URL is not a comment.
 */
export function blankComments(src) {
  const out = src.split('')
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') out[i++] = ' '; continue }
    if (c === '/' && src[i + 1] === '*') { while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++ } if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2 } continue }
    if (c === '#' && src[i + 1] === ' ' && (i === 0 || src[i - 1] === '\n')) { while (i < n && src[i] !== '\n') out[i++] = ' '; continue } // YAML/shell-ish
    i++
  }
  return out.join('')
}

// Index just past the string that starts at i (', ", or ` with ${…} nesting).
function skipString(src, i) {
  const q = src[i]
  let k = i + 1
  while (k < src.length) {
    const c = src[k]
    if (c === '\\') { k += 2; continue }
    if (q === '`' && c === '$' && src[k + 1] === '{') { k = skipBalanced(src, k + 1); continue }
    if (c === q) return k + 1
    if (c === '\n' && q !== '`') return k
    k++
  }
  return k
}

// Index just past the bracket group that starts at i ((, [ or {).
function skipBalanced(src, i) {
  const open = src[i], close = { '(': ')', '[': ']', '{': '}' }[open]
  let depth = 0, k = i
  while (k < src.length) {
    const c = src[k]
    if (c === '"' || c === "'" || c === '`') { k = skipString(src, k); continue }
    if (c === '/' && src[k + 1] === '/') { while (k < src.length && src[k] !== '\n') k++; continue }
    if (c === '/' && src[k + 1] === '*') { const e = src.indexOf('*/', k + 2); k = e < 0 ? src.length : e + 2; continue }
    if (c === open) depth++
    else if (c === close) { depth--; if (depth === 0) return k + 1 }
    k++
  }
  return k
}

/**
 * The top-level arguments of the call whose '(' is at `open`: [{ text, start }], and the index after ')'.
 * A call cut off by the end of the file gives what was there.
 */
export function argsAt(src, open) {
  const args = []
  const end = skipBalanced(src, open)
  let depth = 0, start = open + 1, k = open + 1
  const limit = Math.max(open + 1, end - 1)
  while (k < limit) {
    const c = src[k]
    if (c === '"' || c === "'" || c === '`') { k = skipString(src, k); continue }
    if (c === '(' || c === '[' || c === '{') { k = skipBalanced(src, k); continue }
    if (c === ',' && depth === 0) { args.push({ text: src.slice(start, k).trim(), start }); start = k + 1 }
    k++
  }
  const last = src.slice(start, limit).trim()
  if (last) args.push({ text: last, start })
  return { args, end }
}

/**
 * The value of a string literal argument: 'a', "a", `a/${x}/b` (an interpolation becomes `{*}`). Dart's '$x' and
 * '${x}' too. null when the argument is not a plain literal.
 */
export function literal(text) {
  const t = String(text || '').trim()
  const m = t.match(/^(['"`])([\s\S]*)\1$/)
  if (!m) return null
  // 'a' + x + 'b' is not one literal: no unescaped quote of the same kind inside.
  if (m[1] !== '`' && m[2].replace(/\\./g, '').includes(m[1])) return null
  return m[2].replace(/\$\{[^}]*\}/g, '{*}').replace(/\$[A-Za-z_]\w*/g, '{*}')
}

/**
 * A URL path in one form for both sides: leading '/', no query or fragment, no trailing '/', and every parameter
 * (`:id`, `{id}`, `{*}`, `[id]`, `[...slug]`, `<int:id>`, `*`) as `*`. An absolute URL keeps its path; a path that
 * starts with an interpolation (a base URL in a variable) drops it. '' when nothing path-like is left.
 */
export function normPath(p) {
  let s = String(p || '').trim()
  if (!s) return ''
  s = s.replace(/^[a-z]+:\/\/[^/]+/i, '') // absolute URL → its path
  s = s.replace(/^(\{\*\})+/, '') // base URL in a variable
  s = s.split(/[?#]/)[0]
  if (!s.startsWith('/')) { if (/^[\w{[:<*.-]/.test(s) && s.includes('/')) s = `/${s}`; else if (/^[\w-]+$/.test(s)) s = `/${s}`; else return '' }
  const segs = s.split('/').filter(Boolean).map((x) => (/^(:\w+\??|\{[^}]*\}|\[\[?\.{0,3}[^\]]*\]\]?|<[^>]+>|\*+|.*\{\*\}.*)$/.test(x) ? '*' : x))
  return `/${segs.join('/')}`
}

export const joinPaths = (...parts) => normPath(parts.filter((x) => x && x !== '/').map((x) => String(x).replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/') || '/')

/** Does a call's path match a route's? Segment by segment, `*` on either side matches one segment. */
export function samePath(a, b) {
  const x = a.split('/').filter(Boolean), y = b.split('/').filter(Boolean)
  if (x.length !== y.length) return false
  return x.every((s, i) => s === y[i] || s === '*' || y[i] === '*')
}

/** The path with a known prefix taken off its start (e.g. /api/v1), for comparing routes and calls. */
export function stripPrefix(path, prefixes) {
  for (const p of prefixes.map(normPath).filter((x) => x && x !== '/').sort((a, b) => b.length - a.length)) {
    if (path === p) return '/'
    if (path.startsWith(`${p}/`)) return path.slice(p.length)
  }
  return path
}

/** Files of a reader that look like source (not tests, not type declarations, not built output). */
export const isSource = (f, exts = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte)$/) => exts.test(f) && !/(^|\/)(__tests__|__mocks__|test|tests|spec|e2e|cypress|fixtures?)\//.test(f) && !/\.(test|spec|d)\.[jt]sx?$/.test(f) && !/\.min\.js$/.test(f)
