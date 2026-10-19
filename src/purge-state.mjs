/**
 * The auto-purge timer's state file.
 *
 * The only fact worth persisting is the local day of the last round, because
 * that is what decides whether a freshly started dsh should catch up on a run
 * it missed while it was closed.
 *
 * This is the only module of the feature that touches the filesystem, and it
 * refuses to be a failure mode: state that is missing, unreadable, or malformed
 * reads as "never ran" and never throws. Writing is atomic (temp file plus
 * rename) so a crash mid-write cannot leave a half-written file that would be
 * mistaken for a completed run; the caller decides what to do when a write
 * fails.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { harnessHome } from './session-store.mjs'

/** Schema version of the state file; anything else is treated as absent. */
export const PURGE_STATE_VERSION = 1

/**
 * Where the state file lives: `<DSH_HOME>/sidebar-delete/auto-purge.json`.
 *
 * @param env - environment to read (`DSH_HOME`).
 * @returns absolute path of the state file.
 */
export function defaultPurgeStatePath(env = process.env) {
  return path.join(harnessHome(env), 'sidebar-delete', 'auto-purge.json')
}

/**
 * Read the last-run state.
 *
 * @param statePath - absolute state-file path.
 * @param options - optional `readFileImpl` and `onWarn(message, error)`.
 * @returns the stored state, or `{}` when it is missing, unreadable, or does not
 *   have the supported shape. Never throws.
 */
export async function readPurgeState(statePath, options = {}) {
  const readFileImpl = options.readFileImpl ?? readFile
  const warn = typeof options.onWarn === 'function' ? options.onWarn : () => {}
  let raw
  try {
    raw = await readFileImpl(statePath, 'utf8')
  } catch (error) {
    // A missing file is the normal first-run case. Anything else (EACCES, EIO)
    // is reported, but it still means "not run yet" for the caller's decisions:
    // failing a startup over a state file would be worse than one extra round.
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
      warn(`sidebar-delete: could not read the auto-purge state file (${statePath})`, error)
    }
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    warn(`sidebar-delete: the auto-purge state file is not valid JSON (${statePath})`, error)
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`sidebar-delete: the auto-purge state file does not hold an object (${statePath})`)
    return {}
  }
  if (parsed.version !== PURGE_STATE_VERSION || typeof parsed.lastRunDate !== 'string') {
    warn(`sidebar-delete: the auto-purge state file has an unsupported version or a bad lastRunDate (${statePath})`)
    return {}
  }
  return parsed
}

/**
 * Write the last-run state, atomically.
 *
 * @param statePath - absolute state-file path.
 * @param state - JSON-serializable state.
 * @param options - optional fs implementations (tests).
 * @throws whatever the filesystem throws; the caller only warns.
 */
export async function writePurgeState(statePath, state, options = {}) {
  const mkdirImpl = options.mkdirImpl ?? mkdir
  const writeFileImpl = options.writeFileImpl ?? writeFile
  const renameImpl = options.renameImpl ?? rename
  const rmImpl = options.rmImpl ?? rm
  await mkdirImpl(path.dirname(statePath), { recursive: true })
  const temp = `${statePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFileImpl(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await renameImpl(temp, statePath)
  } catch (error) {
    try {
      await rmImpl(temp, { force: true })
    } catch {
      // Best-effort cleanup; the original failure is what matters.
    }
    throw error
  }
}
