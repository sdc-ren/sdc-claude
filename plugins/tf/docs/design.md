# task-flow — design

The SDC `tf` plugin (`tf@sdc`): a PM agent plans each task and staffs dev / tester / reviewer agents; a thin
executor runs the jobs and enforces the hard rules.

This file is the reference for **why and how the pieces fit**. What each agent must do is in its own file
and is not repeated here: `agents/*.md` (roles), `docs/orchestrator.md` (what a `/tf:*` command does in the
session), `docs/pm-feedback.md` (feedback mode), `guidelines/` (git, PR, review, ticket comment, e2e). How
to use the plugin is in `README.md`.

## Shape

```
session (orchestrator, has Bash)            Workflow (thin executor, no fs)
  task.mjs resolve / lock / new-round   →     loop:
  ticket.md (new comments only)                 PM  → dispatch {jobs[], groups, models}
  gh PR state                                   run jobs (parallel inside a group)
                                                guard hard rules
                                                reports → PM … until close | escalate
  task.mjs unlock, EVD upload, comment draft ←
```

The PM is stateless between turns: it re-reads `board.md` (its own ledger) and the job reports it
names. That makes resume free — relaunch, the PM reads the board and continues.

## Roles (`agents/*.md` → `tf:pm`, `tf:lead`, `tf:dev`, `tf:tester`, `tf:reviewer`)

| Role | Owns | Never |
|---|---|---|
| `tf:pm` | plan, board, HANDOFF, ticket-comment draft; picks jobs, roles, models, size | edits repo code, runs tests |
| `tf:lead` | one repo's dev job: does it alone, or splits it among ≤ 3 members (disjoint files, agreed interfaces), merges, makes the repo build, one report to the PM | commits, judges its own work |
| `tf:dev` | member of a lead's team: its own files and micro-tasks; reports to the lead | commits, edits another member's files |
| `tf:tester` | e2e flows (`flows/`), evidence, verdicts | edits repo code |
| `tf:reviewer` | plan check; static gate (scope, contract, quality, tamper, read-only zones); commit + push + PR; review-mode report | edits code, merges |
| `setup` | provisioning per workspace config (generic agent, sonnet) | touches other tasks' resources |

The roster is a menu. The PM uses the fewest roles that satisfy the hard rules.

## Modes

| Command | Mode | Allowed roles | Ends with |
|---|---|---|---|
| `/tf:build <ticket\|text>` | build | setup, dev, tester, reviewer | PR(s) ready |
| `/tf:qc <ticket>` | qc | setup, dev, tester, reviewer | existing PR updated (or new PR if merged) |
| `/tf:address-review <ticket\|PR> [--check]` | feedback | setup, dev, tester, reviewer (none with `--check`) | triage, fixes pushed to the same PR, reply drafts |
| `/tf:review <PR\|ticket>` | review | setup, tester, reviewer | review report + PR/ticket comment drafts |
| `/tf:e2e <PR\|ticket> [--cases a,b]` | e2e | setup, tester | evidence + ticket comment draft |

There is no `--repos`: the PM inspects every repo the workspace config lists. Flags are in the README.

## Hard rules

Enforced by the executor (`engine/task-flow.js`), not by prompts; covered by `tests/engine.mjs`. The PM gets
them in its prompt on turn 1 and after a rejection, generated from the same constants the guards use.

**Who may run, and with whom**
1. A role outside the mode's allowed set is rejected.
2. Writer ≠ judge: a tester or reviewer never shares a group with a dev job on its repo. The one exception is
   a tester job whose brief starts with `FLOWS`: it only writes flows from the plan while the dev works,
   returns verdict NONE, never counts as a test and never blocks later groups.
3. One dev job per repo per group. It goes to the repo's lead, which works alone or returns a team of 2–3
   members sharing the worktree; every member names its `files`, no file twice (an invalid team is sent back
   once, then the job fails). The lead merges and reports once.
4. Gate before test: a reviewer gate never shares a group with a tester of its repo. When a job is not `done`,
   or a gate returns `NEEDS-WORK`/`BLOCK`, the later groups of that dispatch are skipped and the PM decides —
   a gate next to a running tester throws the test run away (RVD-293 round 3: ~16 min).
