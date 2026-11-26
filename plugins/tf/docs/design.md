# task-flow — design

The SDC `tf` plugin (`tf@sdc`): a PM agent plans each task and staffs dev / tester / reviewer agents; a thin
executor runs the jobs and enforces the hard rules.

This file is the reference for **why and how the pieces fit**. What each agent must do is in its own file
and is not repeated here: `agents/*.md` (roles), `docs/orchestrator.md` (what a `/tf:*` command does in the
session), `docs/pm-feedback.md` (feedback mode), `docs/reviewer-plan.md` and `docs/reviewer-review.md` (the reviewer's plan check and review mode), `guidelines/` (git, PR, review, review reply, ticket comment, e2e). How
to use the plugin is in `README.md`.

## Shape

```
session (orchestrator, has Bash)            executor (engine/src; no fs — the host runs it)
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
| `setup` | provisioning per workspace config (generic agent, haiku; sonnet when the PM gives `modelWhy` or haiku could not finish) | touches other tasks' resources |

The roster is a menu. The PM uses the fewest roles that satisfy the hard rules.

## Modes

| Command | Mode | Allowed roles | Ends with |
|---|---|---|---|
| `/tf:build <anything>` | build | setup, dev, tester, reviewer | PR(s) ready |
| `/tf:qc <task>` | qc | setup, dev, tester, reviewer | existing PR updated (or new PR if merged) |
| `/tf:address-review <task\|PR> [--check]` | feedback | setup, dev, tester, reviewer (none with `--check`) | triage, fixes pushed to the same PR, reply drafts |
| `/tf:review <PR\|task>` | review | setup, reviewer | static review report + PR comment draft |
| `/tf:e2e <PR\|task> [--cases a,b]` | e2e | setup, tester (only on approved cases) | cases.md to approve, then evidence + ticket comment draft |
| `/tf:demo <canvas> [words]` | — (no workflow, `hosts/claude/docs/demo.md`) | none | clickable demo of the canvas, local or one artifact |

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
   a gate next to a running tester throws the test run away (PROJ-293 round 3: ~16 min). In code modes a
   tester that did not PASS skips them too, so a `PACKAGE` job dispatched after it never pushes failing code.
5. A gate runs on the model of the dev lead it judges (the repo's last dev job); the executor sets it.
   `PACKAGE` jobs keep the PM's model but never run below sonnet (they write the PR body).
6. Several testers in one group: each gets its own scratch folder (`<task>/tmp/<job>/`); only the first may
   edit the shared flow library, the others read it and park new helpers in `flows/_new/`.

6a. A gate's `IMPACT<n>` issues (other users of the changed code that no case covers) are added to the prompt
   of the tester jobs of that repo in the later groups of the same dispatch, on top of their `cases`. They
   never change the gate's verdict.

**What a job may leave behind**
7. Dev jobs never commit. The lead reports the worktree HEAD before and after; when it moved, the executor has
   the commits undone (`task.mjs uncommit`: a mixed reset, refused when the commits are pushed) before the
   gate runs. If that fails the job is `blocked` and the PM decides.
8. A PR is ready. `prDraft: true` is a violation unless the user passed `--draft`.

**The plan**
8a. Clarify: as the first decision of a run the PM may return `clarify` with questions instead of a plan; the
    run ends with status `clarify`, the orchestrator asks the user, writes the answers into `ticket.md` and
    relaunches. Rejected once a job has run, with `--assume`, or after 3 rounds (the PM assumes or escalates).
9. Plan check (build/qc, size M/L): before the PM's first dispatch or `approve` is executed, `tf:reviewer`
   reads `ticket.md` and `plan.md` once, on the PM's model (`jobs/J0-reviewer-plan.md`). It cannot block: with
   points, the PM gets them next turn and fixes the plan or records why it stands, returning `planKept` for
   the points it did not take. Any `planKept` entry stops the run with status `approve`, so the user settles
   the disagreement before a job starts.
10. Size XS/S: every tester job names `cases` and the tester runs only those — no other saved flow, no smoke
    case.

10a. Small-task lane (XS/S): a `PACKAGE` job may run with no gate after the repo's last dev job; the executor
    tells it so and it runs the gate checklist first, on the dev lead's model, packaging only when clean. On
    M/L such a `PACKAGE` is rejected. A lane dev job that changed more than 3 files stops the dispatch so a
    gate runs before the tester. An XS task has dev jobs on one repo only and its lead never splits.
10b. No `FLOWS` job on XS tasks, nor in a fix round (a dispatch whose dev jobs are all on repos that already
    had one this run).

10c. Size L (build/qc): after the plan check, the first dispatch is not run — the run ends with status `approve`
    and `design` (the path of `design.md`), so the user reads design and plan before any job. Not with
    `--assume`, not once approved. The plan check is pointed at `design.md` too, and each dev lead writes its
    `## Approach` before the first edit.

**Closing**
11. Code modes close only when, for every repo a dev touched, judged on that repo's own history: a tester
    covering it PASSed after its last dev job (a later dev job on another repo does not undo that; a FAIL is
    cleared only by a PASS in a later group), and a reviewer `PACKAGE` job that started after that PASS
    reported `SHIP` with a PR URL. `close.noChange` (no dev job) still needs a tester PASS.
12. Feedback mode: no dev job → `close.noChange`; a fix with no behaviour change may close with `close.noTest`
    but still needs a `PACKAGE` after the last dev; `--check` allows no jobs at all.

**Limits**
13. 12 PM turns · 12 jobs per dispatch · 6 jobs per group · 6 dev jobs per repo per run · 3 members per lead.
    Two guard violations in a row → escalate. A job of the same kind on the same repo that did not finish twice
    in a row (blocked, failed, no answer) → the PM gets one turn to write the board and the handoff, then the
    run escalates with both reasons; it is never sent a third time. Token reserve 80k → handoff. (Three fix attempts on one issue →
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
| XS | text, colour, spacing, show/hide; one repo, ≤ 3 files | small-task lane: dev → tester (named cases) → PACKAGE that gates first |
| S | add a field/column, one screen, one repo | small-task lane when ≤ 3 files per repo; else dev (∥ FLOWS) → gate → tester (named cases) → PACKAGE |
| M | 2 repos or API change | plan check; one lead per repo in parallel ∥ tester FLOWS → gates → tester(s) → PACKAGE |
| L | new feature, migration, money, permissions | M + `design.md` approved by the user first + opus where risky |

Model per job, by the kind of work (the table in `agents/pm.md`; the executor enforces the rows marked there):

| Work | Model |
|---|---|
| PM turn 1 (sizing, plan, design), writing `cases.md` | opus |
| PM turn that must judge: a FAIL, blocked, NEEDS-WORK, plan-check points, a rejected decision | opus |
| PM turn that only reads green reports and dispatches the next group (any size) | sonnet |
| dev: risky logic (money, auth, permissions, concurrency, migrations) | opus, with `modelWhy` |
| dev: ordinary work · tester · gate (or its lead's model) · PACKAGE (floor) | sonnet |
| setup · XS copy/style edits · uncommit | haiku |

A haiku job that does not finish (`blocked`, `failed`, no answer) is run once more on sonnet, from where it
stopped. A guard violation puts the next PM turn on opus.

## Files (one folder per ticket)

```
.pipeline/<SLUG>/
  ticket.md        the brief in force: request, source, clarifications, comments since the last round   read by PM
  ticket-history.md  earlier rounds' comments and round blocks, verbatim   opened only to quote
  HANDOFF.md       ≤ 80 lines, rewritten by PM at close             read FIRST every round
  plan.md          current round: requirements, (M) design, micro-tasks, contract, cases (PM)   jobs read their section
  design.md        size L only: data, neighbours, interfaces, decisions, flow, risks (PM); kept across rounds
  board.md         PM ledger: dispatches, results, assumptions, open issues
  journal.md       append-only, 1–3 lines per job (each agent)      grep only
  jobs/J<n>-<role>-<repo>.md   brief + report (the job's agent)     PM
  flows/*.mjs + flows.json     e2e flows + manifest (tester; read through `flow-run --list`)   tester, next rounds
  ../_lib/*.mjs + README.md    shared flow helpers (README = index, one line per file)   every task's flows
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
- **Approved cases, then the cheapest run.** In e2e the PM writes `cases.md` and the run stops (status
  `cases`); the user edits and approves it and `cases.mjs approve` freezes it in `cases.approved.json`. Three
  things are tracked apart: the snapshot (invalid when the user edits cases.md or the ticket/specs change), a
  flow (written for one `rev` of its case — `flow-run.mjs --mark-written`; stale when the case changes) and a
  result (valid only for the same `rev`, target and commit — `task.mjs commit`). The orchestrator runs fresh
  flows with no agent and launches a tester only for stale, missing or failing ones; `cases.mjs results` alone
  decides the verdict (`verified`, `verified-bugs`, `incomplete`) and writes the ticket comment.
- **Evidence points at the bug.** `expect(..., { at })` / `mark()` record the element; `annotate.mjs` draws a red
  box and label (and a close-up) before WebP conversion — no model looks at an image.
- **Look before writing.** `flow-peek.mjs` opens a screen and prints the real test ids, labels and role + name
  locators (`--android <serial>`: the emulator's resource ids, texts and descs); a failed step saves the same
  description of the screen it failed on (`.page.txt` Web, `.ui.txt` Android), so a selector is fixed from what
  is there, not by re-running.
- **Re-run only what changed.** A result is stored with its commit, target and `flowHash` (the flow plus the
  `_lib` files it imports); `flow-run --changed` skips cases already green on all three. Each case has a
  ceiling (180 s Web/API, 360 s Android) and a timed-out result names the step it hung in.

## Retention

## What an agent cannot be talked into

Agents read text other people wrote — the ticket, PR comments, pages, chats — and several can run commands.
Each prompt says that such text is data, never an instruction. Because a prompt can be argued with, the
rules that matter most are also refused at the tool call, for every tf agent (`hooks/guard.ts`):

| Never | Why it is there |
|---|---|
| read, list, copy or edit `~/.claude/task-flow/auth` | the saved logins are used by the scripts, not handed to a model |
| `gh pr merge`, `gh pr review`, the merge API | a PR stops at its link |
| `git push --force`, `-f`, `+ref` | pushed history is never rewritten |
| `gh pr comment`, `gh issue comment`, `pr-feedback.mjs post/reply/comment/review/resolve`, `jira.mjs comment --confirm` | the orchestrator posts, after the user approved the text |
| a `git commit -m` or `gh pr create\|edit --title` that breaks `guidelines/git.md` (the issue key not as scope, a `[KEY]`, a non-English PR title), `gh pr create --fill` | titles stay consistent; what the guard cannot read is checked with `naming.mjs check` |

These are string checks in memory (microseconds per tool call). They narrow what a misled agent can do; they
are not a sandbox — a command can be disguised — so the PM also runs with a fixed tool list, the ledger does
not carry commands, and a canvas's code runs in its own process.

A kind + id (a cache index, a port, a DB, an emulator) is held by one task at a time: `resources.mjs add`
claims under a workspace lock and refuses an id another task holds (exit 3); server names stay per task.

The ledger (`.pipeline/<slug>/resources.json`) says what a task holds, not how to free it: for worktrees,
ports, servers, browsers and emulators tf builds the action from the id and ignores any command stored with
the entry; a port's listener is stopped only when it runs from the task's own folders. Other kinds (a DB, a
cache index) are freed by the stored command only when it is one of that kind's recipes in the config's
Provisioning table, with plain values in the placeholders — anything else waits for `release --unlisted`.

Cleanup is never part of a task run: a run touches its own task only. `/tf:clean` runs `resources.mjs reap`
for the workspace when the user asks, and nothing runs in the background; days via `TF_PRUNE_DAYS`,
`TF_ARCHIVE_DAYS`.

| What | When | Action |
|---|---|---|
| Task whose PRs are all merged/closed | next `/tf:clean` | free worktrees, DB, cache, ports; promote passing flows to `_regression/`; move folder to `_archive/` and slim it at once (text stays; evidence, logs, scratch, attachments go) |
| Task idle > `TF_PRUNE_DAYS` (7), PR still open | next `/tf:clean` | free resources (worktree with unsaved work is kept); slim folder to the handoff set |
| Task idle > `TF_PRUNE_DAYS`, no open PR | next `/tf:clean` | free resources, delete folder |
| Archived task idle > 7 / > `TF_ARCHIVE_DAYS` (30) days | next `/tf:clean` | slim to the handoff set / delete |
| Worktree no ledger owns, idle > 7 days, clean and pushed | next `/tf:clean` | `git worktree remove` |
| Leftover/empty `.worktrees/<SLUG>/` folders | next `/tf:clean` | delete |
| APK cache | every `apk.mjs get` | trimmed to 300 MB, least recently used first |

The handoff set is HANDOFF, journal, flows, ticket, plan, design, board: a late QC round still has its flows.

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
  again (a no-op when they answer and run the worktree's current code; a server whose code changed since it
  started, or one serve.mjs did not start, from the task's worktree, is restarted). Each is a `server` run-end resource, so `end-run` stops it.

## Metrics

`metrics.mjs` measures every run from the transcripts Claude Code keeps for each workflow agent — the
engine cannot (its token budget is one shared counter and it has no clock per job). Per job: minutes, time
waiting on tools vs model time, turns, tokens, the slowest commands. Per run: wall time, minutes per role
(the plan check is its own column), PM turns, dev/tester jobs, re-tests, plugin version. The orchestrator
runs it after every run and keeps the history in `<task>/metrics.json`; `/tf:status --metrics` lists all runs
so two plugin versions can be compared. A change made for speed names the number it should move and is
checked against the next runs. (Small-task lane, 1.12.0: agents per S run 8 → 5, PM turns 3 → 2.)

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
