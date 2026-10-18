/**
 * Session-storage logic for the plugin's destructive operation.
 *
 * The harness ships no deletion API — `dsh-session-persistence-jsonl`'s own
 * README says "nothing deletes session files … the seam has no deletion API" —
 * so this module owns the file-level facts and nothing else: where the logs
 * live, which sessions belong to the same branch, and how to remove them while
 * reporting partial failures honestly.
 *
 * It deliberately has no cordis dependency so the whole thing is unit-testable
 * with a temporary directory.
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Session ids the harness mints: `session-<uuid>`. */
export const SESSION_ID_PATTERN =
  /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * @param value - candidate id from the wire.
 * @returns whether it is a well-formed session id.
 */
export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/**
 * Resolve `$DSH_HOME`, falling back to `~/.dsh`.
 *
 * @param env - environment to read.
 * @returns the harness home directory.
 */
export function harnessHome(env = process.env) {
  const configured = env?.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured)
  return path.join(homedir(), '.dsh')
}

/**
 * The default session-log root (`root: dshHomePath('sessions')` in dsh-base).
 *
 * @param env - environment to read.
 * @returns absolute session-log root.
 */
export function defaultSessionRoot(env = process.env) {
  return path.join(harnessHome(env), 'sessions')
}

/**
 * The json storage root that holds the projection cache (`storages/`).
 *
 * @param env - environment to read.
 * @returns absolute storage root.
 */
export function defaultStoragesRoot(env = process.env) {
  return path.join(harnessHome(env), 'storages')
}

/**
 * The per-session projection-cache directory.
 *
 * @param storagesRoot - the json storage root.
 * @returns absolute projection-cache directory.
 */
export function projectionCacheDir(storagesRoot) {
  return path.join(storagesRoot, 'session_projcache', 'sessions')
}

/**
 * Resolve the session-log root, preferring the mounted backend's own config.
 *
 * @param options - a root read from the persistence row, plus the environment.
 * @returns absolute session-log root.
 */
export function resolveSessionRoot(options = {}) {
  const configured = options.configRoot
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured)
  return defaultSessionRoot(options.env ?? process.env)
}

/** @returns whether the path exists (any type). */
export async function pathExists(target, statImpl = stat) {
  try {
    await statImpl(target)
    return true
  } catch {
    return false
  }
}

/**
 * Find one session's own directory under the log root.
 *
 * The layout is `<root>/--<normalized cwd>--/<sessionId>/`, and the project
 * directory is a function of the session's cwd, so this scans the (small) set
 * of project directories instead of re-deriving the escaping rule.
 *
 * @param root - session-log root.
 * @param sessionId - session to locate.
 * @param readdirImpl - injectable directory reader (tests).
 * @returns the session directory, or undefined.
 */
export async function findSessionDir(root, sessionId, readdirImpl = readdir) {
  let entries
  try {
    entries = await readdirImpl(root, { withFileTypes: true })
  } catch (error) {
    // An absent root means "no such session"; anything else (EACCES, EIO) must
    // reach the caller, because reporting it as absent would claim a deletion
    // that never happened.
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
    throw error
  }
  for (const entry of entries) {
    if (entry === undefined || entry === null || entry.isDirectory?.() === false) continue
    const name = typeof entry === 'string' ? entry : entry.name
    if (typeof name !== 'string') continue
    const candidate = path.join(root, name, sessionId)
    if (await pathExists(candidate)) return candidate
  }
  return undefined
}

/**
 * Collect a session and every descendant of it.
 *
 * Children are found through `header.parentSession`, which covers both forked
 * children and subagent sessions. Descendants matter because the sidebar hides
 * `origin: 'subagent'` rows, so an orphaned child would be unreachable.
 *
 * @param snapshots - persistence snapshots (`header`-bearing).
 * @param rootId - the requested session.
 * @returns the subtree in breadth-first order; empty when the root is unknown.
 */
export function collectSubtree(snapshots, rootId) {
  const ids = new Set()
  const byParent = new Map()
  for (const snapshot of snapshots ?? []) {
    const header = snapshot?.header
    const id = header?.id
    if (typeof id !== 'string') continue
    ids.add(id)
    const parent = header?.parentSession
    if (typeof parent !== 'string' || parent === '') continue
    const children = byParent.get(parent)
    if (children === undefined) byParent.set(parent, [id])
    else children.push(id)
  }
  if (!ids.has(rootId)) return []
  const ordered = []
  const seen = new Set()
  const queue = [rootId]
  while (queue.length > 0) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
    for (const child of byParent.get(id) ?? []) queue.push(child)
  }
  return ordered
}

/** A child id is treated as a descendant even when its parent link points outside the set. */
export function hasDescendants(snapshots, rootId) {
  return collectSubtree(snapshots, rootId).length > 1
}

/**
 * Remove the session directory and the projection-cache record of each id.
 *
 * Failures are collected per target instead of aborting: a locked log on one
 * session must not block the others, and the caller reports exactly what
 * survived.
 *
 * @param options - roots, ids, and injectable fs functions (tests).
 * @returns removed ids, already-absent ids, and per-target failures.
 */
export async function removeSessionFiles(options) {
  const { sessionRoot, projcacheDir, ids, readdirImpl = readdir, rmImpl = rm } = options
  const removed = []
  const missing = []
  const failures = []
  for (const id of ids) {
    let directory
    try {
      directory = await findSessionDir(sessionRoot, id, readdirImpl)
    } catch (error) {
      failures.push(failure(id, path.join(sessionRoot, id), error))
      directory = undefined
    }
    if (directory === undefined) {
      missing.push(id)
    } else {
      try {
        await rmImpl(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        removed.push(id)
      } catch (error) {
        failures.push(failure(id, directory, error))
      }
    }
    // `force: true` makes an absent record a no-op, so no existence probe is
    // needed (and a failed probe can never be mistaken for "already gone").
    const record = path.join(projcacheDir, `${id}.json`)
    try {
      await rmImpl(record, { force: true, maxRetries: 3, retryDelay: 100 })
    } catch (error) {
      failures.push(failure(id, record, error))
    }
  }
  return { removed, missing, failures }
}

/** @returns a JSON-safe failure record. */
function failure(id, target, error) {
  return {
    id,
    path: target,
    code: typeof error?.code === 'string' ? error.code : 'EUNKNOWN',
    message: String(error?.message ?? error),
  }
}
