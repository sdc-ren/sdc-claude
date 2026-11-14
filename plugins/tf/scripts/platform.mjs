#!/usr/bin/env node
// tf — everything that differs between macOS, Linux and Windows, in one place. The other scripts ask
// here instead of calling lsof, launchctl, /bin/sh or a macOS path themselves.
//
//   node platform.mjs info               what this machine offers (JSON) — used by doctor
//   node platform.mjs kill <pid>         stop one process and its children (no error when it is gone)
//   node platform.mjs free-port <port>   stop whatever listens on a TCP port (the config's port release)
//
// Windows: commands run through Git Bash (the shell Claude Code itself uses there), so the POSIX
// one-liners in a workspace config keep working. Without Git Bash only the plain Node paths work.

import { execFileSync, spawn } from 'node:child_process'
import { cpSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const OS = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
export const IS_WIN = OS === 'windows'
export const IS_MAC = OS === 'macos'
const SELF = fileURLToPath(import.meta.url)

const run = (file, args, opts = {}) => {
  try { return execFileSync(file, args, { stdio: 'pipe', timeout: 20_000, windowsHide: true, ...opts }).toString() } catch { return '' }
}
const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }

// ── Paths ────────────────────────────────────────────────────────────────────
// Forward slashes are understood by Node, git and Git Bash on every system; use them in command strings.
export const posix = (p) => String(p).replace(/\\/g, '/')
// Last path segment, whichever separator the path uses (paths stored in JSON may come from another shell).
export const base = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
const norm = (p) => { const s = posix(resolve(String(p))).replace(/\/+$/, ''); return IS_WIN ? s.toLowerCase() : s }
// Is `child` the folder `parent` or inside it? Separator- and (on Windows) case-insensitive.
export const under = (child, parent) => { if (!child || !parent) return false; const c = norm(child); const p = norm(parent); return c === p || c.startsWith(`${p}/`) }
// <root> of a task folder <root>/.pipeline/<slug> (or …/_archive/<slug>).
export const rootOfTask = (dir) => String(dir).split(/[\\/]\.pipeline[\\/]/)[0]

// Claude Code keeps its data in ~/.claude on every system unless CLAUDE_CONFIG_DIR moves it.
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
// tf's own machine-wide state (reaper list, saved logins, artifact index).
export const stateDir = () => join(homedir(), '.claude', 'task-flow')
// The transcript folder of a working directory: every character that is not a letter or digit becomes "-".
export const projectDirName = (cwd) => resolve(String(cwd)).replace(/[^A-Za-z0-9]/g, '-')

// Does a folder under <claude>/projects belong to this workspace (the folder itself or a sub-folder of it)?
// Claude Code shortens names over 200 characters and appends a hash, so long names are matched by prefix.
export const projectMatch = (enc) => (enc.length > 180 ? (d) => d.startsWith(enc.slice(0, 180)) : (d) => d === enc || d.startsWith(`${enc}-`))

