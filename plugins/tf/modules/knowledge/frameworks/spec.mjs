// tf knowledge — what an API says about itself, and its socket events:
//   OpenAPI   openapi*/swagger* files (YAML or JSON): method + path pairs
//   socket.io `emit('event')` / `on('event')`, sided by the package the repo uses (server or client)
import { blankComments, joinPaths, lineAt, normPath } from '../scan.mjs'

// The path part of the first server URL that has one ('/api' from 'https://host/api' or '/api').
const serverPath = (urls) => { for (const u of urls) { const p = normPath(String(u).replace(/\{[^}]*\}/g, 'x')); if (p && p !== '/') return p } return '' }
import { hasDep, pubDeps } from './util.mjs'

export const openapi = {
  name: 'OpenAPI',
  kind: 'spec',
  detect: (reader) => reader.files().some((f) => /(^|\/)(openapi|swagger)[\w.-]*\.(ya?ml|json)$/i.test(f) && !/node_modules/.test(f)),
  extract(reader) {
    const out = []
    for (const f of reader.files().filter((x) => /(^|\/)(openapi|swagger)[\w.-]*\.(ya?ml|json)$/i.test(x))) {
      const text = reader.read(f) || ''
      if (/\.json$/i.test(f)) {
        try {
          const j = JSON.parse(text)
          const base = serverPath((j.servers || []).map((x) => x && x.url).filter(Boolean)) || (j.basePath || '')
          for (const [p, ops] of Object.entries(j.paths || {})) for (const m of Object.keys(ops)) if (/^(get|post|put|patch|delete|head|options)$/.test(m)) out.push({ method: m.toUpperCase(), path: joinPaths(base, p), at: f })
        } catch {}
        continue
      }
      // `servers: - url: /api` (or a full URL): the prefix every path is served under.
      const urls = []
      let inServers = false
      for (const l of text.split('\n')) {
        if (/^servers:\s*$/.test(l)) { inServers = true; continue }
        if (/^\S/.test(l)) inServers = false
        const u = inServers && l.match(/^\s*-?\s*url:\s*['"]?([^'"\s]+)/)
        if (u) urls.push(u[1])
      }
      const basePath = (text.match(/^basePath:\s*['"]?([^'"\s]+)/m) || [])[1]
      const base = serverPath(urls) || basePath || ''
      // YAML: `paths:` at the top, a path key one level in, its methods one level deeper.
      let inPaths = false, cur = '', pathIndent = -1
      text.split('\n').forEach((l, i) => {
        if (/^paths:\s*$/.test(l)) { inPaths = true; return }
        if (/^\S/.test(l)) { inPaths = false; return }
        if (!inPaths) return
        const k = l.match(/^(\s+)['"]?(\/[^'":]*)['"]?:\s*$/)
        if (k && (pathIndent < 0 || k[1].length === pathIndent)) { pathIndent = k[1].length; cur = joinPaths(base, k[2]); return }
        const m = l.match(/^(\s+)(get|post|put|patch|delete|head|options):/)
        if (m && cur && m[1].length > pathIndent) out.push({ method: m[2].toUpperCase(), path: cur, at: `${f}:${i + 1}` })
      })
    }
    return out
  },
}

const BUILTIN = new Set(['connect', 'connection', 'disconnect', 'disconnecting', 'error', 'connect_error', 'reconnect', 'ping', 'pong', 'message', 'close', 'open', 'data', 'end', 'finish', 'exit', 'change', 'click', 'response', 'request', 'ready'])

export const socketio = {
  name: 'socket.io',
  kind: 'socket',
  detect: (reader) => hasDep(reader, ['socket.io', 'socket.io-client', '@nestjs/websockets']) || pubDeps(reader).has('socket_io_client'),
  extract(reader, { isSource }) {
    const server = hasDep(reader, ['socket.io', '@nestjs/websockets'])
    const out = []
    for (const file of new Set(reader.grep('\\.(emit|on|once)\\s*\\(\\s*[\'"`]', (f) => (/\.(m?[jt]sx?|cjs|vue|dart)$/.test(f) && isSource(f, /./)) || /\.dart$/.test(f)).map((h) => h.file))) {
      const src = blankComments(reader.read(file) || '')
      for (const m of src.matchAll(/\b(\w+)(?:\s*\.\s*(?:to|in|of|broadcast)\s*\([^)]*\))*\s*\.\s*(emit|on|once)\s*\(\s*(['"`])([\w:./-]+)\3/g)) {
        if (BUILTIN.has(m[4]) || /^(process|window|document|emitter|events?|bus|ee|stream|req|res|app|server|worker|queue|job|redis|sub|pub|el|element)$/i.test(m[1])) continue
        out.push({ event: m[4], dir: m[2] === 'emit' ? 'emit' : 'on', side: server && !/\.dart$/.test(file) ? 'server' : 'client', at: `${file}:${lineAt(src, m.index)}` })
      }
    }
    return out
  },
}

// Nest's @SubscribeMessage('event') is a listener on the server.
export const nestGateway = {
  name: 'NestJS gateways',
  kind: 'socket',
  detect: (reader) => hasDep(reader, ['@nestjs/websockets']),
  extract(reader) {
    return reader.grep("@SubscribeMessage\\s*\\(\\s*['\"`]", (f) => /\.ts$/.test(f)).map((h) => ({ event: (h.text.match(/@SubscribeMessage\s*\(\s*['"`]([^'"`]+)/) || [])[1], dir: 'on', side: 'server', at: `${h.file}:${h.line}` })).filter((x) => x.event)
  },
}