5. A gate runs on the model of the dev lead it judges (the repo's last dev job); the executor sets it.
   `PACKAGE` jobs keep the PM's model.
6. Several testers in one group: each gets its own scratch folder (`<task>/tmp/<job>/`); only the first may
   edit the shared flow library, the others read it and park new helpers in `flows/_new/`.

**What a job may leave behind**
7. Dev jobs never commit. The lead reports the worktree HEAD before and after; when it moved, the executor has
   the commits undone (`task.mjs uncommit`: a mixed reset, refused when the commits are pushed) before the
   gate runs. If that fails the job is `blocked` and the PM decides.
8. A PR is ready. `prDraft: true` is a violation unless the user passed `--draft`.

**The plan**
9. Plan check (build/qc, size M/L): before the PM's first dispatch or `approve` is executed, `tf:reviewer`
   reads `ticket.md` and `plan.md` once, on the PM's model (`jobs/J0-reviewer-plan.md`). It cannot block: with
   points, the PM gets them next turn and fixes the plan or records why it stands, returning `planKept` for
   the points it did not take. Any `planKept` entry stops the run with status `approve`, so the user settles
   the disagreement before a job starts.
10. Size XS/S: every tester job names `cases` and the tester runs only those — no other saved flow, no smoke
    case.

**Closing**
11. Code modes close only when, for every repo a dev touched, judged on that repo's own history: a tester
    covering it PASSed after its last dev job (a later dev job on another repo does not undo that; a FAIL is
    cleared only by a PASS in a later group), and a reviewer `PACKAGE` job that started after that PASS
    reported `SHIP` with a PR URL. `close.noChange` (no dev job) still needs a tester PASS.
12. Feedback mode: no dev job → `close.noChange`; a fix with no behaviour change may close with `close.noTest`
    but still needs a `PACKAGE` after the last dev; `--check` allows no jobs at all.

**Limits**
13. 12 PM turns · 12 jobs per dispatch · 6 jobs per group · 6 dev jobs per repo per run · 3 members per lead.
    Two guard violations in a row → escalate. Token reserve 80k → handoff. (Three fix attempts on one issue →
    the PM escalates; that one is the PM's rule, not the executor's.)

**Tool guard** (`hooks/guard.ts`, a hooks module beside the executor; `tests/guard.test.ts`): when the
executor starts a job the guard reads its prompt, and that agent's tool calls are refused when a dev job runs
`git commit|push|merge|rebase`, a team member edits a file given to another member, or a tester told
`FLOW LIBRARY READ-ONLY` writes to the library. Unrecognised agents and any failure in the guard let the
call through.

Workspace hard rules (read-only zones, forbidden commands, browsers, screenshots) live in the workspace config
and every agent reads them.

## Sizing and models (PM decides)

| Size | Typical task | Typical staffing |
|---|---|---|
| XS | text, colour, spacing, show/hide | dev → gate → tester (named cases) → PACKAGE |
| S | add a field/column, one screen, one repo | dev ∥ tester FLOWS → gate → tester (named cases) → PACKAGE |
| M | 2 repos or API change | plan check; one lead per repo in parallel ∥ tester FLOWS → gates → tester(s) → PACKAGE |
| L | new feature, migration, money, permissions | M + opus where risky |

Model per job: haiku < sonnet < opus. Default sonnet; opus only for risky logic or judgement. The PM runs on
opus for turn 1; after that XS/S tasks run it on sonnet, M/L stay on opus, and any guard violation puts the
next PM turn back on opus.

## Files (one folder per ticket)

```
.pipeline/<SLUG>/
  ticket.md        verbatim ticket (session)                       read by PM
  HANDOFF.md       ≤ 80 lines, rewritten by PM at close             read FIRST every round
  plan.md          current round micro-tasks, contract, cases (PM)  jobs read their section
  board.md         PM ledger: dispatches, results, assumptions, open issues
  journal.md       append-only, 1–3 lines per job (each agent)      grep only
  jobs/J<n>-<role>-<repo>.md   brief + report (the job's agent)     PM
  flows/*.mjs + flows.json     e2e flows + manifest (tester)        tester, next rounds
  ../_lib/*.mjs + README.md    shared flow helpers of the workspace (testers)   every task's flows
  evd/             WebP/txt evidence (tester)                       session uploads
  ticket-comment.md / review.md   drafts (PM / reviewer)            user approves before posting
  history/r<N>/    plan, board, jobs of finished rounds             on demand
  resources.json   resource ledger (resources.mjs)
  metrics.json     measured cost of every run (metrics.mjs)
```

One ticket = one folder and one worktree folder `.worktrees/<SLUG>/` holding one subfolder per repo, named
like the repo folder, for every mode and round. `task.mjs resolve` normalises the key, finds the folder
case-insensitively (moving it back from `_archive/`), and reports legacy suffixed folders (`-e2e`, `-qc`,
`-r2`…) without creating new ones. The `HANDOFF.md` header lines (`Slug:`, `Round:`, `Status:`, `Mode:`,
`PR <repo>:`, `Worktree <repo>:`) are machine-read by `task.mjs`; their exact form is in `agents/pm.md`.

## E2E flows

The standard is `guidelines/e2e-testing.md`; the tester's procedure is `agents/tester.md`. What the design
adds:

- **A flow is a file that is kept.** `flows/<case>.mjs` reads `BASE_URL`, `API_URL`, `EVD_DIR`, `RUN_ID`,
  `TARGET`, `PLAYWRIGHT_FROM` / `ANDROID_SERIAL` from env and writes `<EVD_DIR>/<case>.verdict.json` plus
  screenshots. `flow-kit.mjs` gives `webFlow()` / `androidFlow()`; `flow-run.mjs` runs flows, converts
  screenshots to WebP and updates `flows.json`. A later round re-runs them instead of re-driving the UI.
- **Shared library.** `<root>/.pipeline/_lib/` (`FLOW_LIB`) holds login, seeding and other helpers for the
  whole workspace, indexed in its `README.md`, so no task starts from an empty folder.
- **Look before writing.** `flow-peek.mjs` opens a screen and prints the real test ids, labels and role + name
  locators; a failed web step saves the same description of the page it failed on, so a selector is fixed
  from what is there, not by re-running.

## Retention

`reaper.mjs install` registers a job with the system's scheduler (launchd, a systemd user timer or cron, Task
Scheduler) that runs `resources.mjs reap` every 30 minutes; days via `TF_PRUNE_DAYS`, `TF_ARCHIVE_DAYS`.

