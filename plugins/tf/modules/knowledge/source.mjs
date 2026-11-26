// tf knowledge — what a map reads a repo from: its main branch on the remote (`origin/<base>`), so a map does not
// depend on which branch the checkout is on or on local edits. A repo without that ref is read from its working
// tree (a new repo, no remote yet).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const git = (repo, args, max = 64 << 20) => {
  try { return execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', windowsHide: true, timeout: 60_000, maxBuffer: max }).toString() } catch { return null }
}

// Folders never worth reading, whatever the repo: dependencies, builds, caches, tf's own task folders.
export const SKIP = /(^|\/)(node_modules|\.git|\.worktrees|\.pipeline|\.codegraph|dist|build|out|coverage|\.next|\.nuxt|\.output|\.dart_tool|\.gradle|Pods|vendor|target|__pycache__|\.venv|venv)(\/|$)/

/** The base branch of a repo: the given one, else origin/HEAD, else the first of main/develop/master on origin. */
export function baseOf(repo, given = '') {
  if (given) return given
  const head = git(repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
  if (head && head.trim()) return head.trim().replace(/^origin\//, '')
  for (const b of ['main', 'develop', 'master']) if (git(repo, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${b}`])) return b
  const cur = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return cur && cur.trim() !== 'HEAD' ? cur.trim() : ''
}

/**
 * A reader of one repo at one ref.
 * @returns {{ ref: string, version: string, files: () => string[], read: (path: string) => string | null, has: (path: string) => boolean }}
 */
export function openRepo(repo, base) {
  const ref = base && git(repo, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${base}`]) ? `origin/${base}` : ''
  if (ref) {
    const version = (git(repo, ['rev-parse', ref]) || '').trim()
    let list = null
    const files = () => (list ||= (git(repo, ['ls-tree', '-r', '--name-only', ref]) || '').split('\n').filter((f) => f && !SKIP.test(f)))
    return { ref, version, files, has: (p) => files().includes(p), read: (p) => git(repo, ['show', `${ref}:${p}`], 16 << 20) }
  }
  // Working tree: the files git tracks (or, outside git, a bounded walk).
  let list = null
  const files = () => {
    if (list) return list
    const tracked = git(repo, ['ls-files'])
    if (tracked !== null) return (list = tracked.split('\n').filter((f) => f && !SKIP.test(f)))
    const out = []
    const walk = (d, depth) => {
      if (depth > 6 || out.length > 20000) return
      let names = []
      try { names = readdirSync(d) } catch { return }
      for (const n of names) {
        const p = join(d, n)
        const rel = relative(repo, p).split(sep).join('/')
        if (SKIP.test(rel)) continue
        let st
        try { st = statSync(p) } catch { continue }
        if (st.isDirectory()) walk(p, depth + 1)
        else out.push(rel)
      }
    }
    walk(repo, 0)
    return (list = out)
  }
  const head = (git(repo, ['rev-parse', 'HEAD']) || '').trim()
  return {
    ref: 'working tree',
    version: head ? `worktree:${head}` : `worktree:${Date.now()}`,
    files,
    has: (p) => existsSync(join(repo, p)),
    read: (p) => { try { return readFileSync(join(repo, p), 'utf8') } catch { return null } },
  }
}
