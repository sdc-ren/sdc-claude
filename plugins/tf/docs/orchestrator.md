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
| `/tf:build <anything>` | build | PM plans → devs → reviewer gate → tester → ready PR(s), EVD, ticket-comment draft (when a tracker issue is the source) |
| `/tf:qc <task>` | qc | Next round on the same folder/branches: reproduce QC cases with saved flows, fix, re-test, update the PR |
| `/tf:address-review <task or PR url> [--check]` | feedback | Team review on our own PRs: fetch unresolved threads/reviews/comments, triage each point, fix only the `fix` points on the same PR, draft one answer per PR for the whole round (posted after approval). `--check`: triage only |
| `/tf:review <PR url or task>` | review | Static code review of someone else's PR: logic, impact on other parts, security, standards, typecheck/build. Nothing is run on the app (that is `/tf:e2e`). No code changes |
| `/tf:e2e <PR url or task> [--cases a,b]` | e2e | Tester only: run/save flows, EVD, ticket-comment draft (tracker source only). `--regression`: run `.pipeline/_regression` flows instead (no workflow) |
| `/tf:demo <canvas link> [words]` | — | No workflow: `<PLUGIN>/docs/demo.md` — a Design canvas → a clickable demo (every screen, grouped by role), local, `--publish` as one artifact |
| `/tf:status [--doctor] [--metrics [slug]]` | — | Resources per task and what cleanup would free (`resources.mjs list`, `reap --dry-run`); `--doctor` also runs `node $S/doctor.mjs <cwd>`; `--metrics` shows what runs cost (`metrics.mjs`) |
| `/tf:clean <slug> \| --migrate \| --legacy` | — | Free one task, move flat worktrees into `.worktrees/<SLUG>/<repo>/`, or fold old suffixed folders — dry run first, apply only after the user's yes |

`<task>` = anything that names an existing task: its key, its link, its folder slug, or the same words.

