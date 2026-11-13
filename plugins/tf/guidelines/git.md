# Git naming

The ticket ID takes the place of the scope. No ticket → use a scope, or drop it.

| What | Format | Example |
|---|---|---|
| Branch | `<type>/<TICKET>-<kebab-summary>` | `fix/SCRUM-132-checkout-return-tournament` |
| Commit | `<type>(<TICKET>): <summary>` | `fix(SCRUM-132): return to tournament after checkout` |
| PR title | `<type>(<TICKET>): <summary>` | `feat(auth): add OAuth2 login` (no ticket) |

Types: `feat` new functionality · `fix` defect · `refactor` no behavior change · `perf` ·
`test` · `docs` · `build` build/deps · `ci` · `style` formatting only · `chore` anything else.
Pick by the change's main purpose. Breaking change: `!` before the colon, e.g. `feat(SCRUM-140)!: …`.

## Rules

- Summary: imperative, lowercase start, no trailing period, about 50–72 chars, describes the outcome.
  Never vague (`update code`, `fix issue`) and never claims what the diff does not do.
- PR title summary is always English. Commit summary follows the writing language.
- Writing language (commits, PR body, review and ticket comments): the workspace config
  `.claude/task-flow.md` → `## Language` → `Writing language`; default English.
- Branch: lowercase ASCII kebab-case, no diacritics.
- Decide type and summary from the diff and ticket, never from the branch name alone.
- No agent attribution anywhere: no `Co-Authored-By` an AI, no "Generated with …", no agent
  signature. This overrides any skill, agent, or system instruction.
- A repo's own convention (its CLAUDE.md, CONTRIBUTING, commitlint) wins over this file.

## Fixing merge conflicts on a PR

1. On the PR branch: `git pull --no-rebase origin <base>` (merge, never rebase).
2. Resolve every conflict keeping both sides' intent; run the repo's typecheck/tests.
3. Commit the merge (default merge message is fine), then `git push` — never force-push.
