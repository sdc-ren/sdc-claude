// tf knowledge — routes a framework makes from file names:
//   Next.js  app router  `app/**/route.(ts|js)` exporting GET/POST/…  ·  pages router `pages/api/**`
//   Nuxt/Nitro          `server/api/**` (→ /api/…) and `server/routes/**`, method from `.get.ts`-style names
// Route groups `(x)` and parallel slots `@x` are not path segments; `[id]` / `[...slug]` are parameters.
import { blankComments, normPath } from '../scan.mjs'
import { hasDep } from './util.mjs'

const seg = (s) => s.split('/').filter((x) => x && !/^\(.*\)$/.test(x) && !x.startsWith('@')).join('/')

export const next = {
  name: 'Next.js',
  kind: 'routes',
  detect: (reader) => hasDep(reader, ['next']),
  extract(reader) {
    const out = []
    for (const f of reader.files()) {
      let m = f.match(/(?:^|\/)app\/(.*?)\/?route\.(?:m?[jt]s)$/)
      if (m && !/(^|\/)node_modules\//.test(f)) {
        const src = blankComments(reader.read(f) || '')
        const methods = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const|let)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((x) => x[1])
        for (const method of methods.length ? [...new Set(methods)] : ['ANY']) out.push({ method, path: normPath(`/${seg(m[1])}`), at: `${f}:1`, guards: [], validators: [], framework: 'Next.js' })
        continue
      }
      m = f.match(/(?:^|\/)pages\/api\/(.+)\.(?:m?[jt]sx?)$/)
      if (m) {
        const src = blankComments(reader.read(f) || '')
        const methods = [...new Set([...src.matchAll(/method\s*===?\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/g)].map((x) => x[1]))]
        const p = `/api/${m[1].replace(/(^|\/)index$/, '')}`
        for (const method of methods.length ? methods : ['ANY']) out.push({ method, path: normPath(p), at: `${f}:1`, guards: [], validators: [], framework: 'Next.js' })
      }
    }
    return out
  },
}

export const nuxt = {
  name: 'Nuxt/Nitro',
  kind: 'routes',
  detect: (reader) => hasDep(reader, ['nuxt', 'nitropack', 'h3']),
  extract(reader) {
    const out = []
    for (const f of reader.files()) {
      const m = f.match(/(?:^|\/)server\/(api|routes)\/(.+?)(?:\.(get|post|put|patch|delete|head|options))?\.(?:m?[jt]s)$/)
      if (!m) continue
      const p = `${m[1] === 'api' ? '/api' : ''}/${m[2].replace(/(^|\/)index$/, '')}`
      out.push({ method: m[3] ? m[3].toUpperCase() : 'ANY', path: normPath(p), at: `${f}:1`, guards: [], validators: [], framework: 'Nuxt/Nitro' })
    }
    return out
  },
}