export function androidSdk(flag) {
  if (flag) return flag
  if (process.env.ANDROID_HOME) return process.env.ANDROID_HOME
  if (process.env.ANDROID_SDK_ROOT) return process.env.ANDROID_SDK_ROOT
  if (IS_MAC) return join(homedir(), 'Library', 'Android', 'sdk')
  if (IS_WIN) return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
  return join(homedir(), 'Android', 'Sdk')
}
// A tool inside the SDK: `sdkTool(sdk, 'platform-tools', 'adb')` → …/adb or …\adb.exe.
export const sdkTool = (sdk, ...parts) => { const p = join(sdk, ...parts); return IS_WIN && !/\.(exe|bat|cmd)$/i.test(p) ? `${p}.exe` : p }
// Chrome's profile folder, only where tf can read its cookie store (macOS). Elsewhere the user logs in
// once in the browser tf opens.
export const chromeProfiles = () => (IS_MAC ? join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome') : '')

// ── Programs and shells ──────────────────────────────────────────────────────
export function which(bin) {
  if (/[\\/]/.test(bin)) return isFile(bin) ? bin : ''
  const exts = IS_WIN ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : ['']
  for (const dir of String(process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const e of exts) {
      const p = join(dir, bin + e)
      if (isFile(p)) return p
    }
  }
  return ''
}
export function gitBash() {
  if (!IS_WIN) return ''
  const env = process.env
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    env.ProgramFiles && join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ]
  // bash on PATH counts unless it is the WSL launcher in System32 (a different file system and git).
  const onPath = which('bash')
  if (onPath && !/\\system32\\/i.test(onPath)) candidates.push(onPath)
  const git = which('git')
  if (git) candidates.push(join(git, '..', '..', 'bin', 'bash.exe'))
  return candidates.find((p) => p && isFile(p)) || ''
}
// The `shell` option for execSync: /bin/sh, Git Bash on Windows, or (no Git Bash) Windows' own shell.
export const SH = IS_WIN ? gitBash() || true : '/bin/sh'
// `"<node>" "<script>" args…` as a command string that every shell above accepts.
export const nodeCmd = (script, ...args) => [`"${posix(process.execPath)}"`, `"${posix(script)}"`, ...args.map(String)].join(' ')
export const killCmd = (pid) => nodeCmd(SELF, 'kill', pid)
export const freePortCmd = (port) => nodeCmd(SELF, 'free-port', port)

// A long-running command in its own process group, detached from this script.
export function spawnShell(cmd, { cwd, env, stdio } = {}) {
  const opts = { cwd, env, stdio, detached: true, windowsHide: true }
  if (!IS_WIN) return spawn('/bin/sh', ['-c', cmd], opts)
  const bash = gitBash()
  return bash ? spawn(bash, ['-c', cmd], opts) : spawn(cmd, { ...opts, shell: true })
}

// ── Processes and ports ──────────────────────────────────────────────────────
// Linux answers from /proc, so nothing has to be installed (a slim container has no lsof, ss or ps).
const procPids = () => { try { return readdirSync('/proc').filter((d) => /^\d+$/.test(d)) } catch { return [] } }
// /proc/<pid>/stat: "pid (comm) state ppid pgrp …" — comm may hold spaces and brackets, so read after the last ")".
function procStat(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ')
    return { pid: String(pid), ppid: rest[1], pgrp: rest[2] }
  } catch { return null }
}
const procCmd = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() } catch { return '' } }
// Listening sockets of a port: /proc/net/tcp{,6} gives the socket inode, /proc/<pid>/fd says who holds it.
function linuxPidsOnPort(port) {
  const inodes = new Set()
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let txt = ''
    try { txt = readFileSync(f, 'utf8') } catch { continue }
    for (const line of txt.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/)
      if (c.length > 9 && c[3] === '0A' && parseInt(c[1].split(':').pop(), 16) === port) inodes.add(c[9])
    }
  }
  if (!inodes.size) return []
  const out = new Set()
  for (const pid of procPids()) {
    let fds = []
    try { fds = readdirSync(`/proc/${pid}/fd`) } catch { continue } // another user's process
    for (const fd of fds) {
      try { const m = readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/); if (m && inodes.has(m[1])) { out.add(pid); break } } catch {}
    }
  }
  // A socket held by a process we may not inspect: the port is busy, by someone else.
  return out.size ? [...out] : ['?']
}
export function alive(pid) {
  try { process.kill(Number(pid), 0); return true } catch (e) { return e.code === 'EPERM' }
}
// Pids listening on a TCP port (strings). Empty when the port is free — or when the system has no tool to tell.
export function pidsOnPort(port) {
  const p = Number(port)
  if (!p) return []
  if (IS_WIN) {
    const out = run('netstat', ['-ano', '-p', 'TCP'])
    return [...new Set(out.split(/\r?\n/).map((l) => l.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i)).filter((m) => m && Number(m[1]) === p).map((m) => m[2]))]
  }
  if (OS === 'linux') return linuxPidsOnPort(p)
  return run('lsof', ['-t', '-nP', `-iTCP:${p}`, '-sTCP:LISTEN']).split('\n').filter(Boolean)
}
// Working directory of a process; '' where the system does not tell (Windows).
export function cwdOf(pid) {
  if (IS_WIN) return ''
  if (OS === 'linux') { try { return readlinkSync(`/proc/${pid}/cwd`) } catch { return '' } }
  return (run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').find((l) => l.startsWith('n')) || '').slice(1)
}
// Processes of the group a detached spawn started (its pid is the group id). On Windows a group cannot be
// listed: the leader stands for it and `killGroup` takes its whole tree.
export function groupMembers(pgid) {
  if (IS_WIN) return alive(pgid) ? [{ pid: String(pgid), cmd: '' }] : []
  if (OS === 'linux') return procPids().map(procStat).filter((s) => s && s.pgrp === String(pgid)).map((s) => ({ pid: s.pid, cmd: procCmd(s.pid) }))
  return run('ps', ['-A', '-o', 'pid=,pgid=,command='])
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m && m[2] === String(pgid))
    .map((m) => ({ pid: m[1], cmd: m[3] }))
}
export function killGroup(pgid) {
  if (IS_WIN) { run('taskkill', ['/PID', String(pgid), '/T', '/F']); return }
  try { process.kill(-Number(pgid), 'SIGTERM') } catch {}
}
// One process and its children.
export function killTree(pid) {
  if (!Number(pid)) return
  if (IS_WIN) { run('taskkill', ['/PID', String(pid), '/T', '/F']); return }
  const children = OS === 'linux' ? procPids().map(procStat).filter((s) => s && s.ppid === String(pid)).map((s) => s.pid) : run('pgrep', ['-P', String(pid)]).split('\n').filter(Boolean)
  for (const child of children) killTree(child)
  try { process.kill(Number(pid), 'SIGTERM') } catch {}
}

