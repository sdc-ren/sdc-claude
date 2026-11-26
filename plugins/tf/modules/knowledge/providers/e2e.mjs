// tf knowledge map `e2e` — the e2e flows tf has written (`.pipeline/<task>/flows/`, `.pipeline/_regression/`)
// and the selectors: which test ids the code defines (web `data-testid`, Flutter `Semantics(identifier:)`,
// `Key('…')`), which flows use them, and selectors a flow uses that the code no longer defines. Flows are read
// from the working folder (not git), so the map is stale when a flow file or a flows.json changes.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { hash, once, tsv, versions } from './util.mjs'

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
const read = (f) => { try { return readFileSync(f, 'utf8').replace(/\r\n?/g, '\n') } catch { return '' } }
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }

/** Every task folder of `.pipeline/` that holds flows: [{ task, dir, files }]. */
export function flowDirs(root) {
  const base = join(root, '.pipeline')
  if (!isDir(base)) return []
  return readdirSync(base).filter((n) => !/^(_lib|_new|\.)/.test(n) && isDir(join(base, n, 'flows'))).sort().map((task) => {
    const dir = join(base, task)
    const files = readdirSync(join(dir, 'flows')).filter((f) => /\.m?[jt]s$/.test(f)).sort()
    return { task, dir, files }
  }).filter((d) => d.files.length)
}

