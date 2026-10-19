/**
 * Pure decision logic for the daily "delete ungrouped sessions" timer.
 *
 * This module owns exactly two things: *when* a daily round is due, and *which*
 * sessions count as ungrouped. It is deliberately free of `node:fs` and of
 * cordis, so both decisions are unit-testable on their own; the state file that
 * remembers the last run lives in `src/purge-state.mjs`, and the timer plus the
 * deletions are wired up in `index.js`.
 *
 * The scope rule is directory-based on purpose: a session belongs to a
 * workspace when the `cwd` recorded in its header sits inside (or equals) one of
 * the registered workspace paths — not when some registry list happens to name
 * it. `scope: 'tree'` accepts any descendant of a workspace path, `scope:
 * 'exact'` accepts only the path itself.
 */

import path from 'node:path'

/**
 * Defaults for the feature: opt-in, once a day at 12:25 local time, sessions
 * inside a workspace directory (or below it) are kept.
 *
 * `enabled: false` is the safety default: a plugin whose whole job is deleting
 * sessions must never start deleting on its own because a deployment forgot to
 * configure it.
 */
export const DEFAULT_AUTO_PURGE_CONFIG = Object.freeze({
  enabled: false,
  time: '12:25',
  workspaceScope: 'tree',
})

/** The two supported workspace-membership rules. */
export const WORKSPACE_SCOPES = Object.freeze(['tree', 'exact'])

/** `HH:MM` with one or two hour digits; the minute part is always two digits. */
const TIME_OF_DAY = /^(\d{1,2}):(\d{2})$/

/**
 * Whether the running platform compares paths case-insensitively.
 *
 * macOS and Windows do, and treating two spellings of one directory as
 * different would delete a session that actually lives inside a workspace.
 * Erring towards "same directory" is the safe direction here.
 */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin'

/**
 * Parse a local wall-clock time of day.
 *
 * Accepts `'9:05'` and `'09:05'`; rejects a non-string, a missing minute part
 * (`'12'`, `'12:5'`), a padded or malformed value (`' 12:25'`, `'12:25:00'`),
 * and out-of-range numbers (`'24:00'`, `'12:60'`).
 *
 * @param value - candidate from configuration.
 * @returns `{hour, minute}`, or null when the value is not a valid `HH:MM`.
 */
export function parseTimeOfDay(value) {
  if (typeof value !== 'string') return null
  const match = TIME_OF_DAY.exec(value)
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

/**
 * Normalize a raw plugin config into the shape the timer and the scope rule use.
 *
 * A missing field falls back to its default. A field that is *present but
 * unusable* (an unparseable `time`, an unknown `workspaceScope`) falls back to
 * the default as well, but marks the config invalid and forces `enabled: false`
 * — a typo in the schedule must not silently arm a destructive job with a
 * different schedule than the operator wrote.
 *
 * Only the strict boolean `true` enables the feature (`enabled: 1` or
 * `enabled: 'yes'` do not), which keeps "默认关闭" true no matter what a
 * profile author means by a truthy value.
 *
 * @param input - the plugin's config object (the second `apply` argument).
 * @returns `{ enabled, time, hour, minute, workspaceScope, valid }`.
 */
export function resolveAutoPurgeConfig(input = {}) {
  const source = input !== null && typeof input === 'object' ? input : {}
  let valid = true
  let time = DEFAULT_AUTO_PURGE_CONFIG.time
  if (source.time !== undefined) {
    if (parseTimeOfDay(source.time) === null) valid = false
    else time = source.time
  }
  let workspaceScope = DEFAULT_AUTO_PURGE_CONFIG.workspaceScope
  if (source.workspaceScope !== undefined) {
    if (!WORKSPACE_SCOPES.includes(source.workspaceScope)) valid = false
    else workspaceScope = source.workspaceScope
  }
  const parsed = parseTimeOfDay(time)
  return {
    enabled: valid && source.enabled === true,
    time,
    hour: parsed.hour,
    minute: parsed.minute,
    workspaceScope,
    valid,
  }
}

/**
 * The local calendar day of an instant, as `YYYY-MM-DD`.
 *
 * Local, not UTC: the schedule is a local wall-clock time, so "did today's run
 * already happen" has to be asked in the same timezone.
 *
 * @param nowMs - epoch milliseconds.
 * @returns local date key.
 */
export function localDateKey(nowMs) {
  const date = new Date(nowMs)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * The next instant a daily run at `time` is due, strictly after `nowMs`.
 *
 * "Strictly after" matters: at exactly 12:25:00.000 the 12:25 run is due *now*,
 * so the next one is tomorrow. Day arithmetic goes through the local `Date`
 * constructor, which rolls month and year over and keeps the wall-clock time
 * across a DST change.
 *
 * @param nowMs - epoch milliseconds.
 * @param time - `HH:MM`.
 * @returns epoch milliseconds of the next run.
 * @throws TypeError when `time` is not a valid `HH:MM`.
 */
export function nextRunAt(nowMs, time) {
  const parsed = parseTimeOfDay(time)
  if (parsed === null) throw new TypeError(`nextRunAt: invalid time of day ${JSON.stringify(time)}`)
  const now = new Date(nowMs)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsed.hour, parsed.minute, 0, 0)
  if (today.getTime() > nowMs) return today.getTime()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, parsed.hour, parsed.minute, 0, 0).getTime()
}

