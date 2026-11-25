# Review standard

One standard for both sides of a PR. The author's side — the PM's plan, the dev's self-check, the gate — checks
before the PR exists what a human reviewer checks after. A point a reviewer can raise that no check here
would have caught is a gap in this file or in the workspace lessons, not bad luck.

## Three layers

| Layer | Where | Who sets it | Holds |
|---|---|---|---|
| Global | this file and [pr-review.md](pr-review.md) | the plugin | reading order (Google), security (OWASP), levels P0–P3, the miss categories below |
| Team | config `## Team agreements`, the repo's `CLAUDE.md` | the team, agreed with its human reviewers | test policy, env keys, merge order, PR title, who approves what |
| Project | config `Review lessons` file | learned from this workspace's reviews | rules tied to the domain, each tagged with its category (`[M4]`) |

A narrower layer wins on conventions (a repo's commit style beats the plugin's). No layer lowers a P0/P1 class
or an OWASP row. A team agreement the reviewers have not agreed to is not one yet: while a reviewer keeps
asking against it, the PM says so in the close report instead of answering `discuss` round after round.

## Miss categories

What human reviewers keep finding that a diff-only reading misses. Each applies only when the change touches it.

| | Category | The check before the PR | Evidence |
|---|---|---|---|
| M1 | **Client parity** — one contract, every client | For each validator, error key, field and enum the BE adds or changes, every client (Web, App, admin) matches it: error keys exist in each client's locales (vi and en); lengths, ranges, formats equal the validator; a nullable/optional field is typed so and rendered without a crash; an enum is shown through a label map, never raw; the client can send every shape the BE accepts or requires (all rows, all blocks, the empty case) | parity table: item · BE `file:line` · each client `file:line` or `n/a — why` |
| M2 | **Modes and choices** | A field, flag or control the BE rejects in a mode (walkover, draft, another sport, another format) or together with another choice is locked in the UI and left out of the payload — on the create page and on the edit page | case id per mode, both orders (choose then switch, switch then choose) |
| M3 | **Roles** | Every role that can open the screen or call the route (owner, staff, referee, viewer, admin, guest) gets the endpoint it passes and the data it may see; a 403 never ends in an empty block; a check done only in the UI is a finding (OWASP A01) | role → endpoint → case id |
| M4 | **Lifecycle and existing data** | For each value the feature depends on: change it after it was confirmed, locked or generated; turn the feature off then on; delete a parent that has dependents (FK `CASCADE`); run on rows written before this PR (legacy, migrated, `NULL`); repeat the action across versions or snapshots; migration `down` then `up` | one "go back" case at least, and a line per item above: recompute / blocked with a reason / not possible — why |
| M5 | **Shared code** | Every other user of a function, helper, component, query or constant the diff changes behaves as on the base | gate `Impact` list → case ids |
| M6 | **Limits and cuts** | A number or order in a rule: at the limit, just past it, zero, empty; a top-N cut keeps every row tied with the last kept one, in every view of the same ranking | case ids |
| M7 | **Checks on the base** | The repo's existing suites run on the branch and on the base; each red one is `broken by this change` (fixed) or `pre-existing` with the base result | the two results |
| M8 | **Scope against approval** | No behaviour, permission or bypass of a lock beyond what the ticket or the PO approved in writing; a new path that skips an existing check names the approval it rests on | the quoted approval, or the item moved to `## Assumptions` and asked |
| M9 | **Hygiene** | Comments, docs, API docs and the PR body describe the new behaviour; no dead exports left by the change | — (P3) |

M1–M4 and M8 caused almost every P1/P2 in the review rounds this file was built from; M5–M7 already have their
own checks in the gate.

## Security categories

The miss categories come from what reviewers caught; security is what they rarely look for. When AI writes the
code, it has to be checked as code nobody has read: these rows come from the OWASP Top 10, ASVS and CWE, not from
past reviews, and each one names the OWASP rows of [pr-review.md](pr-review.md) it stands for.