// A selector or a test id built at run time is a glob: `row-${i}` → `row-*`; `[data-testid^="x-"]` → `x-*`.
const glob = (v) => v.replace(/\$\{[^}]*\}/g, '*').replace(/\$\w+|\$\{?\w+\}?/g, '*').replace(/\*+/g, '*')
const globRe = (g) => new RegExp(`^${g.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
const sample = (g) => g.replace(/\*/g, 'x')

/** Selectors a flow uses: getByTestId('x'), [data-testid="x"] (^= $= *= kept as globs), Android find/tap({ id: 'x' }). */
export function flowSelectors(src) {
  const out = new Set()
  for (const m of src.matchAll(/getByTestId\(\s*(['"`])((?:(?!\1).)+)\1/g)) out.add(m[1] === '`' ? glob(m[2]) : m[2])
  for (const m of src.matchAll(/data-testid\s*([~^$*|]?)=\s*\\?['"]?((?:\$\{[^}]*\}|[\w.:-])+)/g)) {
    const v = glob(m[2])
    out.add(m[1] === '^' ? `${v}*` : m[1] === '$' ? `*${v}` : m[1] === '*' ? `*${v}*` : v)
  }
  for (const m of src.matchAll(/\{\s*(?:id|resourceId)\s*:\s*(['"`])((?:(?!\1).)+)\1/g)) out.add(m[1] === '`' ? glob(m[2]) : m[2])
  return [...out].filter((x) => x.replace(/\*/g, '').length > 1)
}

/** Test ids defined in the code: { id → [at…] }; an id built at run time is a glob (`row-${i}` → `row-*`). */
export function codeSelectors(reader) {
  const out = new Map()
  const add = (id, at) => { if (!id || !id.replace(/\*/g, '')) return; const list = out.get(id) || []; if (list.length < 5) list.push(at); out.set(id, list) }
  // A value as written: 'x', "x", `x-${i}`, "`x-${i}`" (Vue binding), "'x-' + i" (concatenation).
  const value = (v) => { const t = v.trim().replace(/^`|`$/g, ''); const cat = t.match(/^(['"])([^'"]*)\1\s*\+/); return cat ? `${cat[2]}*` : glob(t.replace(/^['"]|['"]$/g, '')) }
  const hits = reader.grep('(data-testid|testID|Semantics\\(|identifier:|Key\\()', (f) => /\.(m?[jt]sx?|vue|svelte|html|dart)$/.test(f) && !/(^|\/)(__tests__|test|tests|e2e|integration_test)\//.test(f) && !/\.(test|spec)\.[jt]sx?$/.test(f))
  for (const h of hits) {
    const at = `${h.file}:${h.line}`
    for (const m of h.text.matchAll(/(?:data-testid|testID)\s*=\s*(?:\{\s*)?(["'`])((?:(?!\1).)*)\1/g)) add(value(m[2]), at)
    if (/\.dart$/.test(h.file)) {
      for (const m of h.text.matchAll(/identifier\s*:\s*(['"])((?:(?!\1).)*)\1/g)) add(glob(m[2]), at)
      for (const m of h.text.matchAll(/\b(?:Value)?Key\(\s*(['"])((?:(?!\1).)*)\1/g)) add(glob(m[2]), at)
    }
  }
  return out
}

// Does a code id (maybe a glob) define what a flow selector (maybe a glob) points at?
const meets = (code, sel) => code === sel || globRe(code).test(sample(sel)) || globRe(sel).test(sample(code))
const defined = (defs, sel) => (defs.get(sel) || [...defs.keys()].filter((k) => (k.includes('*') || sel.includes('*')) && meets(k, sel)).flatMap((k) => defs.get(k)))

function caseInfo(dir) {
  const snap = readJson(join(dir, 'cases.approved.json'))
  const cases = new Map(((snap && snap.cases) || []).map((c) => [c.id, c]))
  const flows = (readJson(join(dir, 'flows.json')) || {}).cases || {}
  return { cases, flows }
}

const model = (ctx) => once(ctx, 'e2e', () => {
  const dirs = flowDirs(ctx.root)
  const defs = new Map()
  for (const r of ctx.profile.repos) for (const [id, at] of codeSelectors(ctx.reader(r))) defs.set(id, [...(defs.get(id) || []), ...at.map((a) => `${r.key}:${a}`)])
  return { dirs, defs }
})

function render(ctx) {
  const { dirs, defs } = model(ctx)
  const out = {}
  const uses = new Map() // selector → [task/flow]
  const flowRows = [['task', 'case', 'title', 'screen', 'platform', 'last_result', 'last_run', 'file', 'selectors'].join('\t')]
  const md = ['# E2E — flows', '', 'Generated by tf from `.pipeline/` — do not edit. A flow already written for a screen is the first regression candidate when a task touches that screen: re-run it (`flow-run.mjs`) before writing a new one.', '']
  const regression = dirs.filter((d) => d.task === '_regression')
  for (const d of [...regression, ...dirs.filter((x) => x.task !== '_regression')]) {
    const { cases, flows } = caseInfo(d.dir)
    md.push(`## ${d.task === '_regression' ? 'Regression suite (`_regression`)' : d.task} (${d.files.length})`, '', '| case | title | screen | platform | last result | file |', '|---|---|---|---|---|---|')
    for (const f of d.files) {
      const id = f.replace(/\.m?[jt]s$/, '')
      const c = cases.get(id) || {}, fl = flows[id] || {}
      const sels = flowSelectors(read(join(d.dir, 'flows', f)))
      for (const s of sels) uses.set(s, [...(uses.get(s) || []), `${d.task}/${id}`])
      const cell = (x) => String(x || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 80)
      md.push(`| \`${id}\` | ${cell(c.title)} | ${cell(c.screen)} | ${fl.platform || c.platform || ''} | ${fl.lastResult || '—'}${fl.lastRunAt ? ` (${String(fl.lastRunAt).slice(0, 10)})` : ''} | \`.pipeline/${d.task}/flows/${f}\` |`)
      flowRows.push([d.task, id, c.title, c.screen, fl.platform || c.platform, fl.lastResult, fl.lastRunAt, `.pipeline/${d.task}/flows/${f}`, sels.join(' ')].map(tsv).join('\t'))
    }
    md.push('')
  }
  if (!dirs.length) md.push('_No flow written yet._', '')
  out['e2e/flows.md'] = md.join('\n')
  out['e2e/index.tsv'] = `${flowRows.join('\n')}\n`
  // selectors
  const missing = [...uses.keys()].filter((s) => !defined(defs, s).length).sort()
  const sel = ['# E2E — selectors', '', 'Generated by tf — do not edit. Test ids the code defines and the flows that use them. Before renaming or removing one, update the flows listed here.', '']
  sel.push(`## Used by a flow, not defined in the code (${missing.length})`, '', '_Either renamed or removed (the flow will fail), or set in a way this map does not read._', '')
  sel.push(...(missing.length ? missing.map((s) => `- \`${s}\` — ${uses.get(s).slice(0, 6).join(', ')}${uses.get(s).length > 6 ? ' …' : ''}`) : ['_None._']), '')
  const used = [...uses.keys()].filter((s) => defined(defs, s).length).sort()
  sel.push(`## Used by a flow (${used.length})`, '', '| selector | defined at | flows |', '|---|---|---|')
  for (const s of used) sel.push(`| \`${s}\` | ${defined(defs, s).slice(0, 3).map((a) => `\`${a}\``).join('<br>')} | ${uses.get(s).slice(0, 6).join(', ')}${uses.get(s).length > 6 ? ' …' : ''} |`)
  const unused = [...defs.keys()].filter((k) => !used.some((s) => meets(k, s))).sort()
  sel.push('', `## Defined, no flow uses it (${unused.length})`, '', ...(unused.length ? [unused.slice(0, 400).map((s) => `\`${s}\``).join(' · ') + (unused.length > 400 ? ' …' : '')] : ['_None._']), '')
  out['e2e/selectors.md'] = sel.join('\n')
  return out
}

export default {
  name: 'e2e',
  answers: 'Which e2e flows exist (per task, the regression suite) and their last result; which test ids the code defines and which flows use them',
  applies: (ctx) => { const m = model(ctx); return m.dirs.length > 0 || m.defs.size > 0 },
  sources: (ctx) => {
    const parts = flowDirs(ctx.root).flatMap((d) => [d.task, ...d.files.map((f) => `${f}:${hash(read(join(d.dir, 'flows', f)))}`), hash(read(join(d.dir, 'flows.json')))])
    return { ...versions(ctx), flows: parts.length ? hash(parts.join('\n')) : 'none' }
  },
  generate: render,
}
