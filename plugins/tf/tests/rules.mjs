// rules.mjs: the instruction files of a workspace and the mechanical checks on them.
// Run: node --test plugins/tf/tests/rules.mjs
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BUDGET, checkRules, deadRefs, projectSlug, ruleFiles } from '../scripts/rules.mjs'

function put(p, text) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text) }
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'tf-rules-'))
  const root = join(home, 'w', 'acme')
  put(join(home, '.claude', 'CLAUDE.md'), 'Global rule.\n@EXTRA.md\n')
  put(join(home, '.claude', 'EXTRA.md'), 'Imported rule.\n')
  put(join(home, 'AGENTS.md'), 'Above the workspace.\n')
  put(join(root, 'CLAUDE.md'), 'Workspace rule.\n')
  put(join(root, 'api', 'CLAUDE.md'), 'Repo rule.\n')
  try { symlinkSync('CLAUDE.md', join(root, 'api', 'AGENTS.md')) } catch {} // Windows without the right: no link, same list
  put(join(root, '.claude', 'task-flow.md'), '# Config\n- Post with `node <scripts>/jira.mjs comment <dir> PROJ-1 --reply-to 1 --confirm`.\n')
  const mem = join(home, '.claude', 'projects', projectSlug(root), 'memory')
  put(join(mem, 'MEMORY.md'), '- [One](one.md) — a fact\n')
  put(join(mem, 'one.md'), '---\nname: one\n---\nA fact.\n')
  return { home, root, mem }
}

test('inventory: global with its imports, folders above, workspace, repos (a linked AGENTS.md once), config, memory', () => {
  const { home, root } = setup()
  const files = ruleFiles(root, { home })
  assert.deepEqual(files.map((f) => [f.scope, f.path.slice(home.length + 1).replace(/\\/g, '/')]), [
    ['global', '.claude/CLAUDE.md'],
    ['global', '.claude/EXTRA.md'],
    ['ancestor', 'AGENTS.md'],
    ['project', 'w/acme/CLAUDE.md'],
    ['repo', 'w/acme/api/CLAUDE.md'],
    ['tf-config', 'w/acme/.claude/task-flow.md'],
    ['memory-index', `.claude/projects/${projectSlug(root)}/memory/MEMORY.md`],
    ['memory', `.claude/projects/${projectSlug(root)}/memory/one.md`],
  ])
  assert.deepEqual(checkRules(root, { home }), [])
})

test('size: a global file is judged with its imports; a file past its scope budget warns', () => {
  const { home, root } = setup()
  put(join(home, '.claude', 'EXTRA.md'), 'w '.repeat(BUDGET.global))
  put(join(root, 'api', 'CLAUDE.md'), 'w '.repeat(BUDGET.repo + 1))
  const labels = checkRules(root, { home }).map((w) => w.label).join('\n')
  assert.match(labels, /global instructions too long/)
  assert.match(labels, /api\/CLAUDE\.md too long/)
})

test('memory index: near the 200-line cut, a link to a missing file, a file the index does not list', () => {
  const { home, root, mem } = setup()
  put(join(mem, 'MEMORY.md'), '- [One](one.md)\n- [Gone](gone.md)\n' + 'x\n'.repeat(160))
  put(join(mem, 'two.md'), 'Unlisted.\n')
  const w = checkRules(root, { home })
  assert.ok(w.some((r) => /200-line cut/.test(r.label)))
  assert.ok(w.some((r) => /missing file/.test(r.label) && r.detail === 'gone.md'))
  assert.ok(w.some((r) => /not in MEMORY\.md/.test(r.label) && /two\.md/.test(r.detail)))
})

test('dead references: a tf script that does not exist, an option a script does not take', () => {
  assert.deepEqual(deadRefs('`node <scripts>/jira.mjs comment d K --reply-to 1 --mention a=b --confirm`'), [])
  assert.deepEqual(deadRefs('run `$S/nope.mjs x`'), ['nope.mjs — no such tf script'])
  assert.deepEqual(deadRefs('`node scripts/jira.mjs comment --paste-html`'), ['jira.mjs --paste-html — the script has no such option'])
  assert.deepEqual(deadRefs('plain jira.mjs, not a script path, and gdrive-cli/src/drive.mjs is the workspace\'s own'), [])
})
