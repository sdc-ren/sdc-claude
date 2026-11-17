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

## What to look at

The reading follows Google's Engineering Practices, "What to look for in a code review"
(<https://google.github.io/eng-practices/review/reviewer/looking-for.html>). Read every changed line, and the
file and callers around it — never the diff alone.

| Area | Question |
|---|---|
| Design | Does the change belong here, and do its parts fit the code around them? |
| Functionality | Does it do what the ticket asks, for its users too: edge cases, concurrency, failure paths? |
| Complexity | Can a reader follow it quickly? Is anything built for a need that does not exist yet? |
| Tests | Are the tests the workspace policy asks for there, correct, and able to fail? |
| Naming, comments | Do names say what a thing is? Do comments explain why, not what? |
| Style, consistency | The repo's style guide first, then the code around the change. Style alone is never above `P3`. |
| Documentation | Did the way to build, test, configure or call it change without its docs? |
| Context | Is the codebase healthier after this PR, or only bigger? |

What was done well gets one line in the Summary when it is true; say which parts were not reviewed.

## Security

Every PR is read against the OWASP Top 10:2025 (<https://top10.owasp.org/2025/>). Check a row only where the
diff touches it; a finding names its row (`A01`) after the level.

| | Category | In a diff, look for |
|---|---|---|
| A01 | Broken Access Control | A new or changed route, query or action with no role/owner check; ids taken from the client and trusted; a check done only in the UI |
| A02 | Security Misconfiguration | Debug or verbose errors left on, open CORS, default accounts, permissive headers, a feature flag or env default that is unsafe |
| A03 | Software Supply Chain Failures | A new or bumped dependency (who maintains it, is it pinned, known advisories), a script fetched at build time, a changed lockfile with no reason |
| A04 | Cryptographic Failures | Secrets, tokens or personal data stored or sent in clear; home-made crypto, weak hashes for passwords, hard-coded keys, non-random tokens |
| A05 | Injection | Input concatenated into SQL, shell, paths, HTML, templates or regex; missing validation or escaping at the boundary |
| A06 | Insecure Design | A flow with no limit (rate, amount, retries), a business rule the client can skip, trust placed in the wrong side |
| A07 | Authentication Failures | Login, session, token, password-reset or OTP code: expiry, rotation, brute force, tokens in URLs or logs |
| A08 | Software or Data Integrity Failures | Deserializing untrusted data, unsigned updates or webhooks, a migration or import that trusts its input |
| A09 | Security Logging and Alerting Failures | A sensitive action with no audit trail; secrets or personal data written to logs; errors swallowed silently |
| A10 | Mishandling of Exceptional Conditions | An error path that leaves state half-written, fails open, leaks internals, or is not handled at all |

Money, migrations and transactions are checked wherever the PR touches them, whatever the row.

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
- A review that did not run the app says so in the Summary (`Not run on the app`) and judges the code only.
- No findings → say so.
- Every finding is one `- [P1] \`path/file.ts:42\` — …` bullet (a security one: `- [P1] A01 \`path…\``): level, then the location in backticks (path
  from the repo root, the line in the PR's new code), then issue, impact and fix in 1–3 sentences. Posting
  (`pr-feedback.mjs review`) turns each one into an inline comment on that line and sends them with the
  Summary and Recommendation as ONE review, so the author gets one notification. A finding on a line the diff
  does not show stays in the review body.
- Several PRs in one task: one file per PR, `pr-comment-<repo>.md`.
- The recommendation is text only (the review is posted as a plain comment review): never `gh pr review --approve/--request-changes`, merge, or
  post anything unless the user asks. Never edit the PR's code. No agent attribution.

## Sources

- Reading order and areas: Google Engineering Practices, code review guide (link above).
- Security rows: OWASP Top 10:2025 (link above). For a deeper check of one row, the matching chapter of the
  OWASP Application Security Verification Standard.
- Levels `P0`–`P3` and the merge rules are this team's own convention, not an outside standard.
- A repo's own conventions and the workspace review lessons come before this file.
