// tf knowledge — what the framework readers share: a repo's package manifests, import resolution, the function a
// line sits in, and sorting middleware names into guards and validators.
import { posix } from 'node:path'

import { argsAt, blankComments, lineAt, literal } from '../scan.mjs'

/** Every package.json of a reader (a monorepo has several): [{ dir, deps }]. */
export function packages(reader) {
  if (reader._pkgs) return reader._pkgs
  const out = []
  for (const f of reader.files().filter((x) => /(^|\/)package\.json$/.test(x)).slice(0, 120)) {
    try { const j = JSON.parse(reader.read(f) || '{}'); out.push({ dir: posix.dirname(f), deps: { ...j.dependencies, ...j.devDependencies, ...j.peerDependencies } }) } catch {}
  }
  return (reader._pkgs = out)
}
export const hasDep = (reader, names) => packages(reader).some((p) => names.some((n) => p.deps[n]))

/** Dart packages of a reader (pubspec.yaml dependency names). */
export function pubDeps(reader) {
  const names = new Set()
  for (const f of reader.files().filter((x) => /(^|\/)pubspec\.yaml$/.test(x)).slice(0, 20)) {
    for (const m of (reader.read(f) || '').matchAll(/^\s{2}([a-z_][a-z0-9_]*):/gm)) names.add(m[1])
  }
  return names
}

const EXTS = ['', '.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx', '/index.ts', '/index.js', '/index.mjs']

// JSON with comments and trailing commas (tsconfig.json) → object, {} when unreadable.
function jsonc(text) {
  try { return JSON.parse(blankComments(String(text || '')).replace(/,\s*([}\]])/g, '$1')) } catch { return {} }
}
/** Import aliases of a repo (tsconfig/jsconfig `paths`, relative to `baseUrl`): [{ from, to: [..] }], `*` kept. */
export function aliases(reader) {
  if (reader._aliases) return reader._aliases
  const out = []
  for (const f of reader.files().filter((x) => /(^|\/)(tsconfig|jsconfig)(\.\w+)?\.json$/.test(x) && x.split('/').length <= 3).slice(0, 12)) {
    const c = jsonc(reader.read(f)).compilerOptions || {}
    const base = posix.join(posix.dirname(f), c.baseUrl || '.')
    for (const [from, to] of Object.entries(c.paths || {})) out.push({ from, to: (Array.isArray(to) ? to : [to]).map((t) => posix.normalize(posix.join(base, t))) })
  }
  return (reader._aliases = out)
}

const firstFile = (reader, base) => {
  const b = base.replace(/\.(js|mjs|cjs)$/, '')
  for (const e of EXTS) if (reader.has(`${b}${e}`)) return `${b}${e}`
  return ''
}
/** The file an import names, as a path of the reader: relative, or through a tsconfig alias ('' for a package). */
export function resolveImport(reader, fromFile, spec) {
  if (spec.startsWith('.')) return firstFile(reader, posix.normalize(posix.join(posix.dirname(fromFile), spec)))
  for (const a of aliases(reader)) {
    const star = a.from.indexOf('*')
    const hit = star < 0 ? spec === a.from : spec.startsWith(a.from.slice(0, star)) && spec.endsWith(a.from.slice(star + 1))
    if (!hit) continue
    const mid = star < 0 ? '' : spec.slice(star, spec.length - (a.from.length - star - 1))
    for (const t of a.to) { const f = firstFile(reader, t.replace('*', mid)); if (f) return f }
  }
  return ''
}

/** identifier → imported file, for `import a from`, `import { a as b } from`, `const a = require(…)`. */
export function importsOf(reader, file, src) {
  const out = {}
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const target = resolveImport(reader, file, m[2])
    if (!target) continue
    for (const name of m[1].replace(/[{}]/g, ',').split(',').map((x) => x.trim()).filter(Boolean)) out[name.split(/\s+as\s+/).pop().replace(/^\*\s*/, '')] = target
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const target = resolveImport(reader, file, m[2])
    if (target) out[m[1]] = target
  }
  return out
}

