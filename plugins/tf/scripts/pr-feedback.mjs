#!/usr/bin/env node
// tf PR feedback: what the team said on the PRs we pushed, and replying to it (after the user approves).
//
//   fetch <dir> <pr-url>…            pass every PR of the task (open and merged): a status table (decision, whether a
//                                    push is allowed), then unresolved review threads, reviews and conversation comments of each OPEN PR
//                                    → <dir>/feedback.md (for the PM) + <dir>/feedback.json (ids, raw data).
//                                    Threads get stable ids R<n> across runs. "new" = written after the PR's last
//                                    commit. Bots are skipped; a thread whose last comment is ours is "replied".
//                                    Prints a JSON summary {prs:[{url,state,decision,open,new,replied}], total, newTotal}.
//   reply <dir> <Rn> --body-file <f> [--resolve]   reply in thread Rn (and resolve it)
//   resolve <dir> <Rn>
//   comment <dir> <pr-url> --body-file <f>         a conversation comment on the PR
//
// Posting commands are for the orchestrator only, after the user approved the exact text.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const gh = (args, input) => execFileSync('gh', args, { stdio: ['pipe', 'pipe', 'pipe'], input, timeout: 60_000, maxBuffer: 64 << 20 }).toString()
const graphql = (query, vars) => {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`)
  const r = JSON.parse(gh(args))
  if (r.errors) throw new Error(r.errors.map((e) => e.message).join('; '))
  return r.data
}

const PR_QUERY = `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){
  number url state isDraft reviewDecision headRefName author{login}
  commits(last:1){nodes{commit{oid committedDate}}}
  reviews(last:50){nodes{author{login __typename} state body submittedAt url}}
  comments(last:100){nodes{author{login __typename} body createdAt url}}
  reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine
    comments(first:50){nodes{author{login __typename} body createdAt url}}}}
}}}`

export function parsePr(u) {
  const m = String(u).match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/) || String(u).match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/)
  if (!m) throw new Error(`not a PR url: ${u}`)
  return { owner: m[1], repo: m[2], n: Number(m[3]) }
}
const isBot = (a) => !a || a.__typename === 'Bot' || /\[bot\]$/.test(a.login || '')
// Full text, never clipped: teams often post a whole review (many points) as one conversation comment.
const quote = (s) => String(s || '').trim().split('\n').map((l) => `> ${l}`).join('\n')

// Pure: turn one PR payload into the feedback model. `me` = our login, `ids` = {threadId: 'R<n>'} (mutated), `next` = {n}.
export function summarize(pr, me, ids, next) {
  const lastCommit = (pr.commits.nodes[0] || {}).commit || {}
  const since = lastCommit.committedDate || ''
  const after = (d) => !!since && d > since
  const mine = (a) => a && a.login === me
  const threads = []
  for (const t of pr.reviewThreads.nodes) {
    if (t.isResolved) continue
    const cs = t.comments.nodes.filter((c) => !isBot(c.author))
    if (!cs.length) continue
    if (!ids[t.id]) ids[t.id] = `R${next.n++}`
    const last = cs[cs.length - 1]
    threads.push({
      rid: ids[t.id], threadId: t.id, path: t.path, line: t.line || t.originalLine, outdated: t.isOutdated,
      reviewer: (cs.find((c) => !mine(c.author)) || cs[0]).author.login,
      replied: mine(last.author),
      new: cs.some((c) => !mine(c.author) && after(c.createdAt)),
      comments: cs.map((c) => ({ author: c.author.login, at: c.createdAt, body: c.body, url: c.url })),
    })
  }
  const reviews = pr.reviews.nodes
    .filter((r) => !isBot(r.author) && !mine(r.author) && (r.body.trim() || r.state !== 'COMMENTED'))
    .map((r) => ({ author: r.author.login, state: r.state, at: r.submittedAt, body: r.body, url: r.url, new: after(r.submittedAt) }))
  const comments = pr.comments.nodes
    .filter((c) => !isBot(c.author) && !mine(c.author))
    .map((c) => ({ author: c.author.login, at: c.createdAt, body: c.body, url: c.url, new: after(c.createdAt) }))
  return {
    url: pr.url, number: pr.number, state: pr.state, draft: pr.isDraft, decision: pr.reviewDecision || 'NONE',
    branch: pr.headRefName, head: (lastCommit.oid || '').slice(0, 7), headAt: since, threads, reviews, comments,
  }
}

// What the PM may do to this PR's branch (pm.md "Several PRs").
export const pushRule = (p) =>
  p.state === 'MERGED' ? 'no — new PR if needed'
    : p.state !== 'OPEN' ? 'no'
      : p.decision === 'APPROVED' ? 'only P0–P2 bug or contract change'
        : 'yes, for `fix` points'

export function render(prs, at) {
  const out = [`# PR feedback — fetched ${at}`, '', 'Threads R<n> are unresolved review threads (stable ids). [new] = written after the PR\'s last commit;',
    '[replied] = our reply is the last word (waiting for the reviewer).', '',
    '| PR | state | review decision | push allowed | open threads | new |', '|---|---|---|---|---|---|']
  for (const p of prs) out.push(`| ${p.url} | ${p.state}${p.draft ? ' (draft)' : ''} | **${p.decision}** | ${pushRule(p)} | ${p.state === 'OPEN' ? p.threads.length : '-'} | ${p.state === 'OPEN' ? p.threads.filter((t) => t.new).length : '-'} |`)
  out.push('')
  for (const p of prs) {
    out.push(`## ${p.url} — ${p.state}${p.draft ? ' (draft)' : ''} · review decision **${p.decision}** · branch ${p.branch} · head ${p.head} (${p.headAt})`, '')
    if (p.state === 'MERGED') { out.push('Merged — never pushed to. A change this repo now needs (e.g. a contract change from another PR) goes to a new branch from its base and a new PR.', ''); continue }
    if (p.state !== 'OPEN') { out.push('Closed — skipped.', ''); continue }
    if (p.reviews.length) {
      out.push('### Reviews')
      for (const r of p.reviews) out.push(`- **${r.author}** ${r.state} ${r.at}${r.new ? ' [new]' : ''}${r.body.trim() ? `\n${quote(r.body)}` : ''}`)
      out.push('')
    }
    out.push(`### Open threads (${p.threads.length})`)
    if (!p.threads.length) out.push('None.')
    for (const t of p.threads) {
      out.push(`#### ${t.rid}${t.new ? ' [new]' : ''}${t.replied ? ' [replied]' : ''}${t.outdated ? ' [outdated]' : ''} · \`${t.path}:${t.line ?? '?'}\` · ${t.reviewer}`)
      for (const c of t.comments) out.push(`**${c.author}** ${c.at}\n${quote(c.body)}`)
      out.push('')
    }
    if (p.comments.length) {
      out.push('### Conversation comments')
      for (const c of p.comments) out.push(`- **${c.author}** ${c.at}${c.new ? ' [new]' : ''}\n${quote(c.body)}`)
      out.push('')
    }
  }
  return out.join('\n') + '\n'
}

