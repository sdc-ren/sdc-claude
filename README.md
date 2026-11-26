<div align="center">

# Claude Code plugins by SDC

**Agent teams and workflows for shipping real tickets with [Claude Code](https://code.claude.com).**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin%20marketplace-d97757)](https://code.claude.com/docs/en/plugins/install.md)
[![tf changelog](https://img.shields.io/badge/tf-changelog-2ea44f)](plugins/tf/CHANGELOG.md)

</div>

---

`sdc` is a Claude Code **plugin marketplace**. Add it once, then install the plugins you need. Each plugin
is self-contained: skills (slash commands), subagents, workflows, scripts and the guidelines they follow.

## Plugins

| Plugin | What it does |
|---|---|
| [**tf** — task-flow](plugins/tf/README.md) | A PM agent plans each task, staffs dev / tester / reviewer agents, keeps re-runnable e2e flows, and ships **ready** PRs with evidence — from a ticket, any link, or plain words. |

Versions and release notes: [plugins/tf/CHANGELOG.md](plugins/tf/CHANGELOG.md).

### tf at a glance

You give it a ticket; it gives you a pull request that has been tested end to end:

```
/tf:build PROJ-123
```

The PM agent reads the ticket and the code and writes a plan, dev agents implement it in the task's own
worktrees, a tester runs the cases on the running app and saves the evidence, and a reviewer gates the diff
and opens the PR. It stops for you only when the ticket has two plausible readings or the task is large.

| Command | Use it to |
|---|---|
| `/tf:build` | Do a new task end to end |
| `/tf:qc` | Answer a QC report on a task tf already did |
| `/tf:address-review` | Check and answer the team's review on the PRs tf pushed |
| `/tf:review` | Review a teammate's PR by reading the code |
| `/tf:e2e` | Approve the test cases, then run exactly those (bugs marked on the screenshots), or the regression suite |
| `/tf:demo` | Turn a design canvas into a clickable demo for a client |
| `/tf:digest` | Summarise your Zalo group chats: what was decided, what is open, what needs you |
| `/tf:init` | Set a workspace up (or connect one that has its own setup): config, knowledge maps, code index |
| `/tf:status` | See what tasks hold; check the machine (`--doctor`) |
| `/tf:clean` | Free the resources of finished tasks |

Every command, option and the way the team works: [plugins/tf/README.md](plugins/tf/README.md).

## Requirements

- Claude Code with Workflows enabled, or the Codex CLI (see [Codex](#codex)), or — not tried yet — GitHub
  Copilot CLI (see [GitHub Copilot](#github-copilot-not-tried-yet)).
- Node ≥ 22, git, and `gh` logged in.
- For e2e: a package in your workspace that depends on `@playwright/test`.
- macOS, Linux or Windows (Git for Windows). A whole ticket run has only been done on macOS so far.

Details: [plugins/tf/README.md#requirements](plugins/tf/README.md#requirements).

## Installation

Inside Claude Code:

```
/plugin marketplace add sdc-ren/sdc-claude
/plugin install tf@sdc
```

Or from a terminal:

```bash
claude plugin marketplace add sdc-ren/sdc-claude
claude plugin install tf@sdc
```

> **Private repository?** Claude Code uses your machine's git credentials and never prompts.
> Run `gh auth login` and `gh auth setup-git` first (or make sure your SSH key works without a passphrase prompt).

### Codex

The same marketplace installs tf in [Codex](https://developers.openai.com/codex) (checked with Codex CLI 0.155):

```bash
codex plugin marketplace add sdc-ren/sdc-claude
codex plugin add tf@sdc
```

Start a new Codex session, then call a command with `$`: `$tf:build PROJ-123`, `$tf:review <PR url>`,
`$tf:status --doctor`. The commands never start on their own (`allow_implicit_invocation: false`).

On Codex every job of a run is its own `codex exec` in Codex's sandbox (workspace-write, network on, your repos'
`.git` writable, approvals reviewed by Codex's automatic reviewer), started in the background by
`hosts/codex/run.mjs`. Not on Codex: `/tf:demo`, `/tf:digest` and attachments (they read claude.ai artifacts or
drive Claude in Chrome), and run metrics. More in [plugins/tf/README.md](plugins/tf/README.md#other-coding-agents).

### GitHub Copilot (not tried yet)

Copilot CLI reads Claude Code's plugin and marketplace layout, so the same marketplace should install tf:

```bash
copilot plugin marketplace add sdc-ren/sdc-claude
copilot plugin install tf@sdc
```

Then call a command from `/skills list` (for example `/build PROJ-123`). Jobs run as `copilot -p` in the
background (`hosts/copilot/run.mjs`). This host is written from Copilot CLI's documentation and has not run
against a real Copilot yet: tell us what breaks.

### Use it in a project for the whole team

Commit this to the project's `.claude/settings.json` so everyone who opens the project is offered the plugin:

```json
{
  "extraKnownMarketplaces": {
    "sdc": { "source": { "source": "github", "repo": "sdc-ren/sdc-claude" } }
  },
  "enabledPlugins": { "tf@sdc": true }
}
```

Each teammate still installs once: `claude plugin install tf@sdc --scope project`.

### First run

In your workspace (the folder that holds your repos):

```
/tf:init              # detects the repos, stacks and tools; writes the config and the knowledge maps
/tf:status --doctor   # checks tools, gh login, config, repos, Playwright, devices, knowledge, code index
/tf:build PROJ-123
```

## Updating

```bash
claude plugin marketplace update sdc
claude plugin update tf@sdc
```

Restart Claude Code to load the new version. Release notes: [plugins/tf/CHANGELOG.md](plugins/tf/CHANGELOG.md).

## Repository layout

```
.claude-plugin/marketplace.json   marketplace "sdc" — lists the plugins below
plugins/
  tf/                             task-flow plugin: shared code and prompts, plus hosts/<agent>/ for
                                  Claude Code (.claude-plugin/), Codex (.codex-plugin/) and Copilot
LICENSE                           MIT
```

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately
([SECURITY.md](SECURITY.md)), never in a public issue.

1. Fork and branch: `<type>/<summary>` (see [git guidelines](plugins/tf/guidelines/git.md)).
2. Keep each plugin self-contained; reference bundled files with `${CLAUDE_PLUGIN_ROOT}`.
3. Validate before opening a PR:
   ```bash
   claude plugin validate .
   claude plugin validate plugins/tf
   claude plugin test plugins/tf                # the Artifacts band
   node --test plugins/tf/tests/*.mjs           # what CI runs on macOS, Linux and Windows
   ```
4. Bump the plugin's `version` in `plugins/<name>/.claude-plugin/plugin.json` and add a CHANGELOG entry.

## License

[MIT](LICENSE) © 2026 SDC (Dang Chi Son)