| | Category | The check before the PR | OWASP |
|---|---|---|---|
| S1 | **Access control** | Every new or changed route, query and action checks role and ownership on the server; ids from the client are never trusted on their own; no path skips an existing lock, state check or permission unless the ticket or PO approved it in writing (M8) | A01, A06 |
| S2 | **Audit trail** | A sensitive action (money, permissions, lock/unlock, approve, delete, settings) records who, when, what, before and after, and the reason when one is asked; audit rows are never removed by a cascade or editable through the API | A09 |
| S3 | **Logs and errors** | No secret, token, OTP, password, cookie or personal data in logs, errors or responses; no error swallowed in silence; an error path fails closed and leaves no half-written state; logs carry enough to trace (actor, request id) | A09, A10, A02 |
| S4 | **Input and injection** | Validation at the boundary (type, length, range, format) before use; no input joined into SQL, shell, paths, HTML or regex; size and rate limits on anything a client can repeat | A05, A06 |
| S5 | **Secrets and configuration** | No key, token or password in code, fixtures or docs; safe defaults (feature off, closed, least privilege); no debug or verbose errors left on; CORS and headers no wider than before | A02, A04 |
| S6 | **Dependencies** | Every new or bumped package exists under that exact name (AI invents look-alike names), is maintained, pinned in the lockfile, and has no known high/critical advisory; no script fetched at build time | A03, A08 |
| S7 | **Data integrity** | Money and multi-row writes run in one transaction; migrations have a safe `down`; imports and webhooks verify what they trust; no auth or crypto written by hand | A04, A07, A08 |

**Scans first, judgement second.** The gate runs `scripts/security-scan.mjs` on the diff: built-in patterns
for secrets and sensitive values in log calls, the list of new dependencies, and the scanners the machine has
(`gitleaks`, `semgrep` with its recommended ruleset (OWASP rules included), `npm audit` when a lockfile changed). A model reading code it did
not write is the second line, not the first. A scanner that is not installed is named in the report, never
counted as a pass.

**Security-sensitive changes.** A change that touches S1, S2 or S7 areas (auth, roles, permissions, locks, money,
audit, migrations — the scan lists them as `sensitive`) is planned as risky: the PM marks its jobs `sensitive` and its gate runs on opus (the dev keeps its own model), every S row gets a case or a `file:line`, and the PR body has a `## Security` section naming the
sensitive parts, so the human reviewer knows where to look hardest.

## Self-check (author side)

The dev report (the lead's one report on a team job) carries a `## Self-check` table for the categories the
change touches:

```markdown
## Self-check
| M | applies | evidence |
|---|---|---|
| M1 | yes | errors.team_* 14 keys: be messages.ts:40-62 · fe vi/en.json ✓ · app server_messages_vi.dart ✓ |
| M3 | yes | owner → /org/overview (C4) · referee, viewer → /overview (C5, C6) |
| M4 | yes | lock then edit → 409 (C9) · off → on keeps counted (C10) · legacy NULL doc (C11) |
| M2, M6 | no | no mode-dependent field, no numeric rule |
| S1 | yes | PUT /groups/:id/config: assertLockOverride for owner (config.service:436) · referee → 403 (C7) |
| S2 | yes | approve/unfinalize audit with before/after (config.service:459) · FK RESTRICT on award_records |
| S3–S7 | scan | security-scan: 0 findings · gitleaks ran · semgrep not installed · no new dependency |
```

`no` needs its reason. S rows are filled for every change that touches code (`scan` = the scan's result
covers it). The dev fills what its repo shows and reads the other repos (read-only) or the plan's
`## Contract` for the other side of M1; cases it cannot run yet are named for the tester. The gate checks
every `yes` row against the diff and the cases, and every `no` row against the diff: a row that applies and is
missing or wrong is P2.

## Keeping it current

- After a review round, every P0–P2 point gets a category. A point that fits none is a new category candidate:
  the close report proposes the row for this file.
- A project lesson seen in 3 tickets, or in 2 workspaces, becomes a check under its category here (proposed in
  the close report — the plugin file is changed by a person, not by a run).
- A category nobody has hit in a long time stays: it is cheap to check and expensive to forget.

## Sources

- Reading order and areas: Google Engineering Practices, "What to look for in a code review"
  (<https://google.github.io/eng-practices/review/reviewer/looking-for.html>).
- Security: OWASP Top 10:2025 (<https://top10.owasp.org/2025/>); OWASP ASVS for the depth of one area
  (<https://owasp.org/www-project-application-security-verification-standard/>); CWE Top 25
  (<https://cwe.mitre.org/top25/>); NIST SSDF SP 800-218 for the practice of checking every change before it
  ships (<https://csrc.nist.gov/pubs/sp/800/218/final>); OWASP Top 10 for LLM Applications when the product
  itself calls a model (<https://genai.owasp.org/llm-top-10/>).
- Miss categories: about 90 human review points over 9 tickets of one workspace (web, backend and app PRs,
  November 2026), grouped by root cause. They are a starting set, not a closed list.
