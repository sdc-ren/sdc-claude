// tf knowledge — the data model from the code: Prisma schema, Sequelize (Model.init, define, decorators),
// TypeORM entities, Mongoose schemas; SQL migrations (CREATE TABLE) only when no ORM model was found. Each model:
// table, columns (name, type), relations (kind, target, key), and the files that use it.
import { posix } from 'node:path'

import { argsAt, blankComments, lineAt } from '../scan.mjs'
import { grepFiles } from './util.mjs'

const JS = /\.(m?[jt]sx?|cjs)$/
const notTest = (f) => !/(^|\/)(__tests__|test|tests|spec|e2e|seeders?|fixtures?)\//.test(f) && !/\.(test|spec|d)\.[jt]sx?$/.test(f)
const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

// Top-level `key: value` entries of an object literal's text (nested objects kept whole).
function entries(obj) {
  const out = []
  let depth = 0, start = 1, key = ''
  const s = obj.trim()
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i]
    if ('{[('.includes(c)) depth++
    else if ('}])'.includes(c)) depth--
    else if (c === ':' && depth === 0 && !key) { key = s.slice(start, i).trim().replace(/^['"]|['"]$/g, ''); start = i + 1 }
    else if (c === ',' && depth === 0) { if (key) out.push([key, s.slice(start, i).trim()]); key = ''; start = i + 1 }
  }
  if (key) out.push([key, s.slice(start, s.length - 1).trim()])
  return out.filter(([k]) => /^\w+$/.test(k))
}
const typeOf = (v) => (v.match(/(?:DataTypes|Sequelize|Schema\.Types)\.(\w+)/) || v.match(/type\s*:\s*\[?\s*(\w+)/) || [])[1] || ''

export function findModels(reader) {
  const models = []
  // Prisma
  for (const f of reader.files().filter((x) => /\.prisma$/.test(x))) {
    const src = reader.read(f) || ''
    for (const m of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const cols = [], rels = []
      for (const l of m[2].split('\n')) {
        const c = l.trim().match(/^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/)
        if (!c || c[1].startsWith('@@')) continue
        const rel = c[5].match(/@relation\([^)]*fields:\s*\[(\w+)/)
        if (/^[A-Z]/.test(c[2]) && !/^(String|Int|BigInt|Float|Decimal|Boolean|DateTime|Json|Bytes)$/.test(c[2])) rels.push({ kind: c[3] ? 'hasMany' : rel ? 'belongsTo' : 'hasOne', target: c[2], key: rel ? rel[1] : '' })
        else cols.push({ name: c[1], type: c[2] + (c[4] || '') })
      }
      const table = (m[2].match(/@@map\(\s*"([^"]+)"/) || [])[1] || m[1]
      models.push({ name: m[1], table, cols, rels, at: `${f}:${lineAt(src, m.index)}`, orm: 'Prisma' })
    }
  }
  // Sequelize, TypeORM, Mongoose
  for (const file of grepFiles(reader, '(extends Model|\\.init\\(|sequelize\\.define\\(|@Entity\\(|@Table|new Schema\\(|mongoose\\.Schema\\()', (f) => JS.test(f) && notTest(f))) {
    const src = blankComments(reader.read(file) || '')
    // Model.init({ … }, { tableName }) / sequelize.define('Name', { … }, { tableName })
    for (const m of src.matchAll(/\b(\w+)\.init\s*\(|\bsequelize\.define\s*\(/g)) {
      const { args } = argsAt(src, m.index + m[0].length - 1)
      const defined = !m[1]
      const name = defined ? (args[0]?.text.match(/['"`](\w+)/) || [])[1] : m[1]
      const attrs = defined ? args[1] : args[0]
      const opts = defined ? args[2] : args[1]
      if (!name || !attrs || !attrs.text.startsWith('{') || !/[A-Z]/.test(name[0])) continue
      const cols = entries(attrs.text).map(([k, v]) => ({ name: k, type: typeOf(v), ref: (v.match(/references\s*:\s*\{[^}]*model\s*:\s*['"`]?(\w+)/) || [])[1] || '' }))
      const table = (opts?.text.match(/tableName\s*:\s*['"`](\w+)/) || [])[1] || snake(name)
      models.push({ name, table, cols, rels: cols.filter((c) => c.ref).map((c) => ({ kind: 'belongsTo', target: c.ref, key: c.name })), at: `${file}:${lineAt(src, m.index)}`, orm: 'Sequelize' })
    }
    // sequelize-typescript / TypeORM decorators on a class
    for (const m of src.matchAll(/@(Table|Entity)\s*\(([^)]*)\)[\s\S]{0,400}?class\s+(\w+)/g)) {
      const start = m.index + m[0].length
      const end = src.indexOf('\nclass ', start) > 0 ? src.indexOf('\nclass ', start) : src.length
      const body = src.slice(start, end)
      const cols = [...body.matchAll(/@(?:Column|PrimaryGeneratedColumn|PrimaryColumn|CreateDateColumn|UpdateDateColumn)\s*\(([^)]*)\)\s*(?:\n\s*@\w+(?:\([^)]*\))?\s*)*\s*(?:public\s+|readonly\s+|declare\s+)*(\w+)[?!]?\s*:\s*([\w<>[\]| ]+)/g)].map((c) => ({ name: c[2], type: c[3].trim() }))
      const rels = [...body.matchAll(/@(ManyToOne|OneToMany|OneToOne|ManyToMany|BelongsTo|HasMany|HasOne|BelongsToMany)\s*\(\s*\(\)\s*=>\s*(\w+)/g)].map((r) => ({ kind: r[1][0].toLowerCase() + r[1].slice(1), target: r[2], key: '' }))
      const table = (m[2].match(/['"`](\w+)['"`]/) || m[2].match(/(?:tableName|name)\s*:\s*['"`](\w+)/) || [])[1] || snake(m[3])
      models.push({ name: m[3], table, cols, rels, at: `${file}:${lineAt(src, m.index)}`, orm: m[1] === 'Entity' ? 'TypeORM' : 'Sequelize' })
    }
    // Mongoose: const X = new Schema({ … }); model('Name', X)
    for (const m of src.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*new\s+(?:mongoose\.)?Schema\s*\(/g)) {
      const { args } = argsAt(src, m.index + m[0].length - 1)
      if (!args[0] || !args[0].text.startsWith('{')) continue
      const name = (src.match(new RegExp(`model\\s*(?:<[^>]*>)?\\(\\s*['"\`](\\w+)['"\`]\\s*,\\s*${m[1]}`)) || [])[1] || m[1].replace(/Schema$/, '')
      const cols = entries(args[0].text).map(([k, v]) => ({ name: k, type: typeOf(v) || v.replace(/\s+/g, ' ').slice(0, 20), ref: (v.match(/ref\s*:\s*['"`](\w+)/) || [])[1] || '' }))
      models.push({ name, table: snake(name), cols, rels: cols.filter((c) => c.ref).map((c) => ({ kind: 'ref', target: c.ref, key: c.name })), at: `${file}:${lineAt(src, m.index)}`, orm: 'Mongoose' })
    }
    // Sequelize associations: A.belongsTo(B, { foreignKey: 'b_id' })
    for (const m of src.matchAll(/\b(\w+)\.(belongsTo|hasMany|hasOne|belongsToMany)\s*\(\s*(?:models\.)?(\w+)\s*(?:,\s*\{([^}]*)\})?/g)) {
      const owner = models.find((x) => x.name === m[1])
      const rel = { kind: m[2], target: m[3], key: ((m[4] || '').match(/foreignKey\s*:\s*['"`]?(\w+)/) || [])[1] || '' }
      if (owner) owner.rels.push(rel)
      else models.push({ name: m[1], table: '', cols: [], rels: [rel], at: '', orm: 'Sequelize', partial: true })
    }
  }
  // Merge partial entries (associations declared away from the model) into their model.
  const byName = new Map()
  for (const m of models) {
    const have = byName.get(m.name)
    if (!have) { byName.set(m.name, m); continue }
    have.rels.push(...m.rels)
    if (!have.cols.length && m.cols.length) Object.assign(have, { ...m, rels: have.rels })
  }
  const out = [...byName.values()].filter((m) => !m.partial || m.cols.length)
  for (const m of out) m.rels = m.rels.filter((r, i, a) => a.findIndex((x) => x.kind === r.kind && x.target === r.target) === i)
  if (out.length) return out
  // No ORM: SQL migrations.
  const tables = new Map()
  for (const f of reader.files().filter((x) => /\.sql$/i.test(x) && /migrat|schema|ddl/i.test(x)).slice(0, 400)) {
    const src = reader.read(f) || ''
    for (const m of src.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(?:\w+\.)?[`"]?(\w+)[`"\]]?\s*\(/gi)) {
      const { args } = argsAt(src, m.index + m[0].length - 1)
      const cols = args.map((a) => a.text.match(/^[`"[]?(\w+)[`"\]]?\s+(\w+)/)).filter((c) => c && !/^(PRIMARY|FOREIGN|CONSTRAINT|UNIQUE|KEY|INDEX|CHECK)$/i.test(c[1])).map((c) => ({ name: c[1], type: c[2] }))
      const rels = args.flatMap((a) => [...a.text.matchAll(/REFERENCES\s+[`"]?(?:\w+\.)?(\w+)/gi)].map((r) => ({ kind: 'references', target: r[1], key: (a.text.match(/^[`"]?(\w+)/) || [])[1] || '' })))
      tables.set(m[1], { name: m[1], table: m[1], cols, rels, at: `${f}:${lineAt(src, m.index)}`, orm: 'SQL' })
    }
  }
  return [...tables.values()]
}

/** Files that use each model (by name, as a word), outside its own file: { name: [file…] }. */
export function usersOf(reader, models, cap = 15) {
  const out = {}
  const own = new Map(models.map((m) => [m.name, String(m.at).split(':')[0]]))
  const wanted = new Set(models.map((m) => m.name).filter((n) => /^[A-Z]\w{2,}$/.test(n)))
  const done = new Set() // "name file" pairs already counted
  // The files that use models are few and known by name; read them in one batch and look words up in a set
  // (a search for a hundred names at once is slow in git).
  const files = reader.files().filter((f) => JS.test(f) && notTest(f) && /service|controller|route|handler|resolver|repositor|job|worker|processor|use-?case/i.test(f))
  if (reader.prefetch) reader.prefetch(files)
  for (const file of files) {
    const text = reader.read(file)
    if (!text) continue
    for (const w of new Set(text.match(/[A-Z][\w$]{2,}/g) || [])) {
      if (!wanted.has(w) || own.get(w) === file) continue
      const k = `${w} ${file}`
      if (done.has(k)) continue
      done.add(k)
      const list = (out[w] ||= [])
      if (list.length < cap) list.push(file)
    }
  }
  return out
}

export const modelFile = (m) => posix.basename(String(m.at).split(':')[0] || '')
