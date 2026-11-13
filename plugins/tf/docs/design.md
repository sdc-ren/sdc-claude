# task-flow — design

The SDC `tf` plugin (`tf@sdc`): a PM agent plans each task and staffs dev / tester / reviewer agents; a thin
executor runs the jobs and enforces the hard rules.

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
| `tf:pm` | brief, plan, board, HANDOFF, ticket-comment draft; picks jobs, roles, models, size | edits repo code, runs tests |
| `tf:lead` | one repo's dev job: does it alone, or splits it among ≤ 3 members (disjoint files, agreed interfaces), merges, makes the repo build, one report to the PM | commits, judges its own work |
| `tf:dev` | member of a lead's team: code changes in its own files for its micro-tasks; micro-tests; reports to the lead | commits, edits another member's files |
| `tf:tester` | e2e flows (`flows/`), EVD, verdicts | edits repo code |
| `tf:reviewer` | static gate (scope, contract, quality, tamper, read-only zones); commit + push + PR; review-mode report | edits code, merges |
| `setup` | provisioning per workspace config (generic agent, sonnet) | touches other tasks' resources |

The roster is a menu. The PM uses the fewest roles that satisfy the hard rules.

## Commands and modes

| Command | Mode | Allowed roles | Ends with |
|---|---|---|---|
| `/tf:build <ticket|text>` | build | setup, dev, tester, reviewer | PR(s) ready |
| `/tf:qc <ticket>` | qc | setup, dev, tester, reviewer | existing PR updated (or new PR if merged) |
| `/tf:address-review <ticket|PR> [--check]` | feedback | setup, dev, tester, reviewer (none with `--check`) | triage, fixes pushed to the same PR, reply drafts |
| `/tf:review <PR|ticket>` | review | setup, tester, reviewer | review report + PR/ticket comment drafts |
| `/tf:e2e <PR|ticket> [--cases a,b]` | e2e | setup, tester | EVD + ticket comment draft |

Flags: `--approve` (stop for the user after the first plan), `--draft` (user allows a draft PR),
`--lang <code>`. There is no `--repos`: the PM inspects every repo the workspace config lists.

## Hard rules (enforced by the executor, not by prompts)

1. Roles outside the mode's allowed set are rejected.
2. Writer ≠ judge: a dev job and a tester/reviewer job are always separate agents.
2b. One dev job per repo per group. It goes to the repo's lead, which works alone or returns a team of 2–3
   members sharing the worktree: every member names its `files`, no file twice (an invalid team is sent back
   once, then the job fails). The lead merges and reports once. Several tester jobs in one group split the
   cases; all of them must PASS.
2a. A tester job whose brief starts with `FLOWS` only writes flows from the plan's cases and contract while the
   dev works (same group allowed). It returns verdict NONE, never counts as a test, never blocks later groups.
3. Code modes cannot close until, for every repo a dev touched, judged on that repo's own history: a tester
   covering it PASSed after ITS last dev job (a later dev job on another repo does not undo that; a FAIL is
   cleared only by a PASS in a later group), and a reviewer `PACKAGE` job that started after that PASS reported
   `SHIP` with a PR URL. `close.noChange` still needs a tester PASS.
3c. Plan check (build/qc, size M/L): before the PM's first dispatch (or `approve`) is executed, `tf:reviewer`
   reads `ticket.md` and `plan.md` once, on the PM's model, for missing requirements, a repo left out and
   assumptions the ticket contradicts (`jobs/J0-reviewer-plan.md`). It cannot block: with points, the PM gets
   them next turn and fixes the plan or records why it stands; without, the dispatch runs as returned.
