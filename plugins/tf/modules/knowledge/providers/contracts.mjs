// tf knowledge map `contracts` — every HTTP route the workspace serves, who calls it (web, app, another service),
// its guards and validators, whether the OpenAPI spec has it; calls that match no route; socket events and both
// ends of each. Built from the framework readers in ../frameworks/ (one file per framework); a repo whose
// framework none of them knows is listed as not read, not guessed.
import { createHash } from 'node:crypto'

import express from '../frameworks/express.mjs'
import fastify from '../frameworks/fastify.mjs'
import { next, nuxt } from '../frameworks/file-routes.mjs'
import nestjs from '../frameworks/nestjs.mjs'
import { dartClients, jsClients } from '../frameworks/clients.mjs'
import { nestGateway, openapi, socketio } from '../frameworks/spec.mjs'
import { isSource, samePath, stripPrefix } from '../scan.mjs'

export const ROUTERS = [express, nestjs, next, nuxt, fastify]
const CALLERS = [jsClients, dartClients]
const SOCKETS = [socketio, nestGateway]

const tsv = (s) => String(s ?? '').replace(/[\t\n\r]+/g, ' ')
// Segments that say where an API lives, not what it is about — skipped when naming a route's domain.
const VERSIONED = /^(api|rest|v\d+(\.\d+)?)$/i
const AREA = /^(admin|public|private|internal|app|mobile|web|client|external|partner|portal|backoffice)$/i

/** A route's domain: its first meaningful segment (`/api/v1/orders/*` → orders; `/api/admin/users` → admin-users). */
export function domainOf(path, prefixes = []) {
  const segs = stripPrefix(path, prefixes).split('/').filter((s) => s && s !== '*')
  while (segs.length > 1 && VERSIONED.test(segs[0])) segs.shift()
  if (!segs.length) return 'root'
  if (AREA.test(segs[0]) && segs[1]) return `${segs[0]}-${segs[1]}`.toLowerCase()
  return segs[0].toLowerCase().replace(/[^a-z0-9-]+/g, '-')
}

const sameMethod = (a, b) => a === b || a === 'ANY' || b === 'ANY'

/**
 * Everything the contract map needs from a set of repos: [{ key, reader }] → { routes, calls, spec, sockets, coverage }.
 * Shared by the map and by `diff` (which reads a task's worktrees instead of the base branch).
 */
export function contractModel(repos, knowledge = {}) {
  const routes = [], calls = [], spec = [], sockets = [], coverage = []
  for (const { key, reader } of repos) {
    const ctx = { isSource, knowledge }
    const row = { repo: key, ref: reader.ref, frameworks: [], routes: 0, calls: 0, unresolved: 0, limits: [] }
    for (const fw of ROUTERS) {
      if (!fw.detect(reader)) continue
      const got = fw.extract(reader, ctx)
      row.frameworks.push(`${fw.name} (${got.length})`)
      if (fw.limits) row.limits.push(`${fw.name}: ${fw.limits}`)
      routes.push(...got.map((r) => ({ ...r, repo: key })))
      row.routes += got.length
    }
    for (const fw of CALLERS) {
      if (!fw.detect(reader)) continue
      const got = fw.extract(reader, ctx)
      row.unresolved += got.unresolved || 0
      if (!got.length) continue
      row.frameworks.push(`${fw.name} (${got.length})`)
      calls.push(...got.map((c) => ({ ...c, repo: key })))
      row.calls += got.length
    }
    if (openapi.detect(reader)) { const got = openapi.extract(reader); spec.push(...got.map((s) => ({ ...s, repo: key }))); if (got.length) row.frameworks.push(`OpenAPI (${got.length})`) }
    for (const fw of SOCKETS) if (fw.detect(reader)) sockets.push(...fw.extract(reader, ctx).map((s) => ({ ...s, repo: key })))
    coverage.push(row)
  }
  // Dedupe routes that two readers both found (same method, path, place).
  const seen = new Set()
  const uniq = routes.filter((r) => { const k = `${r.method} ${r.path} ${r.at}`; if (seen.has(k)) return false; seen.add(k); return true })
  return { routes: uniq, calls, spec, sockets, coverage }
}

