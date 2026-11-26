// tf knowledge — Express routes: `router.get('/x', …)`, `router.route('/x').get(…)`, and the prefixes routers are
// mounted under (`app.use('/api', routes)`, followed through imports from file to file).
import { argsAt, blankComments, joinPaths } from '../scan.mjs'
import { calls, hasDep, importsOf, middleware, paths, grepFiles } from './util.mjs'

const METHODS = 'get|post|put|patch|delete|all|options|head'
const JS = /\.(m?[jt]s|cjs)$/

export default {
  name: 'Express',
  kind: 'routes',
  detect: (reader) => hasDep(reader, ['express']),
  extract(reader, { isSource }) {
    const files = [...grepFiles(reader, `\\.(${METHODS}|use|route)\\s*\\(`, (f) => JS.test(f) && isSource(f))]
    const routes = [], mounts = [], seen = new Set()
    for (const file of files) {
      const raw = reader.read(file)
      if (!raw) continue
      const src = blankComments(raw)
      const imports = importsOf(reader, file, raw)
      // Mounts: x.use('/prefix', a, b, child) — any argument that is an imported router file.
      for (const c of calls(src, /\b\w+\.use\s*\(/g)) {
        const pre = paths(c.args[0])
        const prefixes = pre.length ? pre : ['']
        for (const a of c.args.slice(pre.length ? 1 : 0)) {
          const id = a.text.trim().replace(/\(.*$/s, '')
          if (imports[id]) mounts.push({ parent: file, prefixes, child: imports[id] })
        }
      }
      const add = (method, ps, args, line) => {
        for (const p of ps) {
          if (!/^[/*]/.test(p)) continue
          const key = `${file}:${line}:${method}:${p}`
          if (seen.has(key)) continue
          seen.add(key)
          routes.push({ file, method: method.toUpperCase(), path: p, line, ...middleware(args.slice(1, -1)) })
        }
      }
      for (const c of calls(src, new RegExp(`\\b(\\w+)\\.(${METHODS})\\s*\\(`, 'g'))) {
        if (c.args.length < 2) continue
        add(c.m[2], paths(c.args[0]), c.args, c.line)
      }
      // router.route('/x').get(…).post(…)
      for (const c of calls(src, /\.route\s*\(/g)) {
        const ps = paths(c.args[0])
        if (!ps.length) continue
        let at = c.end
        for (;;) {
          const m = src.slice(at, at + 200).match(new RegExp(`^\\s*\\.\\s*(${METHODS})\\s*\\(`))
          if (!m) break
          const { args, end } = argsAt(src, at + m[0].length - 1)
          add(m[1], ps, [{ text: '' }, ...args], c.line)
          at = end
        }
      }
    }
    // Prefixes: a file mounted by nobody starts at ''; each mount adds parent prefix + mount prefix.
    const children = new Set(mounts.map((m) => m.child))
    const prefix = new Map()
    for (const f of new Set([...routes.map((r) => r.file), ...mounts.map((m) => m.parent)])) if (!children.has(f)) prefix.set(f, new Set(['']))
    for (let round = 0; round < 12; round++) {
      let changed = false
      for (const m of mounts) {
        const from = prefix.get(m.parent)
        if (!from) continue
        const to = prefix.get(m.child) || new Set()
        for (const a of from) for (const b of m.prefixes) { const p = joinPaths(a, b); if (!to.has(p) && to.size < 20) { to.add(p); changed = true } }
        prefix.set(m.child, to)
      }
      if (!changed) break
    }
    return routes.flatMap((r) => [...(prefix.get(r.file) || new Set(['']))].map((p) => ({
      method: r.method, path: joinPaths(p, r.path), at: `${r.file}:${r.line}`, guards: r.guards, validators: r.validators, framework: 'Express',
    })))
  },
}
