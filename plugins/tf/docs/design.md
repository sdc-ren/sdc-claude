# task-flow v2 — design

Status: implemented 2026-11-13, shipped as the SDC `tf` plugin (`tf@sdc`). Replaces v1 (fixed planner → coder → tester ∥ auditor → reviewer
pipeline).

## Why v2

Measured on ~60 v1 runs in a multi-repo workspace (backend, web, Flutter app), Nov 2026:

| v1 cost | Evidence |
|---|---|
| 7 mechanical haiku agents per run (lock, STATUS ×5, unlock) | 60–100k tokens each, serial |
| Plan-review 2 rounds (6 agents) on almost every run | 400–500k tokens; `plan:gap` still fired afterwards |
| Repos run strictly in sequence | FE waited for BE to ship |
| Every fix round re-ran the full verify-plan + auditor + plan:gap | test r2/r3 100–175k each |
| Tester drove the UI by hand every round | 70–200 tool calls per tester run |
| Handoff files grew without bound | spec.md 214 KB, ticket.md 88 KB, all re-read |

BE+FE build runs took 130–230 min and 2.5–4.5M tokens with 24–42 agents.

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

## Roles (`agents/*.md` → `tf:pm`, `tf:dev`, `tf:tester`, `tf:reviewer`)

| Role | Owns | Never |
|---|---|---|
| `tf:pm` | brief, plan, board, HANDOFF, ticket-comment draft; picks jobs, roles, models, size | edits repo code, runs tests |
| `tf:dev` | code changes in its worktree for its micro-tasks; micro-tests | commits, judges its own work |
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
3. Code modes cannot close until, for every repo a dev touched: every tester after the last dev job
   passed (and one covers the repo), and a reviewer `PACKAGE` job that started after that PASS reported
   `SHIP` with a PR URL. `close.noChange` still needs a tester PASS.
3a. feedback mode: no dev job → `close.noChange`; a fix with no behaviour change may close with
   `close.noTest` (no tester ran) but still needs a PACKAGE after the last dev; `--check` allows no jobs at all.
3b. When a job in a group is not `done`, or a reviewer gate returns `NEEDS-WORK`/`BLOCK`, the later groups of that
   dispatch are skipped and the PM decides.
3c. Gate before test (build/qc): a reviewer gate and the tester it precedes never share a group — a
   NEEDS-WORK gate next to a running tester throws the test run away (RVD-293 round 3: ~16 min).
4. PR is ready. A reviewer report with `prDraft: true` is a violation unless the user passed `--draft`.
5. Caps: PM turns ≤ 10, jobs per dispatch ≤ 6, fix cycles per issue id ≤ 3 (PM must escalate), token
   reserve 80k → handoff.
6. Two guard violations in a row → escalate.

Workspace hard rules (read-only zones, forbidden commands, browsers, screenshots) live in the
workspace config and every agent reads them.

## Sizing (PM decides)

| Size | Typical task | Typical staffing |
|---|---|---|
| XS | text, colour, spacing, show/hide | PM (short) → dev → reviewer gate → tester → reviewer PACKAGE |
| S | add a field/column, one screen, one repo | same, tester writes 1 flow |
| M | 2 repos or API change | devs in parallel per repo → reviewer gates → tester(s) |
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
  evd/             WebP/txt evidence (tester)                       session uploads
  ticket-comment.md / review.md   drafts (PM / reviewer)            user approves before posting
  history/r<N>/    plan, board, jobs of finished rounds             on demand
  resources.json   resource ledger (resources.mjs)
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

## Maintenance commands

- `task.mjs legacy <root> [--apply]` folds v1 suffixed folders into `<SLUG>/history/legacy/` and removes
  clean legacy worktrees (dry run unless `--apply`).
- `resources.mjs reap` promotes a merged task's passing flows into `.pipeline/_regression/`
  (`resources.mjs promote` by hand); `/tf:e2e --regression` runs them.
- `doctor.mjs <root>` checks tools, agents, config, repos, Playwright and the config's `## Doctor` lines.

## Global vs workspace

Plugin (`tf@sdc`: skills, agents, workflow, scripts, guidelines): orchestration, roles, hard
rules, file layout, flow contract, formats. Workspace (`<root>/.claude/task-flow.md`): repos,
excluded and read-only paths, test policy, tracker, spec sources, provisioning recipes, flow
targets/helpers, evidence and close-out rules, language.
