# task-flow config — <workspace name>

Read by the SDC tf plugin (/tf:* commands) and every tf:* agent. Workspace rules here override agent defaults.
Keep sections short; link to longer docs instead of copying them.

## Language (the plugin reads this per workspace; nothing in CLAUDE.md is needed)
- Report language: <en | vi | …> — reports, escalations, `.pipeline/` files.
- Writing language: <en | vi | …> — commits, PRs, reviews, ticket comments (the plugin's `guidelines/`).

## Repos (the PM inspects every one and picks what the task touches)
| key | path | base branch | package manager | lockfile → reusable dirs | conventions to read |
|---|---|---|---|---|---|
| be | `backend/` | `develop` | npm | `package-lock.json` → `node_modules` | `backend/CLAUDE.md` |

## Excluded (never inspected, never changed)
- `<path>/` — <why>

## Read-only zones (read, search, call existing functions — never edit; an edit needed here → escalate)
- `<path or glob>` — <owner / why>

## Test policy
- <e2e-only | unit-for-logic | full> — what verification means here; whether new unit tests are allowed.

## Team agreements (agreed with the team's human reviewers — the team layer of guidelines/review-standard.md)
<!-- Only what the reviewers agreed to; a rule they keep reviewing against is not an agreement yet. Link this
     section from each repo's CLAUDE.md so people read the same text. -->
- <e.g. Tests: e2e flows for behaviour; unit tests for pure functions and validators — agreed with <reviewer>, <date>>
- <e.g. No new env keys in BE PRs; tunables are constants>
- <e.g. Contract changes: BE PR merges first; the FE/App PR bodies say so>

## Checks (existing tests — run by the dev lead before it reports and checked by the gate; never new tests)
| repo | command (scoped to the touched modules when the runner can) | notes |
|---|---|---|
| be | `<e.g. npx jest test/unit/services>` | <known red suites on the base branch, time it takes> |
No row for a repo → its test script from the repo `CLAUDE.md` / package file when it runs in a few minutes; none → skipped, said so in the PR.

## Escalation additions (on top of the PM's built-in bar)
- <extra cases that must stop for the user, or "none">

## Sources (optional — any link works without a line here; a line says how to read a host that needs it)
- <name>: <URL or host> — <tracker | docs | design | spec> — <how to read: connector, `browser.mjs auth <name> --url <URL> --playwright <package.json>`, or public fetch> [— keys: PROJ, OPS]
- e.g. jira: https://acme.atlassian.net — tracker — `browser.mjs auth jira …` — keys: PROJ
  (Jira is then read and posted with `scripts/jira.mjs … --site https://acme.atlassian.net --auth jira`.)
- e.g. notion: notion.so — docs — Notion connector
- Spec sources the PM may query: <NotebookLM notebook, docs paths>

## Chat sources (optional — chats `/tf:digest` reads; `/tf:digest all` reads every line)
- <name>: zalo <conversation id, e.g. g1705741417791397411> — <what the chat is about, what to watch for>

## Design & artifacts (optional — the `@` list already finds this workspace's items itself)
- Design system: <title — https://claude.ai/artifact/…>   (pin a default, also listed under `@`)

## Knowledge (PM reads the entry first; jobs get their slices; the orchestrator writes only pipeline/)
<!-- `/tf:init` writes these lines. A workspace with its own generator puts its commands here instead. -->
- Entry: `knowledge/README.md`
- Generate: `node <PLUGIN>/scripts/knowledge.mjs gen <root>`
- Check: `node <PLUGIN>/scripts/knowledge.mjs check <root>`
- Refresh: when needed   (or: before a run)
- Diff: <optional: a contract-diff command with <SLUG>>
- Topics: <optional: comma-separated words the ledger is sliced by; default: the repos' domain folders>
- Ledger: `knowledge/pipeline/` (findings, decisions, env-recipes, review-lessons — hand-kept)
- Code index: codegraph
- API prefix: <optional: the prefix routes and calls may differ by, e.g. /api/v1>
- API clients: <optional: names of your own API call helpers tf should read, e.g. apiFetch, http>
- State enums: <optional: regex an enum's name must match to be in the states map; default status|state|phase|stage|step>
- Feature tags: <optional: comment tags the features map reads, e.g. @screen, @api, @role; default @feature, @screen, @role>
- Review lessons: `knowledge/pipeline/review-lessons.md` — rules learned from human PR reviews, each led by its
  category tag (`[M1]`…, see guidelines/review-standard.md); devs and reviewers read it before every job.

## Flows (e2e)
- Playwright package: `<path>/package.json` (`--playwright` / `PLAYWRIGHT_FROM`).
- Targets: `local` = the task's own ports; `dev` = <shared dev URL, or "not allowed">.
- Accounts: <where test credentials come from (env names, seed files)>.
- Login recipe: <path#section>.
- Flow library: `.pipeline/_lib/` (default; shared helpers every task's flows import — login, seeding; the tester keeps its `README.md`). Other helper module flows may import: <path, or "none">.
- Web viewport: <e.g. 1440x900>. Android: AVD `<name>`, appId `<id>`. iOS: <recipe or "out of scope">.

## Servers (`serve.mjs` starts them once per run; jobs reuse them; `end-run` stops them)
<!-- Flows seed data through the API many times a minute: put the app's rate-limit maxima high in the task
     servers' env here (only these local servers get it). A limiter that ignores the global switch still counts. -->
Placeholders: `{port}` `{port:<server>}` `{db}` `{cache}` `{wt}` `{root}` `{slug}` `{dir}` (from the task's
resources). `"optional": true` = only when named. Put every env override the local app needs here
(feature flags off, dry-run senders) so no job composes a start command by hand.
```json
{
  "be": { "dir": "<backend dir>", "port": true, "cmd": "<dev command>", "timeout": 120,
          "env": { "PORT": "{port}", "<DB env>": "{db}" }, "health": "http://localhost:{port}/health" },
  "fe": { "dir": "<frontend dir>", "port": true, "cmd": "<dev command> --port {port}",
          "env": { "<API url env>": "http://localhost:{port:be}" }, "health": "http://localhost:{port}/" }
}
```

## Provisioning (setup job follows this; register every resource with `resources.mjs add`)
For `worktree`, `port`, `server`, `browser` and `emulator` tf frees the resource itself from its id (register
them with `--kind` and `--id` only). For every other kind the `--release` / `--stop` cell is the list of
commands that may run: write each as one backticked command with `<placeholders>` for the values (one plain
word each). A stored command that is not one of them is kept and shown by `/tf:clean`, never run on its own.
Allocate first, then `add`: it refuses (exit 3, `held: … by task <slug>`) an id another task already holds
(any kind but `server`) — pick the next free one and `add` again.
| kind | allocate | `--release` | `--stop` |
|---|---|---|---|
| worktree | path `<root>/.worktrees/<SLUG>/<repo dir>` (from `task.mjs resolve`); reuse it if it exists; else `node pool.mjs take <root> <key> <repo> <path> --branch <branch> --base <base> --lock <lockfile>` (warm pool); else `git -C <repo> fetch origin` → `git -C <repo> worktree add -b <branch> <path> origin/<base>`; copy `.env`; deps: `node fastdeps.mjs <repo> <path> --lock <lockfile> --dirs <dirs>`, install only when it prints `cloned:false` | `git -C <repo> worktree remove --force <path>` | — |
| db | <clone recipe> | <drop recipe> | — |
| cache | <pick an empty db index> | <flush that index> | — |
| port | <free port check> | `node <plugin>/scripts/platform.mjs free-port <p>` (macOS, Linux, Windows) | same |

Forbidden: <ports / databases / checkouts nobody may touch>.

## Tool-touched files (optional — rewritten by tools on their own, never part of a change)
Repo-relative paths. tf puts them back as committed before the gate reads the diff and before a worktree is
checked for unsaved work; without this a worktree that only a tool dirtied is never freed.
- `<path>` — <which tool changes it and how>

## Doctor (checked by `/tf:status --doctor`; add `(optional)` to only warn)
- `<shell command>` — <label>

## Hard rules
- <process-kill rules, data that must never be mutated, browser rules, screenshot budget>

## Close-out (orchestrator)
- Evidence upload: <where `.pipeline/<slug>/evd/` goes and how `<evd:FILE>` links are filled>.
- Posting: <how an approved ticket comment / PR comment is posted>.
- Knowledge ledger format: <findings / recipes / decisions lines>.