/**
 * Whether a run was missed and should happen right after startup.
 *
 * True when today's scheduled moment has already passed and no run was recorded
 * for today. A missing, null, empty, or non-string `lastRunDate` is treated as
 * "never ran" — the caller reads it from a state file that may be absent, and a
 * malformed value must not be able to disable the feature forever.
 *
 * @param options - `nowMs`, `time`, and the recorded `lastRunDate`.
 * @returns whether to catch up now.
 */
export function shouldCatchUp(options = {}) {
  const { nowMs, time, lastRunDate } = options
  const parsed = parseTimeOfDay(time)
  if (parsed === null) return false
  const now = new Date(nowMs)
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsed.hour, parsed.minute, 0, 0)
  if (nowMs < due.getTime()) return false
  const lastRun = typeof lastRunDate === 'string' && lastRunDate !== '' ? lastRunDate : undefined
  return lastRun !== localDateKey(nowMs)
}

/**
 * Fold a path for comparison on platforms that ignore case.
 *
 * @param value - normalized absolute path.
 * @returns the comparison key.
 */
function comparable(value) {
  return CASE_INSENSITIVE_PATHS ? value.toLowerCase() : value
}

/**
 * Canonicalize one directory path.
 *
 * Resolves to an absolute path and drops trailing separators, keeping the root
 * (`'/'`) intact. A non-string or blank value has no meaning as a directory and
 * yields undefined, so callers can drop it instead of accidentally resolving
 * `''` to the current working directory.
 *
 * @param value - candidate directory.
 * @returns the canonical path, or undefined.
 */
export function normalizeDir(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const resolved = path.resolve(value)
  if (resolved === path.parse(resolved).root) return resolved
  return resolved.replace(/[\\/]+$/, '')
}

/**
 * Whether two paths name the same directory.
 *
 * @param left - first path.
 * @param right - second path.
 * @returns whether they are equal after normalization.
 */
function sameDir(left, right) {
  const a = normalizeDir(left)
  const b = normalizeDir(right)
  if (a === undefined || b === undefined) return false
  return comparable(a) === comparable(b)
}

/**
 * Whether a path is a directory itself or lives inside it.
 *
 * The comparison is per path *segment*, so `'/Users/x/a2'` is not inside
 * `'/Users/x/a'` — a prefix check on the raw strings would silently keep or
 * delete the wrong directory. The filesystem root contains everything.
 *
 * @param candidate - path to test.
 * @param dir - containing directory.
 * @returns whether `candidate` is `dir` or below it.
 */