3d. A reviewer gate runs on the model of the dev lead it judges (the repo's last dev job) — the executor sets
   it. PACKAGE jobs keep the PM's model.
3e. Limits: 12 PM turns, 12 jobs per dispatch, 6 per group, 6 dev jobs per repo. The PM prompt of turn 1
   (and of a rejected turn) carries the rules, generated from the same constants the guards use.
3a. feedback mode: no dev job → `close.noChange`; a fix with no behaviour change may close with
   `close.noTest` (no tester ran) but still needs a PACKAGE after the last dev; `--check` allows no jobs at all.
3b. When a job in a group is not `done`, or a reviewer gate returns `NEEDS-WORK`/`BLOCK`, the later groups of that
   dispatch are skipped and the PM decides.
3c. Gate before test (build/qc): a reviewer gate and the tester it precedes never share a group — a
   NEEDS-WORK gate next to a running tester throws the test run away (RVD-293 round 3: ~16 min).
4. PR is ready. A reviewer report with `prDraft: true` is a violation unless the user passed `--draft`.
5. Caps: PM turns ≤ 10, jobs per dispatch ≤ 6, dev jobs per repo per run ≤ 6, members per lead ≤ 3, fix cycles per issue id ≤ 3 (PM must escalate), token
   reserve 80k → handoff.
6. Two guard violations in a row → escalate.

Workspace hard rules (read-only zones, forbidden commands, browsers, screenshots) live in the
workspace config and every agent reads them.

## Sizing (PM decides)

| Size | Typical task | Typical staffing |
|---|---|---|
| XS | text, colour, spacing, show/hide | PM (short) → dev → reviewer gate → tester → reviewer PACKAGE |
| S | add a field/column, one screen, one repo | dev ∥ tester FLOWS → gate → tester → PACKAGE |
| M | 2 repos or API change | one lead per repo in parallel (each alone or with members) ∥ tester FLOWS → reviewer gates → tester(s) |
| L | new feature, migration, money, permissions | M + opus where risky |

Model per job: haiku < sonnet < opus. Default sonnet; opus only for risky logic or judgement.
The PM itself runs on opus for turn 1 (sizing and planning); after that XS/S tasks run the PM on
sonnet, M/L stay on opus, and any guard violation puts the next PM turn back on opus.

## Plan format (micro-tasks)

`plan.md` holds the current round only (≤ ~150 lines), one section per repo:

```
## be — branch fix/PROJ-301-x (base develop)
- [M1] Modify `src/services/x.service.ts` — what changes. How: only for contracts.
  done-when: `npm run typecheck` clean; `curl … /api/x` → 200 {…}
```

What + Where are mandatory. How only at boundaries (API contract, shared types, migrations,
non-obvious decisions). Micro-tests are cheap checks (typecheck, lint of the file, curl, one flow
step) — never new unit tests unless the workspace `Test policy` allows them.

## Escalation bar (PM)

Stop and ask the user only for: broken layout / UI clearly unlike the design or current screens;
a flow or logic totally different from before; a spec change the ticket does not settle; risk to
money, permissions, data, or security; any edit inside a workspace read-only zone. Everything else:
decide, record under `Assumptions` in `board.md`, list them in the round report.

## Files (one folder per ticket)

```
.pipeline/<SLUG>/
  ticket.md        verbatim ticket (session)                       read by PM
  HANDOFF.md       ≤ 80 lines, rewritten by PM at close             read FIRST every round
  plan.md          current round micro-tasks (PM)                   jobs read their section
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

`HANDOFF.md` header lines are machine-read by `task.mjs`:

```
Slug: PROJ-301
Round: 2
Status: done | escalated | in-progress
Mode: build
PR be: https://github.com/…/pull/649
Worktree be: /…/.worktrees/PROJ-301/backend
```

One ticket = one folder and one worktree folder `.worktrees/<SLUG>/` holding one subfolder per repo, named
like the repo folder (`backend/`, `frontend/`, `mobile/`), for every mode and round. `task.mjs resolve` normalises the key, finds the folder case-insensitively (moving it
back from `_archive/`), and reports legacy suffixed folders (`-e2e`, `-qc`, `-r2`…) without creating
new ones.

## E2E flows

Standard: `guidelines/e2e-testing.md` (in the plugin). The kit adds a 15 s step ceiling (not a delay), `waitApi` /
`ready` / `gotoReady` to wait for the app instead of the clock, console-error and 5xx warnings in every
verdict, and a Playwright trace only with `TRACE=1`.

Contract (generic, in the skill): a flow is `flows/<case>.mjs`, reads `BASE_URL`, `API_URL`,
`EVD_DIR`, `RUN_ID`, `TARGET`, `PLAYWRIGHT_FROM` / `ANDROID_SERIAL` from env, writes
`<EVD_DIR>/<case>.verdict.json` and screenshots. `flow-kit.mjs` gives `webFlow()` / `androidFlow()`
helpers; `flow-run.mjs` runs flows, converts screenshots to WebP, updates `flows.json`.
Project-specific helpers, accounts and targets come from the workspace config `## Flows` section.
Flows stay in the task folder; a later round re-runs them instead of re-driving the UI.

Two things keep writing them cheap. **Shared library**: `<root>/.pipeline/_lib/` (`FLOW_LIB`) holds login,
seeding and other helpers for the whole workspace, indexed in its `README.md`; a task's flows import it and the
tester adds what a later ticket would need again, so no task starts from an empty folder. **Look before
writing**: `flow-peek.mjs` opens a screen (after optional steps) and prints the real test ids, labels and
role + name locators; a failed web step saves the same description of the page it failed on, so a selector
is fixed from what is there, not by re-running.

## Retention

Runs from launchd every 30 minutes (`install-reaper.sh`; days via `TF_PRUNE_DAYS`, `TF_ARCHIVE_DAYS`):

| What | When | Action |
|---|---|---|
| Task whose PRs are all merged/closed | next reap | free worktrees, DB, cache, ports; promote passing flows to `_regression/`; move folder to `_archive/` |
| Task idle > `TF_PRUNE_DAYS` (7), PR still open | prune | free resources (worktree with unsaved work is kept); slim folder to the handoff set |
| Task idle > `TF_PRUNE_DAYS`, no open PR | prune | free resources, delete folder |
| Archived task idle > 7 / > `TF_ARCHIVE_DAYS` (30) days | prune | slim to the handoff set / delete |
| Worktree no ledger owns, idle > 7 days, clean and pushed | prune | `git worktree remove` |
| Leftover/empty `.worktrees/<SLUG>/` folders | prune | delete |
| APK cache | every `apk.mjs get` | trimmed to 300 MB, least recently used first |

`resources.mjs`: `reap` frees resources when every PR is merged/closed and archives the folder;
archives are slimmed (not deleted) to HANDOFF, journal, flows, ticket, plan, board for
`TF_ARCHIVE_DAYS` (default 30) so a late QC round still has its flows.

## Speed helpers

- `pool.mjs` keeps one warm worktree per repo (`.worktrees/_pool/<key>`: detached at origin/<base>, deps
  cloned, `.env` copied). Setup moves it into the task path and switches branch; the orchestrator refills
  it in the background after a run. Prune never removes `_pool/`. `task.mjs migrate-worktrees` moves the old flat `<slug>-<key>` worktrees.
- `fastdeps.mjs` clones `node_modules` / `.dart_tool` from the main checkout with `cp -c` when the
  lockfile matches and the main checkout's direct dependencies are actually installed at the locked
  versions (`stale-deps` otherwise — its owner pulled without installing). `pool.mjs fill --install` then
  installs inside the pool, in the background.
- `serve.mjs` starts the task's app servers once per run from the config `## Servers` (task ports, DB,
  cache filled in), waits for their health checks, and keeps them up across jobs; jobs call `start`
  again (a no-op when they answer). Each is a `server` run-end resource, so `end-run` stops it.

