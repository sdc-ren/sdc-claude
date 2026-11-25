# Security policy

tf runs agents that edit code, run commands, push branches, open pull requests and post comments in your
trackers. A flaw in its guard (`plugins/tf/hooks/guard.ts`), its scripts or its prompts can therefore reach your
repositories and accounts. Please report such flaws privately.

## Reporting a vulnerability

Use **Security → Report a vulnerability** on this repository (GitHub private vulnerability reporting). Do not
open a public issue, pull request or discussion for it.

Please include:
- the plugin version (`plugins/tf/.claude-plugin/plugin.json`) and your OS;
- what an agent or script could do that it should not, and how to reproduce it (a ticket text, PR comment or
  page that makes an agent act on it is in scope);
- logs with secrets, tokens, cookies and personal data removed.

You will get an answer within 7 days. A fix ships as a patch release, credited in the CHANGELOG unless you ask
otherwise.

## Supported versions

Only the latest release on `main` gets fixes. Update with
`claude plugin marketplace update sdc && claude plugin update tf@sdc`.

## In scope

- An agent pushing, merging, posting or editing outside what its role allows, or getting past `guard.ts`.
- Saved logins (`~/.claude/task-flow/auth`) read, copied or sent anywhere.
- Text from a ticket, PR, web page or chat that makes an agent run commands or leak data (prompt injection).
- Secrets written to logs, metrics, evidence files, PR bodies or ticket comments.
- Command or path injection through config recipes, slugs, branch names or script arguments.

## Out of scope

- Vulnerabilities in Claude Code itself; report them to Anthropic.
- Findings in your own project that tf's security scan missed. Open a normal issue with a minimal example
  instead.
