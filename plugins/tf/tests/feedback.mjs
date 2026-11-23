// Answering a review round: one draft file → one submitted review per PR.
// Run: node --test tests/feedback.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseReplies, planRound, postRound, render, renderFeedback, seenUrls, summarize } from '../scripts/pr-feedback.mjs'

const API = 'https://github.com/org/api/pull/665'
const WEB = 'https://github.com/org/web/pull/12'
const DRAFT = `# Replies

## ${API}

### Summary
## Review reply · abc1234

**@thang**
| # | Point | Result |
|---|---|---|
| 1 | No validation | Fixed — abc1234 |

### Not a block heading
still summary

### R3 · resolve: yes
Fixed in abc1234.

### r4 · resolve: NO
Not changed: policy.

## ${WEB}

### Summary
Answered — nothing to change.
`
const state = {
  prs: [
    { url: API, state: 'OPEN', threads: [{ rid: 'R3', threadId: 'T3' }, { rid: 'R4', threadId: 'T4' }] },
    { url: WEB, state: 'OPEN', threads: [] },
  ],
}

test('the draft is split by PR, Summary and thread; other headings stay in the text', () => {
  const [api, web] = parseReplies(DRAFT)
  assert.equal(api.pr, API)
  assert.match(api.summary, /^## Review reply · abc1234/)
  assert.match(api.summary, /### Not a block heading\nstill summary$/)
  assert.deepEqual(api.threads, [
    { rid: 'R3', resolve: true, body: 'Fixed in abc1234.' },
    { rid: 'R4', resolve: false, body: 'Not changed: policy.' },
  ])
  assert.deepEqual(web, { pr: WEB, summary: 'Answered — nothing to change.', threads: [] })
})

test('a round is refused whole when one block is wrong', () => {
  const bad = (draft, re) => assert.throws(() => planRound(parseReplies(draft), state), re)
  bad(DRAFT.replace('R3 ·', 'R9 ·'), /R9 is not an open thread/)
  bad(DRAFT.replace('Fixed in abc1234.', ''), /R3: empty reply/)
  bad(DRAFT.replace('r4 ·', 'R3 ·'), /R3 is answered twice/)
  bad(DRAFT.replace(WEB, 'https://github.com/org/other/pull/1'), /not in feedback\.json/)
  bad('nothing here', /nothing to post/)
  assert.throws(() => planRound(parseReplies(DRAFT), { prs: [{ ...state.prs[0], state: 'MERGED' }, state.prs[1]] }), /is MERGED/)
})

const fakeApi = (failOn) => {
  const calls = []
  return {
    calls,
    gh: (args, input) => { calls.push(['gh', args.slice(0, 3).join(' '), input]); return '' },
    graphql: (q, vars) => {
      const name = (q.match(/(addPullRequestReviewThreadReply|addPullRequestReview|submitPullRequestReview|deletePullRequestReview|resolveReviewThread|pullRequest\(number)/) || [])[1]
      calls.push([name, vars])
      if (name === failOn) throw new Error('boom')
      if (name === 'pullRequest(number') return { repository: { pullRequest: { id: 'PR1' } } }
      if (name === 'addPullRequestReview') return { addPullRequestReview: { pullRequestReview: { id: 'REV1' } } }
      if (name === 'submitPullRequestReview') return { submitPullRequestReview: { pullRequestReview: { url: `${API}#pullrequestreview-1` } } }
      return {}
    },
  }
}

test('one PR = one pending review, every reply inside it, submitted once, then resolved', () => {
  const api = fakeApi()
  const done = postRound(planRound(parseReplies(DRAFT), state), api)
  assert.deepEqual(api.calls.map((c) => c[0]), [
    'pullRequest(number', 'addPullRequestReview', 'addPullRequestReviewThreadReply', 'addPullRequestReviewThreadReply',
    'submitPullRequestReview', 'resolveReviewThread', 'gh',
  ])
  assert.deepEqual(api.calls[2][1], { review: 'REV1', id: 'T3', body: 'Fixed in abc1234.' })
  assert.match(api.calls[4][1].body, /@thang/)
  assert.deepEqual(api.calls[5][1], { id: 'T3' }) // R4 is `resolve: no`
  // A PR with nothing but a Summary gets one plain comment.
  assert.deepEqual(api.calls[6], ['gh', 'pr comment 12', 'Answered — nothing to change.'])
  assert.deepEqual(done, [
    { pr: API, review: `${API}#pullrequestreview-1`, replies: 2, resolved: 1 },
    { pr: WEB, comment: true, replies: 0, resolved: 0 },
  ])
})

test('a failure before the submit removes the pending review and resolves nothing', () => {
  const api = fakeApi('submitPullRequestReview')
  assert.throws(() => postRound(planRound(parseReplies(DRAFT), state), api), /nothing was posted — boom/)
  const names = api.calls.map((c) => c[0])
  assert.equal(names.at(-1), 'deletePullRequestReview')
  assert.ok(!names.includes('resolveReviewThread') && !names.includes('gh'))
})

test('reviewers who were asked and have not reviewed are reported', () => {
  const pr = {
    number: 665, url: API, state: 'OPEN', isDraft: false, reviewDecision: null, headRefName: 'feat/x',
    commits: { nodes: [{ commit: { oid: 'abc1234def', committedDate: '2026-11-10T00:00:00Z' } }] },
    reviews: { nodes: [] }, comments: { nodes: [] }, reviewThreads: { nodes: [] },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'hoa' } }, { requestedReviewer: { __typename: 'Team' } }, { requestedReviewer: null }] },
  }
  const p = summarize(pr, 'me', {}, { n: 1 })
  assert.deepEqual(p.waiting, ['hoa', '(team)'])
  assert.match(render([p], 'now'), /Still waiting for a review from: hoa, \(team\)\./)
  // Data fetched before this field existed still renders.
  delete pr.reviewRequests
  assert.deepEqual(summarize(pr, 'me', {}, { n: 1 }).waiting, [])
})