## Metrics

`metrics.mjs` measures every run from the transcripts Claude Code keeps for each workflow agent — the
engine cannot (its token budget is one shared counter and it has no clock per job). Per job: minutes, time
waiting on tools vs model time, turns, tokens, the slowest commands. Per run: wall time, minutes per role,
PM turns, dev/tester jobs, re-tests, plugin version. The plan check is its own column (`plan`). The orchestrator runs it after every run and keeps the
history in `<task>/metrics.json`; `/tf:status --metrics` lists all runs so two plugin versions can be
compared. A change made for speed names the number it should move and is checked against the next runs.

## Maintenance commands

- `task.mjs legacy <root> [--apply]` folds old suffixed folders into `<SLUG>/history/legacy/` and removes
  clean legacy worktrees (dry run unless `--apply`).
- `resources.mjs reap` promotes a merged task's passing flows into `.pipeline/_regression/`
  (`resources.mjs promote` by hand); `/tf:e2e --regression` runs them.
- `doctor.mjs <root>` checks tools, agents, config, repos, Playwright and the config's `## Doctor` lines.

## Global vs workspace

Plugin (`tf@sdc`: skills, agents, workflow, scripts, guidelines): orchestration, roles, hard
rules, file layout, flow contract, formats. Workspace (`<root>/.claude/task-flow.md`): repos,
excluded and read-only paths, test policy, tracker, spec sources, provisioning recipes, flow
targets/helpers, evidence and close-out rules, language.
