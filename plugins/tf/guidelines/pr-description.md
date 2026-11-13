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

## Notes
- Breaking changes, risks, rollback, where reviewers should look, screenshots for UI
```

## Rules

- Summary, Why, Changes, Testing are required. Drop `Ticket:`, Deploy, Notes when empty — no "N/A",
  no leftover `<!-- -->` comments.
- Testing lists only checks that ran; say plainly what was not tested and why. With acceptance
  criteria, one line per criterion with its evidence. No decorative checkboxes.
- Deploy is derived from the diff (env files, migrations, seeders, scripts, workers, CI), never memory.
- Other tickets/PRs: full URL, never a bare `#123`. Related PR in another repo: `Related: <URL>`
  under the Ticket line.
- Never invent context, metrics, links, or results. Missing essential context → ask.
- Headings stay English; content follows the writing language. No agent attribution.
