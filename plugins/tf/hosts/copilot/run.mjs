#!/usr/bin/env node
// tf — GitHub Copilot host: runs the engine with every job as `copilot -p` (runtime/runner.mjs for the commands).
//   node <plugin>/hosts/copilot/run.mjs start <task dir>/run-args.json
//   node <plugin>/hosts/copilot/run.mjs wait <task dir>
import { fileURLToPath } from 'node:url'

import { isMain } from '../../core/main.mjs'
import { runnerCli } from '../../runtime/runner.mjs'
import { copilotDriver } from './driver.mjs'

if (isMain(import.meta.url)) await runnerCli(fileURLToPath(import.meta.url), copilotDriver)