/** Calls joined to the routes they reach; routes with their callers; calls that reach no route. */
export function join(model, knowledge = {}) {
  const prefixes = String(knowledge.apiPrefix || '').split(',').map((x) => x.trim()).filter(Boolean)
  const key = (p) => stripPrefix(p, prefixes)
  const byRoute = new Map(model.routes.map((r) => [r, []]))
  const orphans = []
  for (const c of model.calls) {
    const hits = model.routes.filter((r) => sameMethod(r.method, c.method) && (samePath(r.path, c.path) || samePath(key(r.path), key(c.path))))
    // The route shaped like the call wins: a parameter where the call has one, a fixed word where it has a word
    // (`/orders/*` → /orders/:id, not /orders/stats; `/orders/stats` → /orders/stats, not /orders/:id).
    const shape = (r) => { const x = key(r.path).split('/'), y = key(c.path).split('/'); return x.reduce((n, s, i) => n + (s === y[i] ? 2 : (s === '*') === (y[i] === '*') ? 1 : 0), 0) }
    const best = hits.sort((a, b) => shape(b) - shape(a))[0]
    if (best) byRoute.get(best).push(c)
    else orphans.push(c)
  }
  const inSpec = (r) => model.spec.some((s) => sameMethod(s.method, r.method) && (samePath(s.path, r.path) || samePath(key(s.path), key(r.path))))
  return { byRoute, orphans, inSpec, prefixes }
}

