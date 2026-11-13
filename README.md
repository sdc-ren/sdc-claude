<div align="center">

# Claude Code plugins by SDC

**Agent teams and workflows for shipping real tickets with [Claude Code](https://code.claude.com).**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin%20marketplace-d97757)](https://code.claude.com/docs/en/plugins/install.md)
[![tf](https://img.shields.io/badge/tf-v1.1.0-2ea44f)](plugins/tf/CHANGELOG.md)

</div>

---

`sdc` is a Claude Code **plugin marketplace**. Add it once, then install the plugins you need. Each plugin
is self-contained: skills (slash commands), subagents, workflows, scripts and the guidelines they follow.

## Plugins

| Plugin | Version | What it does |
|---|---|---|
| [**tf** — task-flow](plugins/tf/README.md) | 1.1.0 | A PM agent plans each ticket, staffs dev / tester / reviewer agents, keeps re-runnable e2e flows, and ships **ready** PRs with evidence. Commands: `/tf:build`, `/tf:qc`, `/tf:review`, `/tf:e2e`. |

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
  tf/                             task-flow plugin (skills, agents, workflow, scripts, guidelines, docs)
LICENSE                           MIT
```

## Contributing

Issues and pull requests are welcome.

1. Fork and branch: `<type>/<summary>` (see [git guidelines](plugins/tf/guidelines/git.md)).
2. Keep each plugin self-contained; reference bundled files with `${CLAUDE_PLUGIN_ROOT}`.
3. Validate before opening a PR:
   ```bash
   claude plugin validate .
   claude plugin validate plugins/tf
   claude plugin test plugins/tf                # the Artifacts band
   node --test plugins/tf/tests/engine.mjs      # the executor's hard rules, with mock agents
   ```
4. Bump the plugin's `version` in `plugins/<name>/.claude-plugin/plugin.json` and add a CHANGELOG entry.

## License

[MIT](LICENSE) © 2026 SDC (Dang Chi Son)
