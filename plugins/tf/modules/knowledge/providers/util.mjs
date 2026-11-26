// tf knowledge — small helpers the code maps share.
import { createHash } from 'node:crypto'

export const tsv = (s) => String(s ?? '').replace(/[\t\n\r]+/g, ' ')
export const slug = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x'
export const hash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 12)

/** Each repo's version, plus a hash of the config lines the map reads: what makes the map stale. */
export const versions = (ctx, settings = '') => ({
  ...Object.fromEntries(ctx.profile.repos.map((r) => [r.key, ctx.reader(r).version])),
  ...(settings ? { settings: hash(settings) } : {}),
})

/** Run fn once per run for this key (ctx.memo), or every time when there is no memo (tests). */
export const once = (ctx, key, fn) => (ctx.memo ? ctx.memo(key, fn) : fn())

/** Per repo: [{ key, reader, items }] for the repos where `items` is not empty. */
export const perRepo = (ctx, key, fn) => once(ctx, key, () => ctx.profile.repos.map((r) => { const reader = ctx.reader(r); return { key: r.key, reader, items: fn(reader) } }).filter((x) => x.items.length))
