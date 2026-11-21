// naming.mjs: the git.md rules for commit messages and PR titles (the guard applies the same ones).
// Run: node --test plugins/tf/tests/naming.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkTitle, issueKey } from '../scripts/naming.mjs'

const N = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'naming.mjs')
const key = 'RVD-306'

test('the issue key is the scope, exactly as written, and nowhere else', () => {
  assert.deepEqual(checkTitle('feat(RVD-306): goalkeeper-award — bỏ mặc định preset Huế', { key }), [])
  assert.match(checkTitle('feat(goalkeeper-award): bỏ preset Huế (RVD-306)', { key }).join(), /issue key is the scope.*not "\(goalkeeper-award\)"/)
  assert.match(checkTitle('feat(goalkeeper-award): bỏ preset Huế (RVD-306)', { key }).join(), /appears in the summary/)
  assert.match(checkTitle('fix(goalkeeper): [RVD-306] hide CTA', { key }).join(), /no \[KEY\] in brackets/)
  assert.match(checkTitle('[RVD-267] Decode multipart filenames', { key: 'RVD-267' }).join(), /not "<type>\(RVD-267\)/)
  assert.match(checkTitle('feat(rvd-306): x', { key }).join(), /issue key is the scope/)
  assert.deepEqual(checkTitle('feat(RVD-306)!: drop the v1 endpoint', { key }), [])
})

test('a PR title is English; a commit may follow the writing language', () => {
  assert.match(checkTitle('feat(RVD-306): cấu hình giải thủ môn', { kind: 'pr', key }).join(), /PR title is English/)
  assert.deepEqual(checkTitle('feat(RVD-306): cấu hình giải thủ môn', { kind: 'commit', key }), [])
  assert.deepEqual(checkTitle('feat(RVD-306): configure the goalkeeper award per tournament', { kind: 'pr', key }), [])
})

test('no key: a lowercase scope or none; no trailing period', () => {
  assert.deepEqual(checkTitle('feat(auth): add OAuth2 login'), [])
  assert.deepEqual(checkTitle('chore: bump deps'), [])
  assert.match(checkTitle('feat(Auth): add login').join(), /not lowercase kebab-case/)
  assert.match(checkTitle('fix(auth): handle expiry.').join(), /trailing period/)
  assert.equal(issueKey('RVD-306'), 'RVD-306'); assert.equal(issueKey('GH-WEB-9'), 'GH-WEB-9'); assert.equal(issueKey('booking-screen-1a2b'), '')
})

test('CLI: a message file or a line; exit 1 with the problems', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'tf-name-')), 'msg.txt')
  writeFileSync(f, 'feat(tournament): add groups (RVD-306)\n\nbody\n')
  const bad = spawnSync(process.execPath, [N, 'check', '--kind', 'commit', '--key', key, '--file', f], { encoding: 'utf8' })
  assert.equal(bad.status, 1); assert.match(bad.stdout, /✗ the issue key is the scope/)
  const ok = spawnSync(process.execPath, [N, 'check', '--kind', 'pr', '--key', key, 'fix(RVD-306): hide redundant goalkeeper config CTA'], { encoding: 'utf8' })
  assert.equal(ok.status, 0); assert.equal(ok.stdout, '')
})
