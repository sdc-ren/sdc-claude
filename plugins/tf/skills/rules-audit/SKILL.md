---
name: rules-audit
description: Read every instruction file this workspace loads (global and workspace CLAUDE.md/AGENTS.md, repo CLAUDE.md, the tf config, memory) and report contradictions, duplicates, rules in the wrong place, stale references and text worth cutting — with a proposed fix per finding, applied only to the ones the user picks.
argument-hint: "[<topic>]"
disable-model-invocation: true
---

Not in Claude Code? When the plugin root and the input below still read as variables, `<PLUGIN>` is the folder that holds this file's `skills/` folder, the input is what the user wrote with the command, and the host notes are `<PLUGIN>/hosts/<agent>/notes.md` for the agent you run in (`codex`, `copilot`), not the Claude Code ones.

Input: `$ARGUMENTS` (optional topic, e.g. `git` or `jira`: then only rules about it). `<cwd>` is the workspace root
(the folder that holds `.claude/task-flow.md`).

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/rules.mjs inventory <cwd>` and `node ${CLAUDE_PLUGIN_ROOT}/scripts/rules.mjs check <cwd>`. Show the
   inventory table (scope, words, path) and the check's warnings as they print.
2. Read every file of the inventory in full. Where a workspace rule covers what a tf guideline covers (git,
   PR descriptions, ticket comments, e2e, review), read that guideline in `${CLAUDE_PLUGIN_ROOT}/guidelines/` too.
3. Find, quoting `file:line` for every claim:
   - **Contradiction** — two places say different things on one topic (a recipe, a tool, a do/don't). Quote both.
   - **Duplicate** — one rule written in two places. Keep it where its scope fits; the other becomes a pointer or goes.
   - **Wrong place** — a global rule about one project; a project rule that is the user's general preference
     (belongs in global); a rule tf runs need that sits only in memory (agents read the config, not memory);
     a tf-only rule in a CLAUDE.md every session loads.
   - **Stale** — names a script, option, path, account or person that is no longer right. Check before claiming:
     `ls`, `grep`, `--help`, the check's dead-reference warnings.
   - **Cut** — history, narration, examples repeated, long "why" text in a file every session loads. Never cut
     the reason of a decision the user made; shorten it.
4. Report one table per kind: `#`, files:lines, the finding in one line, the proposed fix in one line, words
   saved. Then the totals: words in every session now → after the fixes. Nothing found → say so and stop.
5. Ask which rows to apply *(host: ask)*, several at once allowed. A contradiction is applied only with the side
   the user picks — never choose it yourself. Edit only the files the user owns (global, workspace, repo, config,
   memory); a fix to a tf file under `${CLAUDE_PLUGIN_ROOT}` is a plugin change: list it for a PR, do not edit it. Moving or
   deleting a memory file keeps `MEMORY.md` in step; deleting one needs its own yes.
6. Run step 1 again and show the words before → after.

Reply in the user's language.
