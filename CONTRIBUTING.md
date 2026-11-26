# Contributing

Thanks for helping. Bug reports, platform reports (Linux and Windows full runs especially) and small focused
pull requests are all welcome.

## Before you start

- For a bug, open an issue with the plugin version, OS, the command you ran and the end of the run's log.
- For a new feature or a change to an agent's rules, open an issue first: the prompts are tuned together, and a
  rule added in one place often costs tokens or time in every run.
- Security issues: see [SECURITY.md](SECURITY.md), never a public issue.

## Layout

Everything for the plugin lives in `plugins/tf/`. The code is layered so it can run on more than one coding
agent ([plans/tf-architecture.md](plans/tf-architecture.md)); imports only point down this table, and
`tests/boundaries.mjs` checks it:

| Folder | What it holds |
|---|---|
| `hosts/claude/` | what only Claude Code has: its transcripts, artifacts, `doctor`, `metrics`, the `tf` entry point with those commands |
| `cli/` | `tf <command>`: one entry point for every module's command line |
| `modules/<domain>/` | the Node helpers the agents call, one folder per domain (task, resources, worktree, env, browser, e2e, review, vcs, tracker, chat, design) |
| `core/` | what everything shares: platform, paths, config, naming and guard rules. Names no coding agent |
| `scripts/` | the old entry points, kept as one-line re-exports so prompts and saved commands keep working |
| `agents/` | the role prompts (PM, lead, dev, tester, reviewer) |
| `engine/task-flow.js` | the workflow executor and its hard rules |
| `skills/` | the `/tf:*` commands |
| `guidelines/`, `docs/` | the standards and the per-mode instructions agents read |
| `hooks/` | Claude Code's hooks module: the tool-use guard (rules in `core/guard-rules.mjs`) and the Artifacts band |
| `tests/` | `node --test` suites, plus `guard.test.ts` for the hook |

No npm dependencies anywhere. New code goes in `core/` or `modules/`, never in `scripts/`.
[plugins/tf/docs/design.md](plugins/tf/docs/design.md) explains the roles, hard rules and files.

## Making a change

1. Node ≥ 22. No `npm install` is needed.
2. Validate and run the suites (CI runs the `node --test` ones on macOS, Linux and Windows):

   ```bash
   claude plugin validate .
   claude plugin validate plugins/tf
   claude plugin test plugins/tf                # guard.test.ts and the Artifacts band
   node --test plugins/tf/tests/*.mjs
   ```

3. Prompts are read by every run: keep additions short, put mode-specific text in `docs/` and load it only in
   that mode, and say in the PR how much the prompt grew.
4. Use no real customer names, ticket keys, people or paths in examples or tests. Use `PROJ-123`,
   `acme.atlassian.net` and `/w/...`.
5. User-visible changes go in `plugins/tf/CHANGELOG.md`, and the version is bumped in
   `plugins/tf/.claude-plugin/plugin.json`.
6. Commits and PR titles follow [plugins/tf/guidelines/git.md](plugins/tf/guidelines/git.md)
   (`<type>(<scope>): <summary>`, English).

CI runs the suites on Linux, macOS and Windows; a PR needs it green.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
