import { expect, test } from 'claude-code/testing'

import { parseJob, refuse } from '../hooks/guard'

const WT = '/r/.worktrees/T-1/backend'
const dev = (extra = '') => `Job J2 · role dev lead · repo be\nTask T-1 · mode build · round 1\n\nBrief: x\nWorktree: ${WT} · existing PR: none\n${extra}`
const member = `Job J2b · role dev (member of J2) · repo be\nTask T-1\n\nYour part: api\nWorktree: ${WT}\nSHARED WORKTREE: J2a edit this repo at the same time. Your files (edit nothing else): ./src/c.ts, src/r.ts. Their files (do not touch): src/s.ts, ./src/t.ts. Follow dev.md "Sharing the worktree".\n`
const reader = 'Job J4 · role tester · repo be\nTask T-1\n\nBrief: x\nScratch: /r/.pipeline/T-1/tmp/J4/ is yours alone.\nFLOW LIBRARY READ-ONLY: J3 is the only job that may edit /r/.pipeline/_lib in this group. Import from it.\n'

test('a dev job cannot commit or push; words that only mention it pass', () => {
  const job = parseJob(dev(), 'tf:lead')!
  expect(job.role).toBe('dev')
  for (const cmd of ['git commit -m x', `cd ${WT} && git add a.ts && git commit -m "feat: x"`, `git -C ${WT} push origin HEAD`, 'npm run build; git   merge origin/main', 'FOO=1 git rebase main'])
    expect(refuse(job, 'Bash', { command: cmd })).toContain('never runs')
  for (const cmd of ['git status --porcelain', 'git diff origin/main...HEAD --stat', 'echo "do not git commit here"', 'grep -rn "git push" docs/', `node /s/task.mjs uncommit ${WT} abc1234`, 'git log --oneline -3', 'git stash list'])
    expect(refuse(job, 'Bash', { command: cmd })).toBe('')
})

test('reviewers and testers keep their git commands', () => {
  expect(refuse(parseJob('Job J9 · role reviewer · repo be\nBrief: PACKAGE\n', 'tf:reviewer')!, 'Bash', { command: 'git commit -m x && git push' })).toBe('')
  expect(refuse(parseJob('Job J3 · role tester · repo be\n', 'tf:tester')!, 'Bash', { command: 'git commit -m x' })).toBe('')
})

test('a team member cannot edit a file given to another member', () => {
  const job = parseJob(member, 'tf:dev')!
  expect(job.theirs).toEqual(['src/s.ts', 'src/t.ts'])
  expect(refuse(job, 'Edit', { file_path: `${WT}/src/s.ts` })).toContain('belongs to another member')
  expect(refuse(job, 'Write', { file_path: `${WT}/src/t.ts` })).toContain('belongs to another member')
  expect(refuse(job, 'Edit', { file_path: `${WT}/src/c.ts` })).toBe('')
  expect(refuse(job, 'Write', { file_path: `${WT}/src/new-helper.ts` })).toBe('')
  expect(refuse(job, 'Write', { file_path: '/r/.pipeline/T-1/jobs/J2b-dev-be.md' })).toBe('')
})

test('a tester that only reads the flow library cannot edit it', () => {
  const job = parseJob(reader, 'tf:tester')!
  expect(job.lib).toBe('/r/.pipeline/_lib')
  expect(refuse(job, 'Write', { file_path: '/r/.pipeline/_lib/auth.mjs' })).toContain('read-only')
  expect(refuse(job, 'Bash', { command: "cd /r/.pipeline/_lib; sed -i '' 's/a/b/' be.mjs" })).toContain('read-only')
  expect(refuse(job, 'Bash', { command: 'cat /r/.pipeline/_lib/README.md' })).toBe('')
  expect(refuse(job, 'Write', { file_path: '/r/.pipeline/T-1/flows/_new/J4-seed.mjs' })).toBe('')
  // the writer of the group, and a lone tester, are not restricted
  expect(refuse(parseJob('Job J3 · role tester · repo be\nFLOW LIBRARY: you are the only job in this group that may edit /r/.pipeline/_lib; other testers import it.\n', 'tf:tester')!, 'Write', { file_path: '/r/.pipeline/_lib/auth.mjs' })).toBe('')
})

test('Windows paths: either separator, any case', () => {
  const wt = 'C:\\Users\\me\\ws\\.worktrees\\T-1\\backend'
  const m = parseJob(`Job J2b · role dev (member of J2) · repo be\nWorktree: ${wt}\nSHARED WORKTREE: J2a. Your files (edit nothing else): src/c.ts. Their files (do not touch): src\\s.ts. Follow dev.md\n`, 'tf:dev')!
  expect(refuse(m, 'Edit', { file_path: 'c:/users/me/ws/.worktrees/T-1/backend/src/s.ts' })).toContain('belongs to another member')
  expect(refuse(m, 'Edit', { file_path: `${wt}\\src\\c.ts` })).toBe('')
  const r = parseJob('Job J4 · role tester · repo be\nFLOW LIBRARY READ-ONLY: J3 is the only job that may edit C:\\Users\\me\\ws/.pipeline/_lib in this group.\n', 'tf:tester')!
  expect(refuse(r, 'Write', { file_path: 'C:\\Users\\me\\ws\\.pipeline\\_lib\\auth.mjs' })).toContain('read-only')
  expect(refuse(r, 'Bash', { command: "sed -i 's/a/b/' /c/Users/me/ws/.pipeline/_lib/be.mjs" })).toContain('read-only')
  expect(refuse(r, 'Bash', { command: "sed -i 's/a/b/' C:/Users/me/ws/.pipeline/_lib/be.mjs" })).toContain('read-only')
})

test('other agents and other prompts are left alone', () => {
  expect(parseJob('Summarise this repository', 'general-purpose')).toBe(null)
  expect(parseJob('PM turn 1/12', 'tf:pm')).toBe(null)
})

test('the guard refuses a recognised agent\'s call and lets the rest through', async ($, on) => {
  on('agent.spawn', (_, e) => ({ model: 'sonnet', agentId: e.prompt.startsWith('Job J2 ') ? 'a-dev' : 'a-other' }))
  on('tool.call', () => ({ result: {} }))
  await $.agent.spawn({ prompt: dev(), subagentType: 'tf:lead', description: 'J2 lead:be' })
  const denied = await $.tool.call({ tool: 'Bash', command: 'git commit -m x', agentId: 'a-dev' } as never)
  expect(denied.deny).toContain('never runs')
  const allowed = await $.tool.call({ tool: 'Bash', command: 'git status', agentId: 'a-dev' } as never)
  expect(allowed.deny).toBe(undefined)
  const main = await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(main.deny).toBe(undefined)
})
