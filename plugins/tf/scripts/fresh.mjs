#!/usr/bin/env node
// task-flow pre-flight: keep each repo's main checkout and its CodeGraph index current.
// For every <path>:<base> pair: fetch; if the checkout is clean (untracked files ignored) and sits on
// <base>, fast-forward it to origin/<base> and run `codegraph sync`. Otherwise touch nothing and warn —
// a checkout on another branch or with local edits belongs to someone's work in progress.
//
//   node fresh.mjs <repoPath>:<base> [<repoPath>:<base>…]
//   e.g. node fresh.mjs backend:develop frontend:develop mobile:develop   (paths relative to cwd)

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const sh = (cmd, cwd) => {
  try { return { ok: true, out: execSync(cmd, { cwd, stdio: 'pipe', shell: '/bin/sh', timeout: 600_000 }).toString().trim() } }
  catch (e) { return { ok: false, out: String(e.stderr || e.message).trim().split('\n').pop() } }
}

let warn = 0
for (const arg of process.argv.slice(2)) {
  const [p, base] = arg.split(':')
  const repo = resolve(p)
  const name = p.replace(/\/$/, '')
  if (!base || !existsSync(join(repo, '.git'))) { console.log(`${name}: skipped (not a git repo or no base)`); warn++; continue }
  sh(`git fetch -q origin ${base}`, repo)
  const branch = sh('git branch --show-current', repo).out
  const dirty = sh('git status --porcelain --untracked-files=no', repo).out
  const behind = Number(sh(`git rev-list --count HEAD..origin/${base}`, repo).out || 0)
  if (branch !== base || dirty) {
    console.log(`${name}: NOT updated — ${branch !== base ? `on ${branch || 'detached HEAD'}, not ${base}` : 'has local edits'} (${behind} commits behind origin/${base}); index reflects that state`)
    warn++
  } else if (behind) {
    const pull = sh(`git pull -q --ff-only origin ${base}`, repo)
    console.log(`${name}: ${pull.ok ? `fast-forwarded ${behind} commits` : `pull failed — ${pull.out}`}`)
    if (!pull.ok) warn++
  } else {
    console.log(`${name}: up to date`)
  }
  if (existsSync(join(repo, '.codegraph'))) {
    const s = sh('codegraph sync -q .', repo)
    if (!s.ok) { console.log(`${name}: codegraph sync failed — ${s.out}`); warn++ }
  }
}
process.exitCode = warn ? 1 : 0
