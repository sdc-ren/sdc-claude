// tf knowledge — calls to an HTTP API from code:
//   JS/TS  fetch, axios(.get…), $fetch, ofetch, useFetch/useLazyFetch, ky, and clients made from them
//          (`const api = axios.create({ baseURL: '/api' })` → `api.get('/x')` is GET /api/x); more names from the
//          config (`- API clients: apiFetch, http`)
//   Dart   dio / http: `dio.get('/x')`, `http.get(Uri.parse('$base/x'))`, `Uri.https(host, '/x')`
// A path built at run time (a variable, a constant from another file) is counted as not recognised, not guessed.
import { argsAt, blankComments, joinPaths, lineAt, literal, normPath } from '../scan.mjs'
import { calls, enclosing, packages, pubDeps, grepFiles } from './util.mjs'

const VERBS = 'get|post|put|patch|delete|head|options|request'
const JS = /\.(m?[jt]sx?|cjs|vue|svelte)$/

// String constants of a file (`const BASE = '/api/x'`, a template without interpolation), to put into
// `${BASE}/y` before reading a path. Only plain literals: nothing is evaluated.
export function constants(src) {
  const out = {}
  for (const m of src.matchAll(/\b(?:const|let|var|final|static\s+const|static\s+final|const\s+String|final\s+String)\s+([A-Za-z_$][\w$]*)\s*(?::\s*\w+)?\s*=\s*(['"`])((?:(?!\2)[^\\$\n]|\\.)*)\2/g)) out[m[1]] = m[3]
  return out
}
const inline = (text, consts) => (consts ? text.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (all, n) => (n in consts ? consts[n] : all)).replace(/\$([A-Za-z_][\w]*)/g, (all, n) => (n in consts ? consts[n] : all)) : text)

// The path of a call's first argument, '' when it is not a literal; `external` for another host's URL.
function pathOf(arg, consts) {
  if (!arg) return { path: '' }
  const t = inline(arg.text.trim(), consts)
  const lit = literal(t) ?? literal((t.match(/^Uri\.parse\(\s*([\s\S]+)\)$/) || [])[1] || '')
  if (lit !== null) {
    if (/^https?:\/\//i.test(lit) && !/^https?:\/\/\{\*\}/i.test(lit)) return { path: normPath(lit), external: true }
    return { path: normPath(lit) }
  }
  const https = t.match(/^Uri\.https?\(\s*[^,]+,\s*([\s\S]+?)\s*(?:,|$)/)
  if (https) { const l = literal(https[1]); if (l !== null) return { path: normPath(l) } }
  return { path: '' }
}

const methodFrom = (opts) => ((opts && opts.text.match(/method\s*:\s*['"`](\w+)['"`]/i)) || [])[1]

// The call an object literal is the first argument of: from a position inside the object, back to its '{', then
// '(' , then an optional balanced generic `<…>`, then the callee name. null when the object is not a call's argument.
function callOfObject(src, inside) {
  let depth = 0, i = inside
  for (; i >= 0; i--) {
    const c = src[i]
    if (c === '}') depth++
    else if (c === '{') { if (depth === 0) break; depth-- }
  }
  if (i < 0) return null
  const objStart = i
  let k = i - 1
  while (k >= 0 && /\s/.test(src[k])) k--
  if (src[k] !== '(') return null
  k--
  while (k >= 0 && /\s/.test(src[k])) k--
  if (src[k] === '>') {
    let d = 0
    for (; k >= 0; k--) { if (src[k] === '>') d++; else if (src[k] === '<') { d--; if (d === 0) break } }
    k--
    while (k >= 0 && /\s/.test(src[k])) k--
  }
  const end = k + 1
  while (k >= 0 && /[\w$.]/.test(src[k])) k--
  const name = src.slice(k + 1, end)
  if (!name || /^(if|for|while|switch|return|function|catch)$/.test(name)) return null
  const { end: objEnd } = argsAt(src, objStart - 0 > 0 ? src.lastIndexOf('(', objStart) : objStart)
  return { name, nameAt: k + 1, objStart, objEnd }
}

export const jsClients = {
  name: 'HTTP calls (JS/TS)',
  kind: 'calls',
  detect: (reader) => packages(reader).length > 0,
  extract(reader, { isSource, knowledge }) {
    // Clients made from a base: name → path prefix of its baseURL.
    const made = {}
    for (const h of reader.grep('(axios|ofetch|\\$fetch|ky)\\.(create|extend)\\s*\\(', (f) => JS.test(f) && isSource(f))) {
      const m = h.text.match(/(?:const|let|var|export const)\s+(\w+)\s*=\s*(?:axios|ofetch|\$fetch|ky)\.(?:create|extend)/)
      if (!m) continue
      const base = (reader.read(h.file) || '').split('\n').slice(h.line - 1, h.line + 8).join('\n').match(/(?:baseURL|baseUrl|prefixUrl)\s*:\s*(['"`])([^'"`]*)\1/)
      made[m[1]] = base ? normPath(literal(`${base[1]}${base[2]}${base[1]}`) || '') : ''
    }
    const extra = String(knowledge.apiClients || '').split(',').map((x) => x.trim()).filter(Boolean)
    const names = ['fetch', 'axios', '\\$fetch', 'ofetch', 'useFetch', 'useLazyFetch', 'ky', ...Object.keys(made), ...extra].map((n) => n.replace(/[^\w$\\]/g, ''))
    const re = new RegExp(`(?<![\\w.$])(${[...new Set(names)].join('|')})\\s*(?:\\.\\s*(${VERBS}))?\\s*(?:<[^>()]*>)?\\s*\\(`, 'g')
    const out = []
    let unresolved = 0
    const files = grepFiles(reader, `(${[...new Set(names)].join('|')})\\s*(\\.\\s*(${VERBS}))?\\s*(<[^>()]*>)?\\s*\\(`, (f) => JS.test(f) && isSource(f))
    for (const file of files) {
      const raw = reader.read(file) || ''
      const src = blankComments(raw)
      const consts = constants(src)
      for (const c of calls(src, re)) {
        const who = c.m[1], verb = c.m[2]
        if ((who === 'axios' || made[who] !== undefined || extra.includes(who)) && verb === 'request') continue
        const { path, external } = pathOf(c.args[0], consts)
        if (external) continue
        if (!path) { unresolved++; continue }
        const method = (verb && verb !== 'request' ? verb : methodFrom(c.args[1]) || (/fetch|ky/i.test(who) ? 'GET' : 'ANY')).toUpperCase()
        out.push({ method, path: made[who] ? joinPaths(made[who], path) : path, at: `${file}:${c.line}`, fn: enclosing(raw, c.m.index), via: who })
      }
    }
    // Any client object: `createClient.get('/x')`, `apiClient.POST('/x')`, `http.patch('/x')` — a literal path
    // starting with '/', called on a name that says it is a client.
    const known = new Set(names)
    for (const file of grepFiles(reader, `\\.(${VERBS}|GET|POST|PUT|PATCH|DELETE)\\s*(<[^>()]*>)?\\s*\\(\\s*['"\`]/`, (f) => JS.test(f) && isSource(f))) {
      const raw = reader.read(file) || ''
      const src = blankComments(raw)
      const consts = constants(src)
      for (const c of calls(src, /(?<![\w.$])([\w$]+)\s*\.\s*(get|post|put|patch|delete|head|GET|POST|PUT|PATCH|DELETE|HEAD)\s*(?:<[^>()]*>)?\s*\(\s*(?=['"`])/g)) {
        if (known.has(c.m[1]) || !/client|api|http|fetch|request|service|axios|rest/i.test(c.m[1])) continue
        const { path, external } = pathOf(c.args[0], consts)
        if (!path || external || !path.startsWith('/')) continue
        out.push({ method: c.m[2].toUpperCase(), path, at: `${file}:${c.line}`, fn: enclosing(raw, c.m.index), via: c.m[1] })
      }
    }
    // Wrappers that take one object: client({ path: '/x', httpMethod: 'get' }), request<T>({ url, method }).
    // Found from the path key back to the call, so a long generic (`client<{ a: X | (Y) }>(…)`) does not hide it.
    const OBJ_PATH = /\b(?:path|url|endpoint|uri)\s*:\s*(['"`])((?:\/|\$\{\s*[A-Za-z_$][\w$]*\s*\})[^'"`]*)\1/g
    const seenAt = new Set(out.map((c) => c.at))
    for (const file of grepFiles(reader, `(path|url|endpoint|uri)\\s*:\\s*['"\`](/|\\$\\{)`, (f) => JS.test(f) && isSource(f))) {
      const raw = reader.read(file) || ''
      const src = blankComments(raw)
      const consts = constants(src)
      for (const pm of src.matchAll(OBJ_PATH)) {
        const call = callOfObject(src, pm.index)
        if (!call) continue
        const obj = src.slice(call.objStart, call.objEnd)
        if (/\bcomponent\s*:|\bredirect\s*:|\bchildren\s*:/.test(obj)) continue
        const method = (obj.match(/\b(?:method|httpMethod|verb|type)\s*:\s*['"`](\w+)['"`]/i) || [])[1]
        if (!method && !/fetch|client|request|api|http|service|call/i.test(call.name)) continue
        const at = `${file}:${lineAt(src, call.nameAt)}`
        if (seenAt.has(at)) continue
        seenAt.add(at)
        const p = literal(inline(`${pm[1]}${pm[2]}${pm[1]}`, consts))
        if (!p || /^\{\*\}/.test(p)) { unresolved++; continue }
        out.push({ method: (method || 'ANY').toUpperCase(), path: normPath(p), at, fn: enclosing(raw, call.nameAt), via: call.name })
      }
    }
    out.unresolved = unresolved
    return out
  },
}

export const dartClients = {
  name: 'HTTP calls (Dart)',
  kind: 'calls',
  detect: (reader) => { const d = pubDeps(reader); return d.has('dio') || d.has('http') },
  extract(reader) {
    const out = []
    let unresolved = 0
    const re = new RegExp(`\\b(\\w+)\\s*\\.\\s*(${VERBS})\\s*(?:<[^>()]*>)?\\s*\\(`, 'g')
    for (const file of grepFiles(reader, `\\.(${VERBS})\\s*(<[^>()]*>)?\\s*\\(`, (f) => /\.dart$/.test(f) && !/(^|\/)test\//.test(f) && !/\.g\.dart$|\.freezed\.dart$/.test(f))) {
      const raw = reader.read(file) || ''
      const src = blankComments(raw)
      const consts = constants(src)
      for (const c of calls(src, re)) {
        if (!/dio|http|client|api/i.test(c.m[1])) continue
        const { path, external } = pathOf(c.args[0], consts)
        if (external) continue
        if (!path) { unresolved++; continue }
        out.push({ method: c.m[2] === 'request' ? 'ANY' : c.m[2].toUpperCase(), path, at: `${file}:${c.line}`, fn: enclosing(raw, c.m.index), via: c.m[1] })
      }
    }
    out.unresolved = unresolved
    return out
  },
}