**Input** is whatever the user typed: an issue key (`PROJ-12`), a link to anything (tracker issue, PR, GitHub
issue, Notion/Google Docs/Confluence page, Figma, any web page, a claude.ai artifact, canvas or design system), a
local file path, plain words — or several of these at once. Plain words alone are a complete task: they become
the brief. `node $S/sources.mjs <cwd> "<input>"` splits it into `request` (the user's words) and `sources`
(kind + how to read each); step 6 reads them.

Flags: `--check` (feedback: triage only, no code), `--attach` (open the checkbox picker for this task, step 6b), `--approve` (stop after the first plan for the user), `--assume` (never stop for questions: the PM assumes and lists what it assumed), `--draft` (the user allows a draft PR),
`--lang <code>` (report language). There is no repo flag: the PM inspects every repo in the config.

Languages (per workspace, from `C` → `## Language`): `lang` = `--lang` → `Report language` → the user's
language; `writingLang` = `Writing language` → a `Writing language:` line in the workspace/repo CLAUDE.md →
`en`. Everything you tell the user uses `lang`; commits, PRs, reviews and ticket comments use `writingLang`.

## 1. Pre-flight (in order)

1. **Config** — read `C`. Missing → ask the user for repos, excluded and read-only paths, test policy,
   tracker, provisioning; write it from `<PLUGIN>/docs/config-template.md`; show it.
2. **Identity** — `node $S/task.mjs resolve <cwd> "<input>" [--name <name>]` (repos come from the config table;
   the slug is the PR's or issue's key, else `--name`, else the user's words, else the first link). It returns
   `slug`, `dir`, `round`, `nextRound`, `status`, `prs`, `worktrees`, `worktreePaths` (`.worktrees/<SLUG>/<repo dir>`),
   `oldLayout`, `legacyDirs`, `locked`, `format`. `oldLayout` non-empty → suggest `/tf:clean --migrate` once.
   Use exactly that slug and folder — never invent suffixes. `locked: true` → stop: another run holds
   it. `legacyDirs`/`legacyWorktrees` non-empty → mention once (`/tf:clean --legacy`), keep going.
3. **Lock** — `node $S/task.mjs lock <dir>`; conflict → stop and tell the user.
4. **Round** — `round = nextRound`. If it is a new round of an existing task folder (`format: current`):
   `node $S/task.mjs new-round <dir> <round>` (moves plan/board/jobs into `history/`).
5. **Housekeeping** — `node $S/resources.mjs register-root <cwd>`, `node $S/resources.mjs reap`;
   `node $S/fresh.mjs <path>:<base> …` for the config repos (report skipped checkouts in one line).
   Reaper missing (`node $S/reaper.mjs status` exits 1) → offer `node $S/reaper.mjs install` once (macOS launchd, Linux systemd timer or cron, Windows Task Scheduler; re-run it after a plugin update — it copies the reaper to a stable path).
6f. **Feedback mode instead of step 6** — no tracker read. PRs = every PR of the task from `resolve` (`prs`, open AND merged — the
   PM needs to know which may not be pushed to — plus the input PR URL). `node $S/pr-feedback.mjs fetch <dir> <pr urls…>` → `<dir>/feedback.md` + JSON summary.
   Nothing open (`total` 0, no new reviews or comments) → tell the user in one line and stop (unlock), no
   workflow. Otherwise show the summary line (PR · decision · open threads · new · waiting). A PR with `waiting`
   reviewers (asked, not reviewed yet): unless `--check`, ask with `AskUserQuestion` whether to wait for them
   (recommended — one round, one answer; then unlock and stop) or answer now. Then launch. A task without
   a tf folder (PR made by hand): `resolve` still gives the folder; the PM reads the PR diff instead of HANDOFF.
6. **Sources → brief** (not in feedback mode) — `node $S/sources.mjs <cwd> "<input>"`, then read each source by
   its kind. Hosts listed in `C` `## Sources` follow their line there (reader, sign-in) before these defaults:

   | kind | read with |
   |---|---|
   | `tracker` (key or tracker link) | the tracker line in `C` (own browser via `browser.mjs`; a connector when one is set up) |
   | `pr` | `gh pr view <url> --json title,body,headRefName,baseRefName,files` |
   | `issue` (GitHub) | `gh issue view <n> --repo <o/r> --comments` |
   | `artifact` | `docs/attach.md` — a canvas, a design system or a page; stored in `specs/` |
   | `figma` | the Figma connector when connected, else `browser.mjs` |
   | `doc`, `url` | a connector for that service when connected; else fetch the page (public) or `browser.mjs` (sign-in) |
   | `file` | Read it |

   Write `<dir>/ticket.md` — the task brief whatever the source (the name is kept for older tasks):
   `## Request` = the user's words verbatim (or "—"); then one `## Source: <kind> <ref>` per source except
   artifacts (those go to `specs/`, step 6b), with what it says verbatim (issue: description, every comment,
   attachments list, linked issues). A source that cannot be read (sign-in, no access) → one line saying so;
   go on with the rest, and stop only when nothing of the task is left to work from.
   Plain words only: `## Request` is the whole brief — the PM plans from it, the config and the code, and
   records what it had to assume.
   Later rounds: re-read every source, rewrite ticket.md (keep `## Clarifications` as it is), mark comments new or edited since the last round
   (`updated` vs `created`) under `## New since round <n-1>`. Human reviews on our PRs are handled by
   `/tf:address-review`, not here — if `pr-feedback.mjs fetch` would find open threads, mention it in one line.
   `tracker` = `hasTracker` from `sources.mjs` (a tracker issue or a GitHub issue is a source).
6b. **Attachments** — artifacts, canvases and design systems mentioned with `@` (`artifact://` resources) or
   pasted as claude.ai links in the command are attached: follow `<PLUGIN>/docs/attach.md` (read, store,
   record). `--attach` → run the Picker of attach.md first. `<dir>/attachments.json` from earlier rounds is
   reused silently.
7. **Session title** — `<SLUG>: <3–6 word summary>` (e.g. `PROJ-268: Fix OTP login timeout`) via `mcp__ccd_session_mgmt__set_session_title`
   (`session_id: "self"`; load via ToolSearch if deferred; missing → skip).

Do not ask the user which spec sources to use: the PM uses the config defaults, links in the brief, and the
task's attachments.

## 2. Launch

Copy the engine into the task folder and launch that copy (a script outside the session's folders is
rejected; the engine is deliberately not registered as a `/` command):
`node $S/task.mjs engine <dir> W --title "<the 3–6 word summary of step 7>"` → `script` (`<dir>/<SLUG>.js`, the
engine with the task id as the workflow's name, so `/workflows` lists `PROJ-268`, not one `task-flow` per run),
then `Workflow` with `scriptPath: <that script>`. Args:

```json
{ "root": "<abs cwd>", "slug": "<slug>", "dir": "<abs dir>", "mode": "build|qc|review|e2e",
  "round": <n>, "input": "<what the user typed>", "description": "<one line>",
  "sources": "<kinds read, e.g. tracker, doc, artifact>", "tracker": <hasTracker>,
  "cases": "<--cases or QC case ids>", "notes": "<user constraints / escalation answers>",
  "prs": { "<repo>": "<url>" }, "worktrees": { "<repo>": "<path or null>" },
  "worktreePaths": { "<repo>": "<from resolve>" }, "format": "<from resolve>",
  "flags": { "approve": false, "draft": false, "check": false, "assume": false }, "approved": false, "clarifyRound": 0,
  "lang": "<report language>", "writingLang": "<Writing language>",
  "scripts": "<abs S>", "config": "<abs C>", "agentPrefix": "tf:",
  "attachments": [ { "title": "…", "kind": "design-system|canvas|artifact|doc|url|file", "file": "<abs specs/… file>", "url": "…" } ] }
```

The user watches `/workflows`. Do not poll. The run logs a `scope:` line after the PM's first plan (repos
changed / not changed, cases, risky assumptions) — it is the user's early chance to stop a wrong plan; put it
in the Report as well.

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
| `done` (feedback) | Report the triage table, what was fixed (commits, PR links), then show `<dir>/feedback-replies.md`. Post only after the user approves the text (they may edit or drop blocks in the file): `node $S/pr-feedback.mjs post <dir> --dry-run` to show what goes where, then `node $S/pr-feedback.mjs post <dir>` — per PR one submitted review holding every thread reply with the Summary as its body (one notification, one conversation entry); `resolve: yes` threads are resolved after. Never post the round thread by thread; `reply` / `comment` are only for a single late answer. Then Review lessons (below). |
| `done` / `verified` / `reviewed` | Report (below). Close-out per `C`: upload `<dir>/evd/`, fill `<evd:FILE>` links in the drafts, show drafts; post only after the user approves the text. |
| `triaged` (feedback `--check`) | Show `<dir>/feedback-triage.md` as a short table (id · reviewer · point · P · verdict · reason) and ask whether to run `/tf:address-review` without `--check`. |
| `clarify` | The brief is not clear enough to plan; nothing has run. Ask the user every question with `AskUserQuestion` (≤ 4 per call, several calls when there are more): the question with its quote, the PM's options, the PM's own pick first and marked recommended. `who: po` questions get one more option, "Hỏi PO": for those, draft one tracker comment with the questions (posted only after the user approves the text), then unlock and stop — the next `/tf:build <task>` reads the PO's reply as a new comment. Append the answers verbatim to `<dir>/ticket.md` under `## Clarifications` (`Q<n> — question — answer`, dated; "PM decides" when the user says so), then relaunch with the same args and `clarifyRound` from the result. Repeat until the run returns another status: no job starts while a question is open. |
| `approve` | Show the plan summary (`<dir>/plan.md`) and ask for approval; on yes relaunch with `approved: true`. With `design` in the result (a size L task): show `scope`, then `design.md` in short — Data, Neighbours, Decisions, Risks and open points — then the plan's Requirements and the micro-task titles, and ask whether to build it; a change the user wants goes into `notes` and the relaunch runs WITHOUT `approved` so the PM redoes the design and it is shown again. Without `--approve` this status means the plan check and the PM still disagree: show `scope`, then each `planOpen` line next to the reviewer's point (`planCheck` file) and ask the user which reading is right; relaunch with `approved: true` and the answer in `notes`. |
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
- One task = one `.pipeline/<SLUG>/` folder and one `.worktrees/<SLUG>/` folder (one subfolder per repo, named like the repo folder), for every mode and round.
- Browsers and emulators: only ones this task started (`browser.mjs`, `emulator.mjs`). You read and
  post on the tracker through `browser.mjs` too.
- Nothing is posted (tracker comment, PR comment) without the user's approval of the exact text. No tracker
  source → there is nothing to post a ticket comment to; the Report carries the summary instead.
- Report outcomes plainly; no filler.
