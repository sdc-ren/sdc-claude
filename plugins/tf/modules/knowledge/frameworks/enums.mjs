// tf knowledge — state enums and where each value is written. Enums: TS `enum`, `const X = { … } as const` /
// Object.freeze, Sequelize `DataTypes.ENUM(…)` on a status-like column, Prisma `enum`, Dart `enum`. Kept when the
// name looks like a state (default /(status|state|phase|stage)/i; config `- State enums: <regex>`).
// A write is `Enum.VALUE` after `:` or `=` (not `==`), or a status-like key set to the value's literal.
import { posix } from 'node:path'

import { blankComments, lineAt } from '../scan.mjs'
import { grepFiles } from './util.mjs'

const SRC = /\.(m?[jt]sx?|cjs|prisma|dart)$/
const notTest = (f) => !/(^|\/)(__tests__|test|tests|spec|e2e)\//.test(f) && !/\.(test|spec|d)\.[jt]sx?$/.test(f)

function members(body, dart = false) {
  const out = []
  for (const part of body.split(dart ? /[,;]/ : /,|\n/)) {
    const m = part.trim().match(/^([A-Za-z_][\w]*)(?:\s*[=:(]\s*(['"`])([^'"`]*)\2)?/)
    if (m && !/^(static|final|const|get|set|factory|String|int)$/.test(m[1])) out.push({ key: m[1], value: m[3] ?? m[1] })
    if (dart && /;/.test(part)) break
  }
  return out
}

export function findEnums(reader, filter) {
  const out = []
  for (const file of grepFiles(reader, '(\\benum\\s+[A-Za-z_]|as const|Object\\.freeze|DataTypes\\.ENUM|Sequelize\\.ENUM)', (f) => SRC.test(f) && notTest(f))) {
    const src = blankComments(reader.read(file) || '')
    const add = (name, values, i, kind) => { if (filter.test(name) && values.length) out.push({ name, values, kind, file, at: `${file}:${lineAt(src, i)}` }) }
    for (const m of src.matchAll(/\b(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_]\w*)\s*\{([^}]*)\}/g)) add(m[1], members(m[2], /\.dart$/.test(file)), m.index, /\.prisma$/.test(file) ? 'prisma' : /\.dart$/.test(file) ? 'dart' : 'enum')
    for (const m of src.matchAll(/\b(?:export\s+)?const\s+([A-Za-z_]\w*)\s*=\s*(?:Object\.freeze\(\s*)?\{([^{}]*)\}\s*\)?\s*(?:as\s+const)?/g)) {
      if (!/as\s+const|Object\.freeze/.test(m[0]) && !/^[A-Z][A-Z0-9_]+$/.test(m[1])) continue
      add(m[1], members(m[2]).filter((x) => /['"`]/.test(m[2])), m.index, 'const')
    }
    // Sequelize: `status: { type: DataTypes.ENUM('a', 'b') }` → <Model>.status
    const model = (src.match(/\bclass\s+(\w+)\s+extends\s+Model\b/) || src.match(/define\(\s*['"`](\w+)/) || [])[1] || posix.basename(file).replace(/\.\w+$/, '')
    for (const m of src.matchAll(/(['"]?)(\w+)\1\s*:\s*\{?[^{}]*?(?:DataTypes|Sequelize)\.ENUM\(([^)]*)\)/g)) {
      const vals = [...m[3].matchAll(/(['"`])([^'"`]+)\1/g)].map((v) => ({ key: v[2], value: v[2] }))
      add(`${model}.${m[2]}`, vals, m.index, 'column')
    }
  }
  return out
}

/** Where each value is written: { 'Name.KEY': [at…] } from one search over the repo. */
export function findWrites(reader, enums, cap = 12) {
  const writes = {}
  const named = enums.filter((e) => e.kind !== 'column')
  if (named.length) {
    const names = [...new Set(named.map((e) => e.name))]
    for (let i = 0; i < names.length; i += 400) {
      const group = names.slice(i, i + 400)
      const re = new RegExp(`(?:[^=!<>]=|:)\\s*(?:this\\.)?(${group.join('|')})\\.([A-Za-z_]\\w*)`, 'g')
      for (const h of reader.grepWords(group.map((n) => `${n}.`), (f) => SRC.test(f) && notTest(f))) {
        if (/^\s*(case|if|return|import|export\s+enum)\b/.test(h.text) || /[=!]==?\s*(\w+\.)?[A-Za-z_]+\.\w+/.test(h.text)) continue
        for (const m of h.text.matchAll(re)) { const k = `${m[1]}.${m[2]}`; (writes[k] ||= []).length < cap && writes[k].push(`${h.file}:${h.line}`) }
      }
    }
  }
  // Column enums (no name in code): a status-like key set to one of the values.
  for (const e of enums.filter((x) => x.kind === 'column')) {
    const col = e.name.split('.').pop()
    for (const v of e.values) {
      const hits = reader.grep(`${col}['"]?\\s*[:=]\\s*['"]${v.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`, (f) => SRC.test(f) && notTest(f) && f !== e.file)
      writes[`${e.name}.${v.key}`] = hits.slice(0, cap).map((h) => `${h.file}:${h.line}`)
    }
  }
  return writes
}
