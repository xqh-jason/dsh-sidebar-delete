/**
 * The one place that decides *what* a delete request covers and *whether* it is
 * allowed, kept free of cordis and of the filesystem so the decision is
 * unit-testable on its own.
 *
 * The route in `index.js` is only wiring: it validates the body, asks this
 * module, mirrors the resulting ids onto the harness' `api-session/removed`
 * event, and answers. Keeping the safety decision here is deliberate — the
 * "do not delete a session under an open turn" refusal is the property this
 * plugin must never regress, and it is exercised by `test/delete-session.test.mjs`
 * and `test/host-plugin.test.mjs`.
 */

import { collectSubtree } from './session-store.mjs'

/**
 * Work out which sessions one request covers and whether any of them is busy.
 *
 * A known id is deleted together with every descendant (forks and subagent
 * sessions), because the sidebar hides subagent rows and an orphaned child
 * would otherwise be unreachable. An unknown id is still attempted on its own:
 * a session whose listing failed must not become undeletable.
 *
 * Liveness is deliberately richer than a boolean. The harness keeps an agent
 * alive for a session that was merely *opened* and never released, so a plain
 * "is it live?" check refuses sessions that are idle and invisible — the case a
 * user reported as "this session isn't running". A session is only refused when
 * a turn is actually open; when its activity cannot be determined at all, the
 * refusal stands and is reported under its own code.
 *
 * @param snapshots - persistence snapshots (`header`-bearing).
 * @param rootId - the requested session.
 * @param liveness - predicate `(id) => {live: boolean, running: boolean | undefined}`;
 *   `running: undefined` means "live, but activity unknown".
 * @returns the target ids, the blocked ones, the ones with an open turn, and whether the delete may proceed.
 */
export function planDelete(snapshots, rootId, liveness) {
  const subtree = collectSubtree(snapshots, rootId)
  const targets = subtree.length > 0 ? subtree : [rootId]
  const blocked = []
  const running = []
  for (const id of targets) {
    let state
    try {
      state = liveness(id)
    } catch {
      // A predicate that throws has not proved the session is idle.
      state = { live: true, running: undefined }
    }
    if (state === null || state === undefined || state.live !== true) continue
    if (state.running === false) continue
    blocked.push(id)
    if (state.running === true) running.push(id)
  }
  return { targets, blocked, running, allowed: blocked.length === 0 }
}

/**
 * Delete one session branch's local files.
 *
 * @param options - the target, the liveness predicate, the two roots, and the
 *   file-removal function (injectable for tests).
 * @returns a JSON-safe outcome; never throws for an expected failure.
 */
export async function deleteSessionBranch(options) {
  const { snapshots, rootId, liveness, sessionRoot, projcacheDir, remove } = options
  if (typeof remove !== 'function') throw new TypeError('deleteSessionBranch requires a remove() implementation')
  const plan = planDelete(snapshots, rootId, liveness)
  if (!plan.allowed) {
    const busy = plan.running.length > 0
    return {
      ok: false,
      code: busy ? 'session-active' : 'session-held',
      message: busy
        ? 'a session in this branch has an open turn; stop it before deleting'
        : 'the host still holds a session in this branch and its activity cannot be determined; restart dsh and retry',
      live: plan.blocked,
      running: plan.running,
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