/** The name of the function or method a position is in (the closest definition above it), '' if none. */
export function enclosing(src, i) {
  const before = src.slice(Math.max(0, i - 6000), i).split('\n').reverse()
  for (const l of before) {
    const m = l.match(/(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>|^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(\w+)\s*\([^)]*\)\s*(?::\s*[\w<>[\]|, ]+)?\s*\{|^\s*(?:Future|Stream|void)[\w<>?, ]*\s+(\w+)\s*\(|^\s*(\w+)\s*:\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>))/)
    if (m) { const name = m.slice(1).find(Boolean); if (name && !/^(if|for|while|switch|catch|return)$/.test(name)) return name }
  }
  return ''
}

const GUARD = /auth|guard|role|permission|protect|require|verify|jwt|acl|login|signin|signed|session|owner|admin|scope|token|logged/i
const VALIDATOR = /valid|schema|joi|zod|celebrate|yup|check|sanitize|dto|body\(|query\(|param\(/i
/** Middleware arguments of a route call → { guards, validators } (names only, as written, short). */
export function middleware(args) {
  const guards = [], validators = []
  for (const a of args) {
    const t = a.text.trim()
    if (!t || /^(async\s*)?(\(|function\b)/.test(t) || /=>/.test(t)) continue
    const name = t.replace(/\s+/g, ' ').slice(0, 60)
    if (GUARD.test(name)) guards.push(name)
    else if (VALIDATOR.test(name)) validators.push(name)
  }
  return { guards, validators }
}

/** Every `<re>(` call in a source text: [{ m (the regex match), args, end, line }]. `re` must end before '('. */
export function calls(src, re) {
  const out = []
  for (const m of src.matchAll(re)) {
    const open = m.index + m[0].length - 1
    if (src[open] !== '(') continue
    const { args, end } = argsAt(src, open)
    out.push({ m, args, end, line: lineAt(src, m.index) })
  }
  return out
}

/** A path argument: a literal, or an array of literals. */
export function paths(arg) {
  if (!arg) return []
  const t = arg.text.trim()
  if (t.startsWith('[')) return [...t.matchAll(/(['"`])((?:(?!\1).)*)\1/g)].map((m) => literal(`${m[1]}${m[2]}${m[1]}`)).filter((x) => x !== null)
  const l = literal(t)
  return l === null ? [] : [l]
}

/**
 * Name constants of a whole repo: `export const EVENTS = { NEW: 'message:new' }` → { 'EVENTS.NEW': 'message:new' },
 * `export const CHANNEL = 'room'` → { CHANNEL: 'room' }. Only plain string literals; nothing is evaluated.
 */
export function repoConstants(reader) {
  if (reader._consts) return reader._consts
  const out = {}
  const files = new Set(reader.grep('\\b(export\\s+)?const\\s+[A-Z][A-Z0-9_]*\\s*(:[^=]+)?=', (f) => /\.(m?[jt]sx?|cjs)$/.test(f) && !/\.(test|spec|d)\.[jt]s$/.test(f)).map((h) => h.file))
  const list = [...files].slice(0, 600)
  if (reader.prefetch) reader.prefetch(list)
  for (const f of list) {
    const src = blankComments(reader.read(f) || '')
    for (const m of src.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*(['"`])([^'"`$\n]*)\2/g)) out[m[1]] = m[3]
    for (const m of src.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*\{/g)) {
      const open = m.index + m[0].length - 1
      const body = src.slice(open, open + 20000)
      let depth = 0, end = 0
      for (let i = 0; i < body.length; i++) { if (body[i] === '{') depth++; else if (body[i] === '}') { depth--; if (!depth) { end = i; break } } }
      for (const kv of body.slice(1, end).matchAll(/(?:^|[,{\s])['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*(['"`])([^'"`$\n]*)\2/g)) out[`${m[1]}.${kv[1]}`] = kv[3]
    }
  }
  return (reader._consts = out)
}

/** A name argument: a literal, or a constant the repo defines (`QUEUE_NAMES.X`, `CHANNEL`). '' when neither. */
export function nameOf(arg, consts = {}) {
  if (!arg) return ''
  const t = arg.text.trim()
  const l = literal(t)
  if (l !== null) return l
  const k = t.replace(/\s+/g, '')
  return consts[k] ?? ''
}

/** The files a pattern occurs in, their text fetched in one batch so the readers that follow do not pay per file. */
export function grepFiles(reader, re, filter) {
  const files = [...new Set(reader.grep(re, filter).map((h) => h.file))]
  if (reader.prefetch) reader.prefetch(files)
  return files
}
