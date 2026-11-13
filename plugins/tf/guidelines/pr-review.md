# PR review

Find real defects and merge risks, not style preferences. Few confident findings beat many guesses.

Check, in order, only what the change touches: correctness (edge cases, async, races) → security
(authz, validation, injection, secrets) → reliability (failure paths, cleanup) → compatibility
(API contracts and every client using them, migrations) → architecture → performance →
maintainability → tests for the changed behavior → conventions.

| Level | Meaning | Merge |
|---|---|---|
| `P0` | Security hole, data loss, wrong money, system down | Block |
| `P1` | Broken main flow, regression, broken contract, irreversible migration | Block |
| `P2` | Defect under specific conditions, missing error handling or tests | Should fix |
| `P3` | Minor improvement | Optional |
| `INFO` | Question, not a defect | — |

## A finding counts only if

- It has `file:line` and a concrete scenario (which input/state → which wrong result).
- This PR introduced or worsened it. Failures already on the base branch are named as pre-existing.
- It is backed by code read at the location or a command actually run. The PR description and the
  author's "tested X" are claims to verify, not evidence. Unsure → omit or mark `INFO`.
- One root cause = one finding.

## Output

```markdown
## Summary
1–3 sentences: verdict basis and what was run.

## Findings
- [P1] `path/file.ts:42` — what breaks, when, suggested fix

## Recommendation
APPROVE | REQUEST_CHANGES | COMMENT — and what unblocks it
```

- `REQUEST_CHANGES`: any P0/P1, a P2 regression from this PR, checks broken by this PR, or a contract
  change whose clients are not ready (say the block is coordination, not code).
- `COMMENT`: non-blocking, or a decision above the reviewer (name who decides what).
- Vietnamese: Nên merge (APPROVE) · Chưa nên merge (REQUEST_CHANGES) · Cần bàn thêm (COMMENT).
- No findings → say so. Inline comments: `[P1] title`, then issue, impact, fix in 1–3 sentences.
- The recommendation is text only: never `gh pr review --approve/--request-changes`, merge, or
  post anything unless the user asks. Never edit the PR's code. No agent attribution.