// ── Our review of someone else's PR: one review, findings on their lines ──
import { diffLines, parseReview, planReview } from '../scripts/pr-feedback.mjs'

const DIFF = `diff --git a/src/cart.ts b/src/cart.ts
index 111..222 100644
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -10,4 +10,5 @@ export function add() {
 keep
-old
+new one
+new two
 keep
@@ -40,2 +41,2 @@
-x
+y
 z
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+++ looks like a header
+second
`
const REVIEW = `## Summary
Not run on the app. Read the diff and its callers; typecheck passes.

## Findings
- [P1] \`src/cart.ts:12\` — quantity is not validated; a negative value lowers the total. Check it before the insert.
- [P2] \`src/price.ts:88\` — the cache is read by the admin screen
  and is not invalidated here.
- [INFO] Is the limit per user or per cart?

## Recommendation
REQUEST_CHANGES — the P1 unblocks it.
`

test('only lines the diff shows on the new side take an inline comment', () => {
  const m = diffLines(DIFF)
  assert.deepEqual([...m.get('src/cart.ts')], [10, 11, 12, 13, 41, 42])
  assert.deepEqual([...m.get('new.ts')], [1, 2]) // a "+++ …" content line is not a file header
  assert.ok(!m.has('gone.ts') && !m.has('/dev/null'))
})

test('findings on a diff line go inline, the rest stay in the body, as one review', () => {
  const parsed = parseReview(REVIEW)
  assert.equal(parsed.findings.length, 3)
  assert.deepEqual([parsed.findings[1].path, parsed.findings[1].line, parsed.findings[1].level], ['src/price.ts', 88, 'P2'])
  const plan = planReview(parsed, diffLines(DIFF))
  assert.deepEqual(plan.inline, [{ path: 'src/cart.ts', line: 12, side: 'RIGHT', body: '[P1] quantity is not validated; a negative value lowers the total. Check it before the insert.' }])
  assert.match(plan.body, /^## Summary\nNot run on the app/)
  assert.match(plan.body, /## Findings\n- \[P2\] `src\/price\.ts:88` — the cache is read by the admin screen\nand is not invalidated here\.\n- \[INFO\] Is the limit/)
  assert.match(plan.body, /## Recommendation\nREQUEST_CHANGES — the P1 unblocks it\.$/)
  assert.ok(!plan.body.includes('quantity is not validated')) // not said twice
  // Everything inline: no Findings section left in the body.
  const all = planReview(parseReview(REVIEW.replace(/- \[P2\][\s\S]*?per cart\?\n/, '')), diffLines(DIFF))
  assert.ok(!all.body.includes('## Findings'))
  assert.throws(() => planReview(parseReview('hello'), new Map()), /nothing to post/)
})

test('what an earlier round handled is one line in feedback.md, in full in feedback-history.md', () => {
  const c = (author, url, at = '2026-11-20T01:00:00Z') => ({ author, at, body: `${author} says something long enough to cut`, url })
  const pr = (threads, comments) => ({ url: 'https://github.com/o/r/pull/1', number: 1, state: 'OPEN', draft: false, decision: 'CHANGES_REQUESTED', branch: 'b', head: 'abc', headAt: 'x', waiting: [], reviews: [], threads, comments })
  const answered = { rid: 'R1', path: 'a.ts', line: 3, reviewer: 'hoa', replied: true, new: false, outdated: false, comments: [c('hoa', 'u1'), c('me', 'u2')] }
  const open = { rid: 'R2', path: 'b.ts', line: 9, reviewer: 'hoa', replied: false, new: false, outdated: false, comments: [c('hoa', 'u3')] }
  const fresh = { ...answered, rid: 'R3', new: true, comments: [c('hoa', 'u4'), c('me', 'u5'), c('hoa', 'u6')] }
  const p = pr([answered, open, fresh], [{ ...c('lan', 'u7'), new: false }])
  // First fetch: nothing was seen before — everything in full.
  const first = renderFeedback([p], 'now')
  assert.equal(first.folded, 0); assert.equal(first.history, '')
  // Next fetch, nothing new: R1 (we answered last) and the old comment fold; R2 (no answer yet) and R3 (new) stay.
  const again = renderFeedback([p], 'later', seenUrls([p]))
  assert.equal(again.folded, 2)
  assert.match(again.md, /- R1 \[replied\] · `a\.ts:3` · hoa — hoa says something .* → we answered, waiting for the reviewer \(full: feedback-history\.md\)/)
  assert.match(again.md, /#### R2 · `b\.ts:9` · hoa/)
  assert.match(again.md, /#### R3 \[new\] \[replied\]/)
  assert.match(again.md, /- \*\*lan\*\* .* \[handled\] — lan says/)
  assert.match(again.history, /## https:\/\/github\.com\/o\/r\/pull\/1 · R1 \[replied\][\s\S]*\*\*me\*\*/)
  assert.equal(render([p], 'later', seenUrls([p])), again.md)
})
