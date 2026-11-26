// tf knowledge — the paths that run without a user's request: cron schedules (node-cron, cron, @Cron,
// @nestjs/schedule intervals, agenda), queues and their workers (BullMQ, Bull, Nest @Processor), in-process and
// Redis events (EventEmitter, @OnEvent, publish/subscribe), and routes that look like webhooks. Names given through
// a constant of the repo (QUEUE_NAMES.X) are resolved; a name built at run time is shown as written.
import { posix } from 'node:path'

import { blankComments } from '../scan.mjs'
import { calls, enclosing, hasDep, nameOf, repoConstants, grepFiles } from './util.mjs'

const JS = /\.(m?[jt]sx?|cjs)$/
const short = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 80)

// The class or function a job lives in, else the file's name: what to call a cron job that has no name.
function owner(src, i, file) {
  const before = src.slice(0, i)
  const cls = [...before.matchAll(/\bclass\s+(\w+)/g)].pop()
  return (cls && cls[1]) || enclosing(src, i) || posix.basename(file).replace(/\.\w+$/, '')
}

export default {
  name: 'runtime',
  detect: (reader) => hasDep(reader, ['node-cron', 'cron', '@nestjs/schedule', 'agenda', 'bullmq', 'bull', '@nestjs/bull', '@nestjs/bullmq', 'eventemitter2', '@nestjs/event-emitter', 'ioredis', 'redis']),
  extract(reader, { isSource }) {
    let cache = null
    const consts = new Proxy({}, { get: (_, k) => (cache ||= repoConstants(reader))[k], has: (_, k) => k in (cache ||= repoConstants(reader)) })
    const out = []
    const files = grepFiles(reader, '((cron|nodeCron)\\.schedule|new CronJob|@Cron|@Interval|@Timeout|agenda\\.|new (Queue|Worker|Bull)[^(]{0,80}|@Process|[Qq]ueue(\\(\\))?\\s*\\.\\s*add|@OnEvent|([Ee]mitter|[Ee]vents|[Bb]us)\\s*\\.\\s*(emit|on|once)|\\.(publish|subscribe|psubscribe))\\s*\\(', (f) => JS.test(f) && isSource(f))
    for (const file of files) {
      const raw = reader.read(file) || ''
      const src = blankComments(raw)
      const add = (kind, name, detail, i, line) => out.push({ kind, name: short(name), detail: short(detail), at: `${file}:${line}`, in: owner(src, i, file) })
      for (const c of calls(src, /\b(?:cron|nodeCron)\.schedule\s*\(/g)) add('cron', owner(src, c.m.index, file), nameOf(c.args[0], consts) || c.args[0]?.text, c.m.index, c.line)
      for (const c of calls(src, /\bnew\s+CronJob\s*\(/g)) add('cron', owner(src, c.m.index, file), nameOf(c.args[0], consts) || c.args[0]?.text, c.m.index, c.line)
      for (const c of calls(src, /@Cron\s*\(/g)) add('cron', enclosing(raw, c.end) || owner(src, c.m.index, file), c.args[0]?.text, c.m.index, c.line)
      for (const c of calls(src, /@(Interval|Timeout)\s*\(/g)) add('cron', enclosing(raw, c.end) || owner(src, c.m.index, file), `${c.m[1]} ${c.args.map((a) => a.text).join(', ')}`, c.m.index, c.line)
      for (const c of calls(src, /\bagenda\.(every|define|schedule)\s*\(/g)) add('cron', nameOf(c.args[c.m[1] === 'define' ? 0 : 1], consts) || c.args[0]?.text, c.m[1] === 'define' ? 'agenda job' : `agenda ${c.args[0]?.text}`, c.m.index, c.line)
      for (const c of calls(src, /\bnew\s+(Queue|Worker|Bull)\s*(?:<[^>()]*>)?\s*\(/g)) add(c.m[1] === 'Worker' ? 'worker' : 'queue', nameOf(c.args[0], consts) || c.args[0]?.text, c.m[1], c.m.index, c.line)
      for (const c of calls(src, /@(Processor|Process)\s*\(/g)) add('worker', nameOf(c.args[0], consts) || c.args[0]?.text || '(default)', `@${c.m[1]}`, c.m.index, c.line)
      for (const c of calls(src, /\b(\w*[Qq]ueue)(?:\(\))?\s*\.\s*add\s*\(/g)) add('job', nameOf(c.args[0], consts) || c.args[0]?.text, `added to ${c.m[1]}`, c.m.index, c.line)
      for (const c of calls(src, /@OnEvent\s*\(/g)) add('event', nameOf(c.args[0], consts) || c.args[0]?.text, 'listener', c.m.index, c.line)
      for (const c of calls(src, /\b(?:this\.)?(\w*(?:[Ee]mitter|[Ee]vents|[Bb]us))\s*\.\s*(emit|on|once|emitAsync)\s*\(/g)) add('event', nameOf(c.args[0], consts) || c.args[0]?.text, c.m[2] === 'emit' || c.m[2] === 'emitAsync' ? `emitted on ${c.m[1]}` : `listened on ${c.m[1]}`, c.m.index, c.line)
      for (const c of calls(src, /\b(\w*(?:[Rr]edis|[Pp]ub|[Ss]ub|[Pp]ublisher|[Ss]ubscriber|[Cc]onnection|[Cc]lient|duplicate))(?:\([^()]*\))?\s*\.\s*(publish|subscribe|psubscribe)\s*\(/g)) add('pubsub', nameOf(c.args[0], consts) || c.args[0]?.text, c.m[2] === 'publish' ? 'publish' : 'subscribe', c.m.index, c.line)
    }
    return out
  },
}