function render(ctx, model) {
  const { byRoute, orphans, inSpec, prefixes } = join(model, ctx.knowledge)
  const out = {}
  const callerLine = (c) => `${c.repo} · \`${c.fn || '?'}\` · \`${c.at}\``
  const hasSpec = model.spec.length > 0
  // index.tsv
  const rows = [['method', 'path', 'domain', 'repo', 'at', 'guards', 'validators', 'framework', 'openapi', 'callers', 'callers_at'].join('\t')]
  const domains = new Map()
  for (const r of [...model.routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
    const cs = byRoute.get(r) || []
    const d = domainOf(r.path, prefixes)
    if (!domains.has(d)) domains.set(d, [])
    domains.get(d).push(r)
    rows.push([r.method, r.path, d, r.repo, r.at, r.guards.join(', '), r.validators.join(', '), r.framework, hasSpec ? (inSpec(r) ? 'y' : 'n') : '', cs.length, cs.slice(0, 5).map((c) => `${c.repo}:${c.at} ${c.fn || ''}`.trim()).join(' · ')].map(tsv).join('\t'))
  }
  out['contracts/index.tsv'] = `${rows.join('\n')}\n`
  // by-domain pages
  for (const [d, rs] of domains) {
    const lines = [`# Contracts — ${d}`, '', `Generated by tf from the base branches — do not edit. ${rs.length} route(s). Grep \`contracts/index.tsv\` for one route.`, '']
    for (const r of rs) {
      const cs = byRoute.get(r) || []
      const meta = [r.repo, `\`${r.at}\``, r.guards.length ? `guards: ${r.guards.join(', ')}` : 'no guard found', r.validators.length ? `validators: ${r.validators.join(', ')}` : '', hasSpec ? `openapi: ${inSpec(r) ? 'yes' : 'no'}` : ''].filter(Boolean).join(' · ')
      lines.push(`- **${r.method}** \`${r.path}\` — ${meta}`)
      for (const c of cs.slice(0, 12)) lines.push(`  - called by ${callerLine(c)}`)
      if (cs.length > 12) lines.push(`  - … ${cs.length - 12} more (index.tsv)`)
    }
    out[`contracts/by-domain/${d}.md`] = `${lines.join('\n')}\n`
  }
  // orphans
  const lonely = model.calls.length ? model.routes.filter((r) => !(byRoute.get(r) || []).length) : []
  out['contracts/orphans.md'] = [
    '# Contracts — not matched', '',
    'Listed, not judged: a call can be built in a way the readers do not follow, a route can be called by a client outside this workspace.', '',
    `## Calls that reach no route (${orphans.length})`, '',
    ...(orphans.length ? orphans.map((c) => `- **${c.method}** \`${c.path}\` — ${callerLine(c)}`) : ['_None._']),
    '',
    `## Routes no call in this workspace reaches (${lonely.length})`, '',
    ...(model.calls.length ? (lonely.length ? lonely.map((r) => `- **${r.method}** \`${r.path}\` — ${r.repo} \`${r.at}\``) : ['_None._']) : ['_No client code was read in this workspace, so this is not listed._']),
    '',
  ].join('\n')
  // sockets
  if (model.sockets.length) {
    const ev = new Map()
    for (const s of model.sockets) { if (!ev.has(s.event)) ev.set(s.event, []); ev.get(s.event).push(s) }
    const lines = ['# Contracts — socket events', '', '| event | emitted by | listened by |', '|---|---|---|']
    for (const [e, ss] of [...ev].sort((a, b) => a[0].localeCompare(b[0]))) {
      const fmt = (list) => list.map((s) => `${s.repo} (${s.side}) \`${s.at}\``).join('<br>') || '—'
      lines.push(`| \`${e}\` | ${fmt(ss.filter((s) => s.dir === 'emit'))} | ${fmt(ss.filter((s) => s.dir === 'on'))} |`)
    }
    out['contracts/socket.md'] = `${lines.join('\n')}\n`
  }
  // README: what was read, how much was recognised.
  const matched = model.calls.length - orphans.length
  out['contracts/README.md'] = [
    '# Contracts', '',
    'Routes ↔ calls across the workspace, read from the base branches by tf. Pages:',
    '- `by-domain/<domain>.md` — the routes of one area, each with its guards, validators and callers',
    '- `index.tsv` — one line per route (grep a path or a handler)',
    '- `orphans.md` — calls that reach no route, routes nothing here calls',
    ...(model.sockets.length ? ['- `socket.md` — socket events, who emits and who listens'] : []),
    '', '## What was read', '',
    '| repo | read from | recognised | routes | calls | calls with a path built at run time |', '|---|---|---|---|---|---|',
    ...model.coverage.map((c) => `| ${c.repo} | \`${c.ref}\` | ${c.frameworks.join(', ') || '— (no framework this map knows)'} | ${c.routes} | ${c.calls} | ${c.unresolved} |`),
    '',
    `Calls matched to a route: ${matched} of ${model.calls.length}.${prefixes.length ? ` API prefix from the config: ${prefixes.join(', ')}.` : ''}`,
    ...model.coverage.flatMap((c) => c.limits.map((l) => `- Not followed — ${l}`)),
    '', 'A route here is a starting point: check it in the code (codegraph) before relying on it.', '',
  ].join('\n')
  return out
}

export default {
  name: 'contracts',
  answers: 'Which routes the workspace serves, their guards and validators, who calls each (web, app, services), calls that reach no route, socket events',
  applies: (ctx) => ctx.profile.repos.some((r) => { const rd = ctx.reader(r); return ROUTERS.some((f) => f.detect(rd)) || openapi.detect(rd) }),
  sources: (ctx) => ({
    ...Object.fromEntries(ctx.profile.repos.map((r) => [r.key, ctx.reader(r).version])),
    settings: createHash('sha1').update(`${ctx.knowledge.apiPrefix || ''}|${ctx.knowledge.apiClients || ''}`).digest('hex').slice(0, 12),
  }),
  generate: (ctx) => render(ctx, contractModel(ctx.profile.repos.map((r) => ({ key: r.key, reader: ctx.reader(r) })), ctx.knowledge)),
}
