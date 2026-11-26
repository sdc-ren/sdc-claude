Host notes (GitHub Copilot CLI) — how the *(host: …)* steps of tf's docs are done here:
- **ask**: write the questions in your reply (numbered, each with its options, the recommended one first) and end
  your turn; go on when the user answers.
- **open a file**: give its path.
- **session title**: skip.
- **attachments**: not available on Copilot — say so in one line when the input has `--attach` or a claude.ai link.
- **run the executor**: write the args as JSON to `<dir>/run-args.json`, then
  `node <PLUGIN>/hosts/copilot/run.mjs start <dir>/run-args.json` (the run goes on in the background; every job is
  its own `copilot -p`). Then `node <PLUGIN>/hosts/copilot/run.mjs wait <dir>` again and again — each call shows
  what happened since the last one (relay the `scope:` line) — until it prints `RESULT {…}`: that JSON is the
  run's result. The copy of the engine `task.mjs engine` writes is not used here. `agentPrefix`: `"tf:"`.
- **metrics**: skip (the run log is `<dir>/run/log.txt`).
- **background**: start it with `&`, its output to a file under `<dir>/tmp/`, and check that file later.
