// tf engine — does an answer match its schema? For a host that cannot make an agent return JSON of a given
// shape: it asks for it in the prompt, then checks here and asks again with what was wrong. The subset of JSON
// Schema the engine's schemas use: type (object, array, string, boolean, integer, number), properties,
// required, enum, items, minimum.

/**
 * @param {unknown} value
 * @param {object} schema
 * @param {string} [at]
 * @returns {string[]} what is wrong, one line each ([] = valid)
 */
export function validate(value, schema, at = '') {
  const out = []
  const where = at || '(answer)'
  const t = schema.type
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${where}: expected an object`]
    for (const k of schema.required || []) if (!(k in value)) out.push(`${at ? `${at}.` : ''}${k}: required`)
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in value && value[k] !== null && value[k] !== undefined) out.push(...validate(value[k], sub, at ? `${at}.${k}` : k))
    return out
  }
  if (t === 'array') {
    if (!Array.isArray(value)) return [`${where}: expected an array`]
    if (schema.items) value.forEach((v, i) => out.push(...validate(v, schema.items, `${at}[${i}]`)))
    return out
  }
  if (t === 'string' && typeof value !== 'string') return [`${where}: expected a string`]
  if (t === 'boolean' && typeof value !== 'boolean') return [`${where}: expected true or false`]
  if (t === 'integer' && !Number.isInteger(value)) return [`${where}: expected an integer`]
  if (t === 'number' && typeof value !== 'number') return [`${where}: expected a number`]
  if (schema.enum && !schema.enum.includes(value)) return [`${where}: one of ${schema.enum.join(', ')}`]
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) return [`${where}: at least ${schema.minimum}`]
  return out
}

/** The last JSON object in a model's final message: bare, or in a ```json fence. null when there is none. */
export function lastJson(text) {
  const s = String(text || '')
  const fences = [...s.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1])
  for (const c of [...fences.reverse(), s.trim()]) { try { const v = JSON.parse(c); if (v && typeof v === 'object') return v } catch {} }
  // The widest {...} that parses, ending at one of the last closing braces (bounded: a long message is mostly prose).
  let tries = 0
  for (let end = s.lastIndexOf('}'); end > 0 && tries < 4000; end = s.lastIndexOf('}', end - 1)) {
    for (let start = s.indexOf('{'); start >= 0 && start < end && tries < 4000; start = s.indexOf('{', start + 1), tries++) {
      try { const v = JSON.parse(s.slice(start, end + 1)); if (v && typeof v === 'object') return v } catch {}
    }
  }
  return null
}
