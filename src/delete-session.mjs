/**
 * The one place that decides *what* a delete request covers and *whether* it is
 * allowed, kept free of cordis and of the filesystem so the decision is
 * unit-testable on its own.
 *
 * The route in `index.js` is only wiring: it validates the body, asks this
 * module, mirrors the resulting ids onto the harness' `api-session/removed`
 * event, and answers. Keeping the safety decision here is deliberate — the
 * live-session refusal is the property this plugin must never regress, and it
 * is exercised by `test/delete-session.test.mjs` and `test/host-plugin.test.mjs`.
 */

import { collectSubtree } from './session-store.mjs'

/**
 * Work out which sessions one request covers.
 *
 * A known id is deleted together with every descendant (forks and subagent
 * sessions), because the sidebar hides subagent rows and an orphaned child
 * would otherwise be unreachable. An unknown id is still attempted on its own:
 * a session whose listing failed must not become undeletable.
 *
 * @param snapshots - persistence snapshots (`header`-bearing).
 * @param rootId - the requested session.
 * @param isLive - predicate answering whether one session is live in this process.
 * @returns the target ids, the live ones among them, and whether the delete may proceed.
 */
export function planDelete(snapshots, rootId, isLive) {
  const subtree = collectSubtree(snapshots, rootId)
  const targets = subtree.length > 0 ? subtree : [rootId]
  const live = targets.filter((id) => {
    try {
      return isLive(id) === true
    } catch {
      // A predicate that throws has not proved the session is idle.
      return true
    }
  })
  return { targets, live, allowed: live.length === 0 }
}

/**
 * Delete one session branch's local files.
 *
 * @param options - the target, the live predicate, the two roots, and the
 *   file-removal function (injectable for tests).
 * @returns a JSON-safe outcome; never throws for an expected failure.
 */
export async function deleteSessionBranch(options) {
  const { snapshots, rootId, isLive, sessionRoot, projcacheDir, remove } = options
  if (typeof remove !== 'function') throw new TypeError('deleteSessionBranch requires a remove() implementation')
  const plan = planDelete(snapshots, rootId, isLive)
  if (!plan.allowed) {
    return {
      ok: false,
      code: 'session-active',
      message: 'this session (or one of its child sessions) is still running or open; stop it before deleting',
      live: plan.live,
      deleted: [],
      failures: [],
    }
  }
  const outcome = await remove({ sessionRoot, projcacheDir, ids: plan.targets })
  const deleted = [...(outcome.removed ?? []), ...(outcome.missing ?? [])]
  const failures = outcome.failures ?? []
  if (failures.length > 0) {
    return {
      ok: false,
      code: 'partial',
      message: `${failures.length} file target(s) could not be removed`,
      deleted,
      failures,
    }
  }
  return { ok: true, deleted, failures: [] }
}
