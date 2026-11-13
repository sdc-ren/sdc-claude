<div align="center">

# tf — task-flow

**A PM-led agent team for Claude Code: plan the ticket, build it, test it end to end, ship a ready PR.**

[![Version](https://img.shields.io/badge/version-1.1.0-2ea44f)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-d97757)](https://code.claude.com/docs/en/plugins/install.md)

`/tf:build` · `/tf:qc` · `/tf:review` · `/tf:e2e`

</div>

---

## Why tf

Running a ticket through one long agent session is slow and hard to trust: the same agent writes and judges
the code, tests are re-driven by hand every round, and a QC report three days later means re-reading
everything. **tf** organises the work like a small team:

- **A PM agent decides.** It reads the ticket, writes a micro-task plan, sizes the task, and chooses which
  agents run, in what order, on which model. Small tasks get one dev and one tester; big ones get parallel
  devs per repo and a stricter review.
- **Hard rules live in code, not prompts.** No PR before the tester passes the latest code. No PR before a
  review gate. Writer ≠ judge. PRs are always ready. Caps stop loops that do not converge.
- **E2E flows are kept.** Every case becomes a re-runnable script. A QC round re-runs the flows in minutes
  instead of clicking through the UI again.
- **One card per ticket.** `HANDOFF.md` (≤ 80 lines) is all a later round needs to start, even days later.
- **One folder per ticket.** `.pipeline/<TICKET>/` and `.worktrees/<TICKET>/<repo>/` are reused across
  every mode and round — no `-e2e`, `-fix`, `-r2` copies.

## Contents

- [Quick start](#quick-start)
- [Commands](#commands)
- [How it works](#how-it-works)
- [Workspace configuration](#workspace-configuration)
- [Files tf creates](#files-tf-creates)
- [E2E flows](#e2e-flows)
- [Requirements](#requirements)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

## Quick start

```
/plugin marketplace add sdc-ren/sdc-claude
/plugin install tf@sdc
```

Then, in your workspace (the folder that holds your repos):

```
/tf:doctor            # checks tools, gh login, config, repos, Playwright, devices
/tf:build PROJ-123    # first run offers to create .claude/task-flow.md if it is missing
```

## Commands

| Command | What it does | Ends with |
|---|---|---|
| `/tf:build <ticket\|text> [--approve] [--draft]` | New task end to end | Ready PR per changed repo, e2e evidence, ticket-comment draft |
| `/tf:qc <ticket>` | Answer a QC report or human PR review points: next round on the same branches and flows | Existing PR updated (or a new one if the old PR was merged), QC reply draft |
| `/tf:review <PR url\|ticket>` | Review a teammate's PR: e2e of the ticket's acceptance criteria + risk report | `review.md`, PR-comment and ticket-comment drafts — nothing posted |
| `/tf:e2e <PR url\|ticket> [--cases 21,22]` | E2E only, no code changes | Evidence + ticket-comment draft |
| `/tf:attach [ticket] [keyword] [--setup]` | Pick artifacts / design systems for a task from a checkbox list — only this workspace's | Saved to `specs/`, used by PM, devs, testers |
| `/tf:doctor` | Check this machine and workspace | Pass/fail table with fixes |
| `/tf:status` | What every task holds (worktrees, DBs, ports, PRs) | Table + what the reaper would free |
| `/tf:cleanup <slug>` | Free one task's resources (asks first) | Resources released, folder archived |
| `/tf:migrate` | Move old flat worktrees into `.worktrees/<TICKET>/<repo>/` | Moves + ledgers rewritten (asks first) |
| `/tf:legacy` | Fold old suffixed folders (`-e2e`, `-qc`, `-r2`…) into one folder per ticket | Dry run, then apply on your yes |
| `/tf:regression [--target local\|dev]` | Run flows promoted from merged tickets | PASS/FAIL per case |

**Flags** — `--attach`: pick this workspace's artifacts / design system for the task · `--approve`: stop after the first plan for your approval · `--draft`: allow a draft PR (agents
never choose draft on their own) · `--lang <code>`: report language for this run.

Nothing is ever posted to the tracker or GitHub as a comment without your approval of the exact text.
tf never merges, approves, force-pushes, or enables auto-merge.

## How it works

```mermaid
flowchart LR
    U([You]) -->|/tf:build PROJ-123| O[Session<br/>orchestrator]
    O -->|resolve ticket, lock,<br/>read HANDOFF + new comments| W[Workflow<br/>executor]
    W <-->|dispatch / reports| PM{{tf:pm}}
    W --> D1[tf:dev · be]
    W --> D2[tf:dev · fe]
    W --> T[tf:tester]
    W --> R[tf:reviewer]
    R -->|ready PR| GH[(GitHub)]
    T -->|flows + evidence| F[(.pipeline/TICKET)]
    PM -->|HANDOFF, plan, board| F
    O -->|drafts for your approval| U
```

1. **Pre-flight (your session).** `task.mjs resolve` maps the input (ticket key, PR URL, or text) to exactly one
   folder, finds existing worktrees and PRs, and takes a lock. The ticket is saved verbatim; on later rounds
   only new or edited comments and human PR review comments are marked.
2. **PM turn.** `tf:pm` reads `HANDOFF.md` / the ticket, inspects every repo the workspace lists, writes
   `plan.md` (micro-tasks: what + exact file, *how* only at contracts), and returns a dispatch: jobs, roles,
   models, parallel groups.
3. **Jobs.** The executor runs the dispatch — e.g. group 1: `tf:dev` for each repo in parallel; group 2:
   `tf:tester` ∥ `tf:reviewer` (gate). If a job fails, later groups are skipped and the PM re-plans.
4. **Repeat** until the PM closes: fix rounds send only the open issue ids to the dev, and the tester re-runs
   only the failing flows. After a PASS and a clean gate, a `PACKAGE` reviewer job commits, pushes and opens
   the ready PR.
5. **Close-out (your session).** Evidence is uploaded per the workspace config, drafts are shown to you,
   `HANDOFF.md` is rewritten for the next round.

### Hard rules (enforced by the executor)

| Rule | Why |
|---|---|
| Code modes close only when every tester after the last dev job passed, for every changed repo | No "green on one repo, red on the other" |
| A PR must come from a reviewer `PACKAGE` job that started after that PASS | Nothing ships untested |
| PRs are ready; draft only with `--draft` | A PR means "done and verified" |
| Dev and judge are separate agents, never in the same parallel group | Writer ≠ judge |
| Roles allowed per mode (`review` / `e2e` never run a dev) | Review modes never change code |
| ≤ 10 PM turns, ≤ 6 jobs per dispatch, ≤ 4 dev jobs per repo | Non-converging loops escalate to you |

### When the PM stops to ask you

Only for: broken layout or UI clearly unlike the design; a flow totally different from before or a spec
change the ticket does not settle; risk to money, permissions, data or security; an edit inside a
read-only zone; a blocker no job can remove — plus whatever your workspace config adds. Everything else
is decided and listed as *assumptions* in the round report so you can correct it.

### Sizing

| Size | Example | Typical team | Model |
|---|---|---|---|
| XS | text, colour, spacing | 1 dev → tester ∥ reviewer → package | sonnet; PM on sonnet after turn 1 |
| S | a field, one screen | same, tester writes 1 flow | sonnet |
| M | 2 repos or an API change | parallel devs → testers ∥ reviewer | sonnet, opus where risky |
| L | new feature, migration, money, permissions | M + opus on risky jobs | opus where it matters |

## Workspace configuration

tf reads `<workspace>/.claude/task-flow.md`. Start from [docs/config-template.md](docs/config-template.md).

```md
## Language
- Report language: `vi`        # what tf tells you, .pipeline files
- Writing language: `vi`       # commits, PR bodies, reviews, ticket comments (PR titles stay English)

## Repos (the PM inspects every one and picks what the task touches)
| key | path | base branch | package manager | lockfile → reusable dirs | conventions to read |
|---|---|---|---|---|---|
| be | `backend/`  | `develop` | npm  | `package-lock.json` → `node_modules` | `backend/CLAUDE.md` |
| fe | `frontend/` | `develop` | pnpm | `pnpm-lock.yaml` → `node_modules`    | `frontend/CLAUDE.md` |

## Excluded (never inspected, never changed)
- `autotest/`

## Read-only zones (read and call, never edit — an edit needed here → the PM asks you)
- `payments-core/`, `backend/src/blockchain/**`

## Test policy
- e2e-only — no new unit/DB tests; cover reviewer-expected tests with e2e/API flows and say so in the PR.

## Flows (e2e)
- Playwright package: `<root>/autotest/package.json`
- Targets: `local` = the task's ports; `dev` = https://dev.example.com
- Web viewport: 1440x900. Android: AVD `my_avd`. iOS: out of scope.

## Provisioning · Doctor · Hard rules · Close-out
…
```

Other sections: tracker and spec sources, knowledge files (known bugs, env recipes, decisions,
**review lessons** — rules learned from human reviews that devs and reviewers check before every job),
provisioning recipes (worktree, DB, cache, ports), doctor checks, and close-out (where evidence goes, how
approved comments are posted).

## Files tf creates

```
<workspace>/
  .pipeline/PROJ-123/
    ticket.md          verbatim ticket (+ PR review comments on later rounds)
    HANDOFF.md         ≤ 80-line card — the first thing every later round reads
    plan.md            current round's micro-tasks and API contract
    board.md           the PM's ledger: jobs, results, assumptions, open issues
    journal.md         append-only log, 1–3 lines per job
    jobs/J<n>-<role>-<repo>.md   each job's brief and report
    flows/*.mjs, flows.json      re-runnable e2e cases
    evd/               WebP screenshots, verdicts
    history/r<N>/      earlier rounds
    resources.json     everything the task holds, with the command that frees it
  .worktrees/PROJ-123/
    backend/  frontend/  mobile/     one git worktree per repo the task touches
  .pipeline/_regression/             passing flows of merged tickets
```

`~/.claude/task-flow/` keeps machine-level state: saved tracker logins (`auth/`) and the reaper copy.

**Cleanup.** The optional reaper (`sh <plugin>/scripts/install-reaper.sh`, macOS launchd, every 30 min)
frees resources when all PRs of a task are merged or closed and promotes its passing flows to
`_regression/`. Tasks idle more than `TF_PRUNE_DAYS` (7) days are freed; archives are slimmed after 7 days
and deleted after `TF_ARCHIVE_DAYS` (30). Worktrees with uncommitted or unpushed work are never removed.

## E2E flows

One file per case, re-run instead of re-driven. Standard: [guidelines/e2e-testing.md](guidelines/e2e-testing.md).

```js
// .pipeline/PROJ-123/flows/21.mjs
const { webFlow } = await import(process.env.FLOW_KIT)
await webFlow('21', async ({ page, step, shot, gotoReady, expect, uniq }) => {
  await step('open import', () => gotoReady('/organizer/import', 'text=Athlete code', '/api/imports'))
  await shot('after')
  expect(await page.getByText('Athlete code').isVisible(), 'column visible')
})
```

```bash
node <plugin>/scripts/flow-run.mjs .pipeline/PROJ-123 --target local          # all cases
node <plugin>/scripts/flow-run.mjs .pipeline/PROJ-123 --failed                # only what failed last time
node <plugin>/scripts/flow-run.mjs .pipeline/PROJ-123 --cases 21 --target dev # reproduce a QC report
```

- Waits for the app, not the clock: `waitApi`, `ready`, `gotoReady`; a 15 s ceiling per step, never a delay.
- Evidence: `<case>-after.webp` (+ `before` for visual changes), failure screenshot automatically,
  Playwright trace only with `TRACE=1`.
- Console errors and HTTP 5xx are reported with the verdict even when the case passes.
- Android: `androidFlow` drives the task's own emulator with adb (Flutter `Semantics(identifier:)` →
  `resource-id`).

## Requirements

| Need | Notes |
|---|---|
| Claude Code with Workflows enabled | Paid plan or API; allow the Workflow tool when asked |
| Node ≥ 20, git, `gh` logged in | `gh auth login` + `gh auth setup-git` for private repos |
| Playwright | Any package that depends on `@playwright/test`, referenced in the config |
| Per workspace | Whatever the config's provisioning needs: Docker DBs, Android SDK + AVD, Flutter… |
| macOS (recommended) | `cp -c` (APFS clone) for fast dependency copies, launchd for the reaper, Chrome cookie import for tracker login. Elsewhere tf falls back to normal copies and manual cleanup. |

Run `/tf:doctor` to see what is missing.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `lock-conflict` / "another run holds it" | A run is active, or one crashed less than 90 min ago. Check `/workflows`; remove `.pipeline/<slug>/.lock` only when nothing runs. |
| PM escalates "rejected twice by the hard rules" | Read the rule in the message; usually a judge was put in the same group as a dev, or a PR was a draft. |
| Tester says `blocked-env` | The environment is missing something (DB, port, emulator, login). `/tf:doctor`, then fix the config's provisioning. |
| Flow fails after an intended UI change | The tester marks it `flow-broken`, fixes the selector and re-runs — not an app bug. |
| Old `-e2e` / `-qc` folders or flat worktrees | `/tf:legacy`, `/tf:migrate`. |
| Plugin update not picked up | `claude plugin marketplace update sdc && claude plugin update tf@sdc`, then restart. Re-run `install-reaper.sh` after updates. |

## FAQ

**Does tf write unit tests?** Only if your workspace `Test policy` allows them. Verification is e2e flows
with evidence; typecheck, lint and build run as cheap checks.

**Can I use it in any repository layout?** Yes — a workspace is any folder whose config lists one or more
git repos. A single-repo project lists just one.

**Where do the rules come from?** `guidelines/` in this plugin (git, PR description, PR review, ticket
comment, e2e). A repo's own conventions (its CLAUDE.md, CONTRIBUTING, commitlint) win.

**What does it cost?** Fewer agents than a fixed pipeline: XS tasks typically run 3–5 agents. The PM uses
opus for planning and drops to sonnet for small tasks after the first turn.

## Design

The full design — roles, dispatch schema, guards, file formats, retention — is in
[docs/design.md](docs/design.md). The orchestrator procedure the commands follow is in
[docs/orchestrator.md](docs/orchestrator.md).

## License

[MIT](LICENSE) © 2026 SDC (Dang Chi Son)
