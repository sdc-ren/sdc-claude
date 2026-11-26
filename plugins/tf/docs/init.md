# tf — init (set a workspace up for tf)

Loaded by `/tf:init`, and by the orchestrator when a workspace has no config. `<PLUGIN>` is the plugin root,
`<cwd>` the workspace root. Reply in the user's language. Nothing is installed, indexed or written before the user
says yes; one question per kind of change is enough.

`I` = `node <PLUGIN>/scripts/init.mjs` · `K` = `node <PLUGIN>/scripts/knowledge.mjs`

## Flags
`--dry-run` (report and show what would be written; write nothing) · `--yes` (write without asking; never
installs or indexes) · `--from <config file>` (take the wording of the shared sections — Language, Test policy,
Hard rules, Escalation additions, Close-out, Doctor — from another workspace's config on this machine; never its
repos, servers, flows, sources or knowledge, and never write that file's path anywhere) · `--refresh` (only
refresh the knowledge maps: the config's `Generate` for the stale ones, then its `Check`).

## Steps

1. **Look** — `I report <cwd>`. Show, in a few lines: the shape (one repo / several), each repo (key, stack,
   package manager, base branch, index yes/no), the config (found or not), the knowledge (none / tf's / the
   workspace's own generator), the case:
   - **A** no config, no knowledge → a new config and tf's knowledge folder.
   - **B** a config and the workspace's own knowledge generator → **only connect**: tf's lines go at the top of the
     config's `## Knowledge`, pointing at that generator; nothing else in the config changes, nothing is asked again.
   - **C** a config, no knowledge (or tf's) → add the Knowledge lines, create tf's knowledge folder.
   - **D** knowledge, no config → a new config whose Knowledge lines point at it.
   Then the gaps it lists (tools not installed, repos without an index, no `AGENTS.md` next to `CLAUDE.md`, `gh`
   not signed in, no Playwright package) — say each in one line.
2. **Draft** — `I draft <cwd> [--from <file>]`. Case B/C: show the diff lines as they are (`+ n: …`). Case A/D: show
   the new config's Repos table, Servers, Checks and Knowledge, and list the lines marked `⚠` — those are guesses.
   Ask the user *(host: ask)* only what detection cannot know and the config needs: the report language and the
   writing language; the test policy (e2e-only / unit-for-logic / full); the tracker (Jira, GitHub issues, none —
   and its URL). Put the answers in the draft text before writing (edit the file after `apply`).
   `--dry-run` stops here.
3. **Write** — on the user's yes (or `--yes`): `I apply <cwd> [--from <file>]`. It writes the config (a new one to
   `.tf/config.md`; an existing one where it is), adds tf's folders to `.git/info/exclude` when the workspace is
   one repo (the project's `.gitignore` is not touched), creates the hand-kept notes (`pipeline/*.md`) and
   generates tf's maps (not in case B). Then fill in the answers from step 2 and remove the `⚠` marks the user
   confirmed. Show the `done` lines.
4. **Close the gaps the user wants closed** — one question for the list, then only what they said yes to:
   - a repo without a code index, the tool installed → `codegraph init -y <repo>` per repo, in the background
     *(host: background)* (a large repo takes minutes); `.codegraph/` goes to that repo's `.git/info/exclude`
     (`apply` already did it for repos indexed before).
   - the tool not installed → say how to install it and stop there; never install it yourself.
   - `AGENTS.md` missing (the user runs Codex) → write a one-line `AGENTS.md`: `Read CLAUDE.md in this folder.`
5. **Check** — `K check <cwd>` for tf's maps (case B: the config's `Check`), then `node <PLUGIN>/scripts/doctor.mjs
   <cwd>`. Report what is ready and what is still open, in one short list.

## Hard rules
- Never overwrite a config section the user wrote; `apply` only adds tf's Knowledge lines to an existing config.
- Never write into a `knowledge/` folder tf did not create (`apply` picks `.tf/knowledge/` then, and says so).
- Never install a tool, index a repo or write `AGENTS.md` without the user's yes for that item.
- The `--from` file is read, not copied: no name, path or content from it beyond the shared sections' wording.
