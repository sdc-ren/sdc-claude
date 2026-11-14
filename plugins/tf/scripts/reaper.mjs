#!/usr/bin/env node
// tf reaper: a job of the operating system that runs `resources.mjs reap` every 30 minutes — it frees the
// resources of tasks whose PRs are all merged or closed, and prunes idle ones.
//
//   node reaper.mjs install      macOS: launchd agent · Linux: systemd user timer (cron when there is no
//                                systemd) · Windows: a Task Scheduler task
//   node reaper.mjs status       prints installed | not installed (exit 0 | 1)
//   node reaper.mjs uninstall
//
// Idle days before a task is pruned / an archived task deleted: TF_PRUNE_DAYS=10 TF_ARCHIVE_DAYS=30 at install.
// The plugin lives in a versioned cache that moves on every update, so the job runs a stable copy under
// ~/.claude/task-flow/reaper/. Run `install` again after a plugin update to refresh the copy.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OS, stateDir, which } from './platform.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LABEL = 'ai.claude.task-flow-reap'
const NAME = 'task-flow-reap'
const DIR = join(stateDir(), 'reaper')
const RUNNER = join(DIR, 'run.mjs')
const LOG = join(stateDir(), 'reap.out')
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const UNIT_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user')
const CRON_MARK = `# ${NAME}`

const run = (file, args, input) => execFileSync(file, args, { stdio: ['pipe', 'pipe', 'pipe'], input, windowsHide: true }).toString()
const quiet = (file, args, input) => { try { return { ok: true, out: run(file, args, input) } } catch (e) { return { ok: false, out: String(e.stderr || e.message) } } }
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const hasSystemd = () => !!which('systemctl') && quiet('systemctl', ['--user', 'show-environment']).ok

// The job starts with a bare environment: the runner puts node, gh and git back on PATH and sets the
// prune settings, then runs the copied resources.mjs as if it had been called with `reap`.
function writeRunner() {
  mkdirSync(DIR, { recursive: true })
  for (const f of ['resources.mjs', 'platform.mjs']) copyFileSync(join(HERE, f), join(DIR, f))
  const dirs = [dirname(process.execPath), which('gh') && dirname(which('gh')), which('git') && dirname(which('git'))].filter(Boolean)
  writeFileSync(RUNNER, [
    "import { delimiter, dirname, join } from 'node:path'",
    "import { fileURLToPath, pathToFileURL } from 'node:url'",
    `const extra = ${JSON.stringify([...new Set(dirs)])}`,
    "process.env.PATH = [...extra, process.env.PATH || ''].filter(Boolean).join(delimiter)",
    `process.env.TF_PRUNE_DAYS ||= ${JSON.stringify(String(process.env.TF_PRUNE_DAYS || 7))}`,
    `process.env.TF_ARCHIVE_DAYS ||= ${JSON.stringify(String(process.env.TF_ARCHIVE_DAYS || 30))}`,
    "const script = join(dirname(fileURLToPath(import.meta.url)), 'resources.mjs')",
    "process.argv = [process.argv[0], script, 'reap']",
    'await import(pathToFileURL(script).href)',
    '',
  ].join('\n'))
}

const installers = {
  macos: {
    install() {
      mkdirSync(dirname(PLIST), { recursive: true })
      writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(RUNNER)}</string></array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter))}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict></plist>
`)
      quiet('launchctl', ['unload', PLIST])
      run('launchctl', ['load', PLIST])
      return 'launchd agent'
    },
    status: () => quiet('launchctl', ['list', LABEL]).ok,
    uninstall() { quiet('launchctl', ['unload', PLIST]); rmSync(PLIST, { force: true }) },
  },
  linux: {
    install() {
      if (hasSystemd()) {
        mkdirSync(UNIT_DIR, { recursive: true })
        writeFileSync(join(UNIT_DIR, `${NAME}.service`), `[Unit]\nDescription=tf: free the resources of merged or idle tasks\n\n[Service]\nType=oneshot\nExecStart="${process.execPath}" "${RUNNER}"\nStandardOutput=append:${LOG}\nStandardError=append:${LOG}\n`)
        writeFileSync(join(UNIT_DIR, `${NAME}.timer`), `[Unit]\nDescription=tf reaper, every 30 minutes\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=30min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`)
        run('systemctl', ['--user', 'daemon-reload'])
        run('systemctl', ['--user', 'enable', '--now', `${NAME}.timer`])
        return 'systemd user timer'
      }
      if (!which('crontab')) throw new Error('neither a systemd user session nor crontab is available — run `node resources.mjs reap` yourself from time to time')
      const old = quiet('crontab', ['-l']).out.split('\n').filter((l) => l && !l.includes(CRON_MARK) && !/no crontab for/.test(l))
      run('crontab', ['-'], [...old, `*/30 * * * * "${process.execPath}" "${RUNNER}" >> "${LOG}" 2>&1 ${CRON_MARK}`, ''].join('\n'))
      return 'cron entry'
    },
    status: () => (hasSystemd() && quiet('systemctl', ['--user', 'is-enabled', `${NAME}.timer`]).ok) || (!!which('crontab') && quiet('crontab', ['-l']).out.includes(CRON_MARK)),
    uninstall() {
      if (hasSystemd()) { quiet('systemctl', ['--user', 'disable', '--now', `${NAME}.timer`]); for (const u of ['service', 'timer']) rmSync(join(UNIT_DIR, `${NAME}.${u}`), { force: true }); quiet('systemctl', ['--user', 'daemon-reload']) }
      if (which('crontab')) { const cur = quiet('crontab', ['-l']); if (cur.ok && cur.out.includes(CRON_MARK)) quiet('crontab', ['-'], cur.out.split('\n').filter((l) => !l.includes(CRON_MARK)).join('\n')) }
    },
  },
  windows: {
    install() {
      run('schtasks', ['/Create', '/F', '/SC', 'MINUTE', '/MO', '30', '/TN', NAME, '/TR', `"${process.execPath}" "${RUNNER}"`])
      return 'Task Scheduler task'
    },
    status: () => quiet('schtasks', ['/Query', '/TN', NAME]).ok,
    uninstall() { quiet('schtasks', ['/Delete', '/F', '/TN', NAME]) },
  },
}

export const reaperInstalled = () => { try { return !!installers[OS].status() } catch { return false } }

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  const cmd = process.argv[2]
  const it = installers[OS]
  try {
    if (cmd === 'install') { writeRunner(); console.log(`installed ${NAME} as a ${it.install()} (every 30 min) → log: ${join(stateDir(), 'reap.log')}`) }
    else if (cmd === 'uninstall') { it.uninstall(); rmSync(DIR, { recursive: true, force: true }); console.log(`removed ${NAME}`) }
    else if (cmd === 'status') { const on = reaperInstalled(); console.log(on ? 'installed' : 'not installed'); process.exit(on ? 0 : 1) }
    else { console.error('usage: reaper.mjs install | status | uninstall'); process.exit(2) }
  } catch (e) {
    console.error(`reaper ${cmd} failed: ${String(e.stderr || e.message || e).trim().split('\n')[0]}`)
    process.exit(1)
  }
}
