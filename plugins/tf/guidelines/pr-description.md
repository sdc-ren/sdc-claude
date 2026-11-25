# PR description

For the reviewer: what changed, why, how it was verified, readable in under a minute.

```markdown
Ticket: [SCRUM-132](<full ticket URL>)

## Summary
1–3 sentences: what this PR changes.

## Why
The problem or requirement. Link context; do not copy the ticket.

## Changes
- 2–5 bullets of behavior/technical changes, not a file list

## Testing
- What was actually run, with results (commands, suites, scenarios)

## Deploy
- Env vars, migrations, seeds, manual commands, restarts needed besides merging

## Security
- Only for a security-sensitive change (auth, permissions, locks, money, audit, migrations): what it
  touches, how access is checked and audited, the scan result and the scanners that did not run

## Notes
- Breaking changes, risks, rollback, where reviewers should look, screenshots for UI
```

## Rules

- Summary, Why, Changes, Testing are required. Drop `Ticket:`, Deploy, Security, Notes when empty — no "N/A",
  no leftover `<!-- -->` comments.
- Testing lists only checks that ran; say plainly what was not tested and why. With acceptance
  criteria, one line per criterion with its evidence. No decorative checkboxes.
- Logic the PR adds (validator branches, limits, modes, ordering): list `branch → flow case → result` under
  Testing, so the reviewer sees what covers each branch without asking. When the workspace test policy
  forbids new unit tests, say so in one line there. Existing tests: the command that ran and its result,
  with failures that also fail on the base named as such.
- Deploy is derived from the diff (env files, migrations, seeders, scripts, workers, CI), never memory.
- Other tickets/PRs: full URL, never a bare `#123`. Related PR in another repo: `Related: <URL>`
  under the Ticket line.
- Never invent context, metrics, links, or results. Missing essential context → ask.
- Headings stay English; content follows the writing language. No agent attribution.
