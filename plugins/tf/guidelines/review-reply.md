# Review reply

For the reviewers: what happened to each point they raised, readable without opening the diff.

One review round = one answer per PR. Wait until the team has finished commenting, then answer everything
at once: inline threads are answered in place, everything else in one summary. Both go out as a single
submitted review, so each reviewer gets one notification and the conversation gains one entry, not a chain.

## Draft file

`<task>/feedback-replies.md`, one `##` block per PR that needs an answer:

```markdown
## https://github.com/org/api/pull/665

### Summary
## Review reply · abc1234

**@reviewer-login**
| # | Point | Result |
|---|---|---|
| 1 | Quantity is not validated | Fixed — abc1234 |
| 2 | Rename `qty` to `quantity` | Not changed — the App reads `qty` (SCRUM-132); renaming belongs to a contract ticket |

**@nguyenvana**
| # | Point | Result |
|---|---|---|
| 1 | Is the price cached? | Answered — no, it is read per request (`cart.service.ts:88`) |

Inline: 6 threads answered in place — 5 fixed, 1 to discuss (R4).
Tested: checkout flow re-run on abc1234, PASS.

### R3 · resolve: yes
Fixed in abc1234 — the limit is now checked before the insert.

### R4 · resolve: no
Not changed: the workspace test policy forbids new unit tests here; the checkout flow covers this branch.
```

Only `## <PR url>`, `### Summary` and `### R<n> · resolve: yes|no` are structure; the text under them is
posted as written.

## Rules

- **Inline thread → reply in that thread**, 1–3 sentences. `Fixed` names the commit sha and what changed;
  `Not changed` gives the concrete reason (ticket, decision, spec, code); a question gets its answer.
  `resolve: yes` only for a fix; a disagreement or an answer stays open — the reviewer closes it.
- **Reviews and conversation comments → the Summary**, never one comment per reviewer. One section per
  reviewer, `@login` once as the section title, one row per point in the order they wrote them, the point
  restated in a few words (no long quotes). The same point from two reviewers: answer it under the first,
  the second row says `Same as @login #n`.
- The Summary ends with one line counting the inline threads by result, and one line for what was re-tested
  when code changed. A PR with only inline threads still gets these two lines. Drop the Summary only when
  there is exactly one thread and nothing else.
- Result words: `Fixed` · `Not changed` · `Answered` · `Out of scope` (name the ticket). No "will do later"
  without a ticket.
- A push to an approved PR: the Summary's first line says why and asks for a re-review.
- A new round is a new review, not an edit of the last one — an edit notifies nobody. Its heading carries the
  new commit sha; it answers only what is new since the last round.
- Reviewers still asked and not done (`waiting` in the fetch summary): do not answer yet unless the user says
  so.
- Polite and concrete; thank nobody per row. Never invent a commit, a test result or a decision.
- The draft is shown to the user and posted only after approval, with one `pr-feedback.mjs post`. A single
  late reply after the round went out: `reply` / `comment`.
- The heading stays English; content follows the writing language. No agent attribution.