const stateOf = (dir) => {
  const f = join(dir, 'feedback.json')
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { ids: {}, next: 1, prs: [] }
}

function fetchAll(dir, urls) {
  const st = stateOf(dir)
  const me = gh(['api', 'user', '--jq', '.login']).trim()
  const next = { n: st.next || 1 }
  const prs = []
  for (const u of urls) {
    const { owner, repo, n } = parsePr(u)
    const pr = graphql(PR_QUERY, { owner, repo, n }).repository.pullRequest
    prs.push(summarize(pr, me, st.ids, next))
  }
  const at = new Date().toISOString()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'feedback.json'), JSON.stringify({ fetchedAt: at, me, ids: st.ids, next: next.n, prs }, null, 2) + '\n')
  writeFileSync(join(dir, 'feedback.md'), render(prs, at))
  const open = prs.filter((p) => p.state === 'OPEN')
  const summary = {
    prs: prs.map((p) => ({ url: p.url, state: p.state, decision: p.decision, open: p.threads.length, new: p.threads.filter((t) => t.new).length, replied: p.threads.filter((t) => t.replied).length, reviews: p.reviews.length, comments: p.comments.length })),
    total: open.reduce((s, p) => s + p.threads.length, 0),
    newTotal: open.reduce((s, p) => s + p.threads.filter((t) => t.new).length + p.reviews.filter((r) => r.new).length + p.comments.filter((c) => c.new).length, 0),
    file: join(dir, 'feedback.md'),
  }
  console.log(JSON.stringify(summary, null, 2))
}

function threadOf(dir, rid) {
  for (const p of stateOf(dir).prs) for (const t of p.threads) if (t.rid === rid) return t
  throw new Error(`${rid} not found in ${join(dir, 'feedback.json')} — fetch first`)
}

function main() {
  const [cmd, dirArg, ...rest] = process.argv.slice(2)
  const flags = {}
  const pos = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--resolve') flags.resolve = true
    else if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i]
    else pos.push(rest[i])
  }
  if (!cmd || !dirArg) { console.error('usage: pr-feedback.mjs fetch|reply|resolve|comment <dir> …'); process.exit(2) }
  const dir = resolve(dirArg)
  const body = () => { if (!flags['body-file']) throw new Error('--body-file required'); return readFileSync(flags['body-file'], 'utf8').trim() }
  if (cmd === 'fetch') return fetchAll(dir, pos)
  if (cmd === 'reply' || cmd === 'resolve') {
    const t = threadOf(dir, pos[0])
    if (cmd === 'reply') {
      graphql('mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{url}}}', { id: t.threadId, body: body() })
    }
    if (cmd === 'resolve' || flags.resolve) graphql('mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}', { id: t.threadId })
    return console.log(JSON.stringify({ rid: pos[0], replied: cmd === 'reply', resolved: cmd === 'resolve' || !!flags.resolve }))
  }
  if (cmd === 'comment') {
    const { owner, repo, n } = parsePr(pos[0])
    gh(['pr', 'comment', String(n), '--repo', `${owner}/${repo}`, '--body-file', '-'], body())
    return console.log(JSON.stringify({ commented: pos[0] }))
  }
  throw new Error(`unknown command ${cmd}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (e) { console.error(String(e.stderr || e.message || e)); process.exit(1) }
}
