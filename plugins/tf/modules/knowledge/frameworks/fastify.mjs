// tf knowledge — Fastify routes: `fastify.get('/x', …)` and `fastify.route({ method, url })`. Prefixes given to
// `register(plugin, { prefix })` are not followed (the map's coverage line says so).
import { blankComments, normPath } from '../scan.mjs'
import { calls, hasDep, middleware, paths } from './util.mjs'

const METHODS = 'get|post|put|patch|delete|all|options|head'

export default {
  name: 'Fastify',
  kind: 'routes',
  detect: (reader) => hasDep(reader, ['fastify']),
  limits: 'prefixes from register(plugin, { prefix }) are not followed',
  extract(reader, { isSource }) {
    const out = []
    for (const file of new Set(reader.grep(`\\.(${METHODS}|route)\\s*\\(`, (f) => /\.(m?[jt]s|cjs)$/.test(f) && isSource(f)).map((h) => h.file))) {
      const src = blankComments(reader.read(file) || '')
      for (const c of calls(src, new RegExp(`\\b(\\w+)\\.(${METHODS})\\s*\\(`, 'g'))) {
        if (c.args.length < 2) continue
        for (const p of paths(c.args[0])) if (/^[/*]/.test(p)) out.push({ method: c.m[2].toUpperCase(), path: normPath(p), at: `${file}:${c.line}`, ...middleware(c.args.slice(1, -1)), framework: 'Fastify' })
      }
      for (const c of calls(src, /\b\w+\.route\s*\(/g)) {
        const o = c.args[0] ? c.args[0].text : ''
        const url = (o.match(/url\s*:\s*(['"`])([^'"`]+)\1/) || [])[2]
        if (!url) continue
        const ms = (o.match(/method\s*:\s*(\[[^\]]*\]|['"`][^'"`]+['"`])/) || [])[1] || "'ANY'"
        for (const m of ms.match(/[A-Za-z]+/g) || ['ANY']) out.push({ method: m.toUpperCase(), path: normPath(url), at: `${file}:${c.line}`, guards: [], validators: [], framework: 'Fastify' })
      }
    }
    return out
  },
}
