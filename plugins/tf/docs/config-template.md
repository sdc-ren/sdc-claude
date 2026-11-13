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

## Escalation additions (on top of the PM's built-in bar)
- <extra cases that must stop for the user, or "none">

## Tracker and spec sources
- Ticket tracker: <URL> — `browser.mjs auth <name> --url <URL> --playwright <package.json>`
- Spec sources the PM may query: <NotebookLM notebook, docs paths, Figma>

## Design & artifacts (optional — the `@` list already finds this workspace's items itself)
- Design system: <title — https://claude.ai/artifact/…>   (pin a default, also listed under `@`)

## Knowledge (PM reads first; orchestrator updates at close-out)
- Known bugs: <path> · Verified env recipes: <path> · Decisions: <path>
- Review lessons: <path> — rules learned from human PR reviews; devs and reviewers read it before every job.

## Flows (e2e)
- Playwright package: `<path>/package.json` (`--playwright` / `PLAYWRIGHT_FROM`).
- Targets: `local` = the task's own ports; `dev` = <shared dev URL, or "not allowed">.
- Accounts: <where test credentials come from (env names, seed files)>.
- Login recipe: <path#section>.
- Flow library: `.pipeline/_lib/` (default; shared helpers every task's flows import — login, seeding; the tester keeps its `README.md`). Other helper module flows may import: <path, or "none">.
- Web viewport: <e.g. 1440x900>. Android: AVD `<name>`, appId `<id>`. iOS: <recipe or "out of scope">.

## Servers (`serve.mjs` starts them once per run; jobs reuse them; `end-run` stops them)
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
| kind | allocate | `--release` | `--stop` |
|---|---|---|---|
| worktree | path `<root>/.worktrees/<SLUG>/<repo dir>` (from `task.mjs resolve`); reuse it if it exists; else `node pool.mjs take <root> <key> <repo> <path> --branch <branch> --base <base> --lock <lockfile>` (warm pool); else `git -C <repo> fetch origin` → `git -C <repo> worktree add -b <branch> <path> origin/<base>`; copy `.env`; deps: `node fastdeps.mjs <repo> <path> --lock <lockfile> --dirs <dirs>`, install only when it prints `cloned:false` | `git -C <repo> worktree remove --force <path>` | — |
| db | <clone recipe> | <drop recipe> | — |
| cache | <pick an empty db index> | <flush that index> | — |
| port | <free port check> | `kill $(lsof -t -iTCP:<p> -sTCP:LISTEN) 2>/dev/null \|\| true` | same |

Forbidden: <ports / databases / checkouts nobody may touch>.

## Doctor (checked by `/tf:status --doctor`; add `(optional)` to only warn)
- `<shell command>` — <label>

## Hard rules
- <process-kill rules, data that must never be mutated, browser rules, screenshot budget>

## Close-out (orchestrator)
- Evidence upload: <where `.pipeline/<slug>/evd/` goes and how `<evd:FILE>` links are filled>.
- Posting: <how an approved ticket comment / PR comment is posted>.
- Knowledge ledger format: <findings / recipes / decisions lines>.
