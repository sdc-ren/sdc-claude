// Answering a review round: one draft file → one submitted review per PR.
// Run: node --test tests/feedback.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseReplies, planRound, postRound, render, summarize } from '../scripts/pr-feedback.mjs'

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
