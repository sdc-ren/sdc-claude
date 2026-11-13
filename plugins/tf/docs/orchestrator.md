# tf — orchestrator (SDC task-flow)

The `/tf:*` skills load this file. `<PLUGIN>` is the plugin root the skill gave you (its
`${CLAUDE_PLUGIN_ROOT}`); every path below is absolute once you substitute it.

You are the orchestrator: you prepare the task, launch the workflow, relay escalations, and close out.
You never write, test, or review repo code yourself. Design and rationale: `docs/design.md`.

`S` = `<PLUGIN>/scripts` · `W` = `<PLUGIN>/engine/task-flow.js` · `C` = `<cwd>/.claude/task-flow.md`
(workspace config) · guidelines `<PLUGIN>/guidelines/`.

## Commands

| Command | Mode | What happens |
|---|---|---|
| `/tf:build <ticket or text>` | build | PM plans → devs → reviewer gate → tester → ready PR(s), EVD, ticket-comment draft |
| `/tf:qc <ticket>` | qc | Next round on the same folder/branches: reproduce QC cases with saved flows, fix, re-test, update the PR |
| `/tf:address-review <ticket or PR url> [--check]` | feedback | Team review on our own PRs: fetch unresolved threads/reviews/comments, triage each point, fix only the `fix` points on the same PR, draft one reply per thread (posted after approval). `--check`: triage only |
| `/tf:review <PR url or ticket>` | review | e2e of the ticket's acceptance criteria + risk report (risk, impact, UI change, AC coverage, build). No code changes |
| `/tf:e2e <PR url or ticket> [--cases a,b]` | e2e | Tester only: run/save flows, EVD, ticket-comment draft. `--regression`: run `.pipeline/_regression` flows instead (no workflow) |
| `/tf:status [--doctor] [--metrics [slug]]` | — | Resources per task and what cleanup would free (`resources.mjs list`, `reap --dry-run`); `--doctor` also runs `node $S/doctor.mjs <cwd>`; `--metrics` shows what runs cost (`metrics.mjs`) |
| `/tf:clean <slug> \| --migrate \| --legacy` | — | Free one task, move flat worktrees into `.worktrees/<SLUG>/<repo>/`, or fold old suffixed folders — dry run first, apply only after the user's yes |

Flags: `--check` (feedback: triage only, no code), `--attach` (open the checkbox picker for this task, step 6b), `--approve` (stop after the first plan for the user), `--draft` (the user allows a draft PR),
`--lang <code>` (report language). There is no repo flag: the PM inspects every repo in the config.

Languages (per workspace, from `C` → `## Language`): `lang` = `--lang` → `Report language` → the user's
language; `writingLang` = `Writing language` → a `Writing language:` line in the workspace/repo CLAUDE.md →
`en`. Everything you tell the user uses `lang`; commits, PRs, reviews and ticket comments use `writingLang`.

## 1. Pre-flight (in order)

1. **Config** — read `C`. Missing → ask the user for repos, excluded and read-only paths, test policy,
   tracker, provisioning; write it from `<PLUGIN>/docs/config-template.md`; show it.
2. **Identity** — `node $S/task.mjs resolve <cwd> "<input>"` (repos come from the config table). It returns
   `slug`, `dir`, `round`, `nextRound`, `status`, `prs`, `worktrees`, `worktreePaths` (`.worktrees/<SLUG>/<repo dir>`),
   `oldLayout`, `legacyDirs`, `locked`, `format`. `oldLayout` non-empty → suggest `/tf:clean --migrate` once.
   Use exactly that slug and folder — never invent suffixes. `locked: true` → stop: another run holds
   it. `legacyDirs`/`legacyWorktrees` non-empty → mention once (`/tf:clean --legacy`), keep going.
3. **Lock** — `node $S/task.mjs lock <dir>`; conflict → stop and tell the user.
4. **Round** — `round = nextRound`. If it is a new round of an existing task folder (`format: current`):
   `node $S/task.mjs new-round <dir> <round>` (moves plan/board/jobs into `history/`).
5. **Housekeeping** — `node $S/resources.mjs register-root <cwd>`, `node $S/resources.mjs reap`;
   `node $S/fresh.mjs <path>:<base> …` for the config repos (report skipped checkouts in one line).
   Reaper missing (`launchctl list | grep task-flow-reap` empty) → offer `sh $S/install-reaper.sh` once (re-run it after a plugin update; it copies the reaper to a stable path).
6f. **Feedback mode instead of step 6** — no tracker read. PRs = every PR of the task from `resolve` (`prs`, open AND merged — the
   PM needs to know which may not be pushed to — plus the input PR URL). `node $S/pr-feedback.mjs fetch <dir> <pr urls…>` → `<dir>/feedback.md` + JSON summary.
   Nothing open (`total` 0, no new reviews or comments) → tell the user in one line and stop (unlock), no
   workflow. Otherwise show the summary line (PR · decision · open threads · new) and launch. A task without
   a tf folder (PR made by hand): `resolve` still gives the folder; the PM reads the PR diff instead of HANDOFF.
6. **Ticket** (not in feedback mode) — read it with the tracker recipe in `C` (own browser via `browser.mjs`). Round 1: save
   everything (description, every comment, attachments list, linked issues) verbatim with the URL to
   `<dir>/ticket.md`. Later rounds: re-read the whole ticket (QC edits comments: compare `updated` with
   `created`), rewrite ticket.md, mark comments new or edited since the last round under
   `## New since round <n-1>`. Human reviews on our PRs are handled by `/tf:address-review`, not here — if
   `pr-feedback.mjs fetch` would find open threads, mention it in one line. PR input: add `gh pr view <url> --json title,body,headRefName,baseRefName,files`
   and the PR URL to ticket.md. No ticket → write the user's text.
