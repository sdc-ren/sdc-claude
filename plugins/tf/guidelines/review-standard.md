# Review standard

One standard for both sides of a PR: the PM's plan, the dev's self-check and the gate check before the PR
what a human reviewer checks after. Three layers, the narrower winning on conventions; none lowers a P0/P1 class
or an OWASP row:
- **Global** — this file and [pr-review.md](pr-review.md) (reading order, OWASP, levels P0–P3).
- **Team** — config `## Team agreements` and the repo's `CLAUDE.md`: only what the human reviewers agreed to.
- **Project** — the config's `Review lessons` file, each lesson tagged with its category (`[M4]`).

## Miss categories (what reviewers keep finding)

Each applies only when the change touches it.

| | Category | Check before the PR | Evidence |
|---|---|---|---|
| M1 | Client parity | For each validator, error key, field and enum the BE adds or changes, every client (Web, App, admin) matches: error keys in each client's locales; limits and formats equal the validator; nullable fields typed and rendered safely; enums shown through a label map; every shape the BE accepts or requires sendable (all rows, all blocks, empty) | item · BE `file:line` · each client `file:line` |
| M2 | Modes and choices | A field or control the BE rejects in a mode (walkover, draft, sport, format) or with another choice is locked in the UI and left out of the payload, on the create and the edit page | case per mode, both orders |
| M3 | Roles | Every role that opens the screen or calls the route gets the endpoint it passes and the data it may see; a 403 never ends in an empty block | role → endpoint → case |
| M4 | Lifecycle and existing data | Changed after confirm/lock; off then on; parent deleted with dependents (FK `CASCADE`); rows written before the change (legacy, migrated, `NULL`); repeated across versions; migration `down` then `up` | a "go back" case; per item: recompute / blocked / not possible — why |
| M5 | Shared code | Other users of a changed function, helper, component or query behave as on the base | gate `Impact` → cases |
| M6 | Limits and cuts | At the limit, just past it, zero, empty; a top-N cut keeps rows tied with the last kept one | cases |
| M7 | Checks on the base | Existing suites on branch and base; each red one `broken by this change` or `pre-existing` | both results |
| M8 | Scope against approval | No behaviour, permission or lock bypass beyond what the ticket or PO approved in writing | the quoted approval, or an assumption asked |
| M9 | Hygiene | Comments, docs, API docs and the PR body describe the new behaviour; no dead exports | — (P3) |

## Security categories (what reviewers rarely look for)

From OWASP Top 10:2025, ASVS, CWE Top 25 and NIST SSDF — code written by AI is checked as code nobody has read.

| | Category | Check before the PR | OWASP |
|---|---|---|---|
| S1 | Access control | Role and ownership checked on the server for every new or changed route, query and action; client ids never trusted alone; no lock, state check or permission skipped without written approval (M8) | A01, A06 |
| S2 | Audit trail | A sensitive action (money, permissions, lock/unlock, approve, delete, settings) records who, when, before, after, and the reason when asked; audit rows survive cascades and cannot be edited through the API | A09 |
| S3 | Logs and errors | No secret, token, OTP, password, cookie or personal data in logs, errors or responses; no silent catch; errors fail closed and leave no half-written state | A09, A10 |
| S4 | Input and injection | Validation at the boundary; no input joined into SQL, shell, paths, HTML or regex; size and rate limits on repeatable calls | A05, A06 |
| S5 | Secrets and configuration | No key or password in code, fixtures or docs; safe defaults; no debug output left on; CORS and headers no wider than before | A02, A04 |
| S6 | Dependencies | A new or bumped package exists under that exact name (AI invents look-alikes), is maintained, pinned, and free of high/critical advisories | A03, A08 |
| S7 | Data integrity | Money and multi-row writes in one transaction; migrations with a safe `down`; imports and webhooks verify what they trust; no hand-made auth or crypto | A04, A07, A08 |

**Scan first.** `node ${CLAUDE_PLUGIN_ROOT}/scripts/security-scan.mjs <worktree> --base origin/<base> --out <task>/logs/<job>-security.json`
prints a short summary: secrets and sensitive log values, `gitleaks` and `semgrep` results and new
dependencies — only on lines the change added (results elsewhere are listed as pre-existing, never the change's).
A scanner listed `not installed` or `failed` did not run; it is never a pass.

**Security-sensitive** (auth, roles, permissions, locks, money, audit, migrations): the PM marks the jobs
`sensitive`, the gate runs on opus, the plan has refused-role and audit-row cases, and the PR body a `## Security`
section.

## Self-check (in the dev report; the lead writes one per job)

```markdown
## Self-check
| | applies | evidence |
|---|---|---|
| M1 | yes | errors.team_* 14 keys: be messages.ts:40 · fe vi/en.json · app server_messages_vi.dart |
| M4 | yes | lock then edit → 409 (C9) · off → on keeps data (C10) · legacy NULL (C11) |
| M2, M6 | no | no mode-dependent field, no numeric rule |
| S1, S2 | yes | owner check config.service:436, referee → 403 (C7) · audit before/after config.service:459 |
| S3–S7 | scan | 0 findings · gitleaks, semgrep ran · no new dependency |
```

`no` needs its reason. The gate checks every `yes` against the diff and cases and every `no` against the diff:
an M row that applies and is missing or wrong is P2. Missing S rows the gate fills from its own scan.