export function isInsideDir(candidate, dir) {
  const target = normalizeDir(candidate)
  const base = normalizeDir(dir)
  if (target === undefined || base === undefined) return false
  const foldedTarget = comparable(target)
  const foldedBase = comparable(base)
  if (foldedTarget === foldedBase) return true
  const root = comparable(path.parse(base).root)
  // The root ends with a separator already, so `base + sep` would double it.
  if (foldedBase === root) return foldedTarget.startsWith(root)
  return foldedTarget.startsWith(`${foldedBase}${path.sep}`)
}

/**
 * Split every session into kept and ungrouped, then pick the delete roots.
 *
 * Kept = the session's own `cwd` is inside (or equal to) a workspace path, plus
 * every descendant of a kept session: a workspace session's forks and subagent
 * sessions must survive with it, or the workspace's history would be left
 * half-deleted.
 *
 * A session without a usable `cwd` cannot be shown to belong to a workspace, so
 * it is ungrouped.
 *
 * `targets` are the ungrouped sessions whose parent is absent (unknown or
 * dangling) or already kept; deleting a root cascades to its descendants, so a
 * child of another ungrouped session is covered by its own root and is not
 * listed twice. An ungrouped parent/child *cycle* therefore has no root at all
 * and is left alone — the safe direction, and the traversal never loops.
 *
 * @param options - `snapshots`, `workspacePaths`, and `scope` ('tree' | 'exact').
 * @returns `{ targets, kept, ungrouped }`, all in snapshot order.
 */
export function selectPurgeTargets(options = {}) {
  const snapshots = Array.isArray(options.snapshots) ? options.snapshots : []
  const scope = options.scope === 'exact' ? 'exact' : 'tree'
  const dirs = [
    ...new Set(
      (Array.isArray(options.workspacePaths) ? options.workspacePaths : [])
        .map((entry) => normalizeDir(entry))
        .filter((entry) => entry !== undefined),
    ),
  ]

  const order = []
  const parents = new Map()
  const cwds = new Map()
  for (const snapshot of snapshots) {
    const header = snapshot?.header
    const id = header?.id
    if (typeof id !== 'string' || id === '' || parents.has(id)) continue
    order.push(id)
    parents.set(
      id,
      typeof header.parentSession === 'string' && header.parentSession !== '' ? header.parentSession : undefined,
    )
    cwds.set(id, typeof header.cwd === 'string' && header.cwd.trim() !== '' ? header.cwd : undefined)
  }

  const byParent = new Map()
  for (const id of order) {
    const parent = parents.get(id)
    if (parent === undefined) continue
    const children = byParent.get(parent)
    if (children === undefined) byParent.set(parent, [id])
    else children.push(id)
  }

  const kept = new Set()
  const queue = []
  for (const id of order) {
    const cwd = cwds.get(id)
    if (cwd === undefined) continue
    const inside = scope === 'exact' ? dirs.some((dir) => sameDir(cwd, dir)) : dirs.some((dir) => isInsideDir(cwd, dir))
    if (!inside) continue
    kept.add(id)
    queue.push(id)
  }
  // Propagating *downwards* from the kept set (instead of walking each session's
  // parent chain upwards) is what makes a parent cycle terminate.
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()) ?? []) {
      if (kept.has(child)) continue
      kept.add(child)
      queue.push(child)
    }
  }

  const ungrouped = order.filter((id) => !kept.has(id))
  const targets = []
  const seen = new Set()
  for (const id of ungrouped) {
    const parent = parents.get(id)
    // A root is a session whose parent is absent (no parent recorded, or a
    // dangling id whose parent session is already gone) or already kept.
    // Anything else is covered by deleting its own root, which cascades.
    const hasLiveParent = parent !== undefined && parents.has(parent)
    if (hasLiveParent && !kept.has(parent)) continue
    if (seen.has(id)) continue
    seen.add(id)
    targets.push(id)
  }
  return { targets, kept: [...kept], ungrouped }
}