6b. **Attachments** — artifacts / design systems mentioned with `@` (`artifact://` resources) or pasted as
   claude.ai artifact links in the command are attached: follow `<PLUGIN>/docs/attach.md` (read, store,
   record). `--attach` → run the Picker of attach.md first. `<dir>/attachments.json` from earlier rounds is
   reused silently.
7. **Session title** — `<SLUG> · <3–6 word summary>` via `mcp__ccd_session_mgmt__set_session_title`
   (`session_id: "self"`; load via ToolSearch if deferred; missing → skip).

Do not ask the user which spec sources to use: the PM uses the config defaults, links in the ticket, and the
task's attachments.

## 2. Launch

Copy the engine into the task folder and launch that copy (a script outside the session's folders is
rejected; the engine is deliberately not registered as a `/` command): `cp W <dir>/.engine.js`, then
`Workflow` with `scriptPath: <dir>/.engine.js`. Args:

```json
{ "root": "<abs cwd>", "slug": "<slug>", "dir": "<abs dir>", "mode": "build|qc|review|e2e",
  "round": <n>, "input": "<ticket key / PR url / text>", "description": "<one line>",
  "cases": "<--cases or QC case ids>", "notes": "<user constraints / escalation answers>",
  "prs": { "<repo>": "<url>" }, "worktrees": { "<repo>": "<path or null>" },
  "worktreePaths": { "<repo>": "<from resolve>" }, "format": "<from resolve>",
  "flags": { "approve": false, "draft": false, "check": false }, "approved": false,
  "lang": "<report language>", "writingLang": "<Writing language>",
  "scripts": "<abs S>", "config": "<abs C>", "agentPrefix": "tf:",
  "attachments": [ { "title": "…", "kind": "design-system|artifact", "file": "<abs specs/… file>", "url": "…" } ] }
```

The user watches `/workflows`. Do not poll.

## 3. After the run (always, any status)

1. `node $S/task.mjs unlock <dir>` and `node $S/resources.mjs end-run <cwd> <slug>` (closes browsers,
   emulators, servers of this run; worktrees/DB/ports stay for later rounds).
1b. **Metrics** — `node $S/metrics.mjs <cwd> <slug> --last`: measures the run from the agents' transcripts
   (wall time, minutes per role, time in tools vs model per job, slowest commands, tokens) and appends it to
   `<dir>/metrics.json`. Its first table line goes into the Report.
2. PRs from the result, plus the input PR in review/e2e mode → `node $S/resources.mjs prs <cwd> <slug> <urls…>`
   (reap frees resources once all are merged/closed; without a PR they stay until prune).
3. Warm pool (background, `run_in_background`): for each repo the run touched, refill its pool —
   `node $S/pool.mjs fill <cwd> <key> <repoPath> --base <base> --lock <lockfile> --dirs <dirs> --install "<install cmd>"`
   (values from `C`; the install command is the one the Provisioning row uses when fastdeps cannot clone).
   Do not skip it: an empty pool makes the next setup create and install a worktree from scratch.
4. Act on the status:

| status | Action |
|---|---|
| `done` (feedback) | Report the triage table, what was fixed (commits, PR links), then show `<dir>/feedback-replies.md`. Post only after the user approves the text (they may edit or drop replies): per thread `node $S/pr-feedback.mjs reply <dir> <R<n>> --body-file <tmp> [--resolve]` (resolve only where the draft says `resolve: yes`), per conversation reply `node $S/pr-feedback.mjs comment <dir> <pr url> --body-file <tmp>`. Then Review lessons (below). |
| `done` / `verified` / `reviewed` | Report (below). Close-out per `C`: upload `<dir>/evd/`, fill `<evd:FILE>` links in the drafts, show drafts; post only after the user approves the text. |
| `triaged` (feedback `--check`) | Show `<dir>/feedback-triage.md` as a short table (id · reviewer · point · P · verdict · reason) and ask whether to run `/tf:address-review` without `--check`. |
| `approve` | Show the plan summary (`<dir>/plan.md`) and ask for approval; on yes relaunch with `approved: true`. |
| `escalate` | One `🛑` line with the PM's question and options. After the answer relaunch with the same args, the answer in `notes`. The PM resumes from board.md. |
| `handoff` | Token budget low — relaunch in a new session with the same args. |
| `error` | Report the failing stage; relaunch once; then escalate. |

**Review lessons** (config `Review lessons` file): when this round answered human review points rated
P0–P2 (or a reviewer BLOCK), add one generalized rule per new pattern to that file (≤ 60 lines total,
merge duplicates, keep the source tag). Devs and reviewers read it before every job.

**Report** (report language, plain): PR links (ready), case table (case · result · evidence), the PM's
assumptions (so the user can correct them), findings outside scope, review verdict (review mode),
then the run's cost from `metrics.mjs`: wall time, minutes per role, jobs, re-tests, tokens — plus the one or two
slowest jobs with their slowest command when a job took over 10 minutes.

## Hard rules

- Never edit, format, or patch repo files — even a lint fix goes back to a dev job.
- Never merge, approve, force-push, or enable auto-merge. PRs stop at the link.
- Never commit `.pipeline/`, `.codegraph/`, `.env*`, scratch files.
- Never touch the shared main checkouts — work happens in the task worktrees.
- One ticket = one `.pipeline/<SLUG>/` folder and one `.worktrees/<SLUG>/` folder (one subfolder per repo, named like the repo folder), for every mode and round.
- Browsers and emulators: only ones this task started (`browser.mjs`, `emulator.mjs`). You read and
  post on the tracker through `browser.mjs` too.
- Nothing is posted (ticket, PR comment) without the user's approval of the exact text.
- Report outcomes plainly; no filler.