| What | When | Action |
|---|---|---|
| Task whose PRs are all merged/closed | next reap | free worktrees, DB, cache, ports; promote passing flows to `_regression/`; move folder to `_archive/` |
| Task idle > `TF_PRUNE_DAYS` (7), PR still open | prune | free resources (worktree with unsaved work is kept); slim folder to the handoff set |
| Task idle > `TF_PRUNE_DAYS`, no open PR | prune | free resources, delete folder |
| Archived task idle > 7 / > `TF_ARCHIVE_DAYS` (30) days | prune | slim to the handoff set / delete |
| Worktree no ledger owns, idle > 7 days, clean and pushed | prune | `git worktree remove` |
| Leftover/empty `.worktrees/<SLUG>/` folders | prune | delete |
| APK cache | every `apk.mjs get` | trimmed to 300 MB, least recently used first |

The handoff set is HANDOFF, journal, flows, ticket, plan, board: a late QC round still has its flows.

## Speed helpers

- `pool.mjs` keeps one warm worktree per repo (`.worktrees/_pool/<key>`: detached at origin/<base>, deps
  cloned, `.env` copied). Setup moves it into the task path and switches branch; the orchestrator refills
  it in the background after a run. Prune never removes `_pool/`.
- `fastdeps.mjs` clones `node_modules` / `.dart_tool` from the main checkout (APFS clone on macOS, reflink on
  Linux btrfs/xfs, a plain copy elsewhere) when the lockfile matches and the main checkout's direct
  dependencies are installed at the locked versions (`stale-deps` otherwise — its owner pulled without
  installing). `pool.mjs fill --install` then installs inside the pool, in the background.
- `serve.mjs` starts the task's app servers once per run from the config `## Servers` (task ports, DB,
  cache filled in), waits for their health checks, and keeps them up across jobs; jobs call `start`
  again (a no-op when they answer). Each is a `server` run-end resource, so `end-run` stops it.

## Metrics

`metrics.mjs` measures every run from the transcripts Claude Code keeps for each workflow agent — the
engine cannot (its token budget is one shared counter and it has no clock per job). Per job: minutes, time
waiting on tools vs model time, turns, tokens, the slowest commands. Per run: wall time, minutes per role
(the plan check is its own column), PM turns, dev/tester jobs, re-tests, plugin version. The orchestrator
runs it after every run and keeps the history in `<task>/metrics.json`; `/tf:status --metrics` lists all runs
so two plugin versions can be compared. A change made for speed names the number it should move and is
checked against the next runs.

## Operating systems

Everything that differs between macOS, Linux and Windows is in `scripts/platform.mjs` (shell, ports and
process trees, dependency copies, paths); `tests/platform.mjs` exercises it for real and CI runs it on all
three. The support table is in the README.

## Maintenance commands

- `task.mjs legacy <root> [--apply]` folds old suffixed folders into `<SLUG>/history/legacy/` and removes
  clean legacy worktrees; `task.mjs migrate-worktrees` moves old flat `<slug>-<key>` worktrees (both are a
  dry run unless `--apply`).
- `resources.mjs promote` copies a task's passing flows into `.pipeline/_regression/` by hand (reap does it
  on merge); `/tf:e2e --regression` runs them.
- `doctor.mjs <root>` checks tools, agents, config, repos, Playwright and the config's `## Doctor` lines.

## Plugin vs workspace

Plugin (`tf@sdc`: skills, agents, engine, scripts, guidelines): orchestration, roles, hard rules, file
layout, flow contract, formats. Workspace (`<root>/.claude/task-flow.md`): repos, excluded and read-only
paths, test policy, tracker, spec sources, provisioning recipes, flow targets/helpers, evidence and close-out
rules, language.
