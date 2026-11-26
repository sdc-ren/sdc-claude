// tf core — is this file the program that was started? A module is its own command line when node runs it
// directly, or when node runs one of its old entry points (scripts/<name>.mjs, a thin file that re-exports it).
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The plugin folder: core/ sits at its top.
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @param {string} url the caller's import.meta.url
 * @param {...string} legacy plugin-relative paths of the caller's old entry points, e.g. 'scripts/task.mjs'
 */
export function isMain(url, ...legacy) {
  const started = process.argv[1] && resolve(process.argv[1])
  if (!started) return false
  return started === fileURLToPath(url) || legacy.some((p) => started === join(PLUGIN_ROOT, p))
}