// ── Files ────────────────────────────────────────────────────────────────────
// Copy a dependency folder as cheaply as the file system allows: an APFS clone on macOS, a reflink on
// Linux file systems that have one (btrfs, xfs), else a plain copy. Returns how it was done.
export function cloneDir(src, dst) {
  const cp = (args, timeout) => { execFileSync('cp', args, { stdio: 'pipe', timeout }); return true }
  if (IS_MAC) { try { cp(['-cR', src, dst], 600_000); return 'clone' } catch {} }
  if (OS === 'linux') { try { cp(['-R', '--reflink=auto', src, dst], 900_000); return 'reflink-or-copy' } catch {} }
  if (!IS_WIN) { try { cp(['-R', src, dst], 900_000); return 'copy' } catch {} }
  cpSync(src, dst, { recursive: true, verbatimSymlinks: true })
  return 'copy'
}
export function tail(file, lines = 30) {
  try { return readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines - 1).join('\n').trim() } catch { return '' }
}

export function info() {
  const bash = gitBash()
  return {
    os: OS,
    node: process.version,
    shell: IS_WIN ? bash || 'cmd.exe (Git Bash not found)' : '/bin/sh',
    shellOk: !IS_WIN || !!bash,
    portTool: IS_WIN ? 'netstat' : OS === 'linux' ? '/proc' : which('lsof') ? 'lsof' : '',
    cwdOfProcess: !IS_WIN,
    clone: IS_MAC ? 'APFS clone' : OS === 'linux' ? 'reflink where the file system has it, else copy' : 'copy',
    chromeCookieImport: IS_MAC,
    claudeDir: claudeDir(),
    androidSdk: androidSdk(),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'info') console.log(JSON.stringify(info(), null, 2))
  else if (cmd === 'kill' && Number(arg)) killTree(arg)
  else if (cmd === 'free-port' && Number(arg)) { for (const pid of pidsOnPort(arg)) if (Number(pid)) killTree(pid) }
  else { console.error('usage: platform.mjs info | kill <pid> | free-port <port>'); process.exit(2) }
}
