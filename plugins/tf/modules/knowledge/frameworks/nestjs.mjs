// tf knowledge — NestJS routes: `@Controller('x')` + `@Get('y')` …, guards (`@UseGuards`, `@Roles`, `@Public`) on the
// class or the method, the request DTO as validator, and `app.setGlobalPrefix('api')`.
import { argsAt, blankComments, joinPaths, lineAt, literal } from '../scan.mjs'
import { hasDep } from './util.mjs'

const HTTP = /@(Get|Post|Put|Patch|Delete|All|Options|Head)\s*\(/g
const decoArg = (src, at) => { const { args } = argsAt(src, at); const t = args[0] ? args[0].text : ''; const l = literal(t); if (l !== null) return l; const m = t.match(/path\s*:\s*(['"`])([^'"`]*)\1/); return m ? m[2] : '' }
function guardsIn(text) {
  const out = []
  for (const m of text.matchAll(/@(UseGuards|Roles|Public|Auth|Permissions|RequirePermissions)\s*\(([^)]*)\)/g)) out.push(m[2].trim() ? `${m[1]}(${m[2].replace(/\s+/g, ' ').trim().slice(0, 50)})` : m[1])
  return out
}

export default {
  name: 'NestJS',
  kind: 'routes',
  detect: (reader) => hasDep(reader, ['@nestjs/core']),
  extract(reader, { isSource }) {
    const global = (reader.grep('setGlobalPrefix\\s*\\(', (f) => /\.ts$/.test(f)).map((h) => (h.text.match(/setGlobalPrefix\s*\(\s*(['"`])([^'"`]+)\1/) || [])[2]).find(Boolean)) || ''
    const out = []
    for (const file of new Set(reader.grep('@Controller\\s*\\(', (f) => /\.ts$/.test(f) && isSource(f)).map((h) => h.file))) {
      const src = blankComments(reader.read(file) || '')
      for (const cm of src.matchAll(/@Controller\s*\(/g)) {
        const prefix = decoArg(src, cm.index + cm[0].length - 1)
        const classAt = src.indexOf('class ', cm.index)
        const classEnd = (() => { const next = src.indexOf('@Controller', cm.index + 1); return next < 0 ? src.length : next })()
        const classGuards = guardsIn(src.slice(Math.max(0, src.lastIndexOf('\n\n', cm.index)), classAt))
        const bodyAt = src.indexOf('{', classAt)
        const hits = [...src.slice(classAt, classEnd).matchAll(HTTP)].map((m) => ({ m, at: classAt + m.index }))
        hits.forEach((h) => { h.sig = src.indexOf('{', h.at); if (h.sig < 0 || h.sig > classEnd) h.sig = classEnd })
        hits.forEach(({ m, at, sig }, i) => {
          // This method's decorators and parameters: from the previous method's signature to this one's '{'.
          const block = src.slice(i ? hits[i - 1].sig : bodyAt, sig)
          const dto = [...block.matchAll(/@(?:Body|Query)\s*\([^)]*\)\s*\w+\s*:\s*(\w+)/g)].map((x) => x[1]).filter((x) => /^[A-Z]/.test(x) && !/^(string|number|boolean|any|Record)$/.test(x))
          out.push({
            method: m[1].toUpperCase(),
            path: joinPaths(global, prefix, decoArg(src, at + m[0].length - 1)),
            at: `${file}:${lineAt(src, at)}`,
            guards: [...classGuards, ...guardsIn(block)],
            validators: dto,
            framework: 'NestJS',
          })
        })
      }
    }
    return out
  },
}
