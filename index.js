/**
 * Host half of `dsh-sidebar-delete`.
 *
 * Owns exactly one capability: a session's local logs are removed on request
 * from the plugin's own browser half, and connected clients are told the
 * session is gone through the harness' own `api-session/removed` event (the
 * allowlisted event the session controller raises when a session is disposed).
 *
 * The harness has no deletion API for sessions, so the delete route is
 * deliberately narrow: one exact path, JSON only, a 64 KiB cap,
 * loopback-or-declared-host admission (or the host's own connection gate where
 * it applies), and a refusal whenever any session in the affected branch is
 * still live. It never touches attachments (content-addressed and shared) and
 * never writes another plugin's storage.
 *
 * A second exact path answers one read-only question — "does this session still
 * have a log directory on disk?" — because the running host keeps serving
 * sessions whose files this plugin already deleted. The manager panel asks that
 * question before listing a row, so a host-held ghost cannot reappear there.
 *
 * The safety decision itself lives in `src/delete-session.mjs`; this file is
 * wiring plus the two host facts it reads (where the logs are, which sessions
 * are live).
 *
 * @module dsh-sidebar-delete
 */

import { realpath, stat } from 'node:fs/promises'

import { deleteSessionBranch } from './src/delete-session.mjs'
import {
  collectSubtree,
  defaultStoragesRoot,
  findSessionDir,
  isSessionId,
  projectionCacheDir,
  removeSessionFiles,
  resolveSessionRoot,
} from './src/session-store.mjs'
import { authorityVerdict, hostGateVerdict, methodVerdict, readJsonBody } from './src/http-fence.mjs'
import {
  localDateKey,
  nextRunAt,
  normalizeDir,
  resolveAutoPurgeConfig,
  selectPurgeTargets,
  shouldCatchUp,
} from './src/auto-purge.mjs'
import { PURGE_STATE_VERSION, defaultPurgeStatePath, readPurgeState, writePurgeState } from './src/purge-state.mjs'

/** Required Host service: the browser HTTP carrier this route registers on. */
export const inject = ['webServer']

/** Exact path of the delete route. */
export const ROUTE_PATH = '/dsh-sidebar-delete/session'

/** Exact path of the read-only on-disk durability route. */
export const ROUTE_SESSIONS = '/dsh-sidebar-delete/sessions'

/** Hard request-body cap shared by both routes; the payload is a small JSON object. */
export const MAX_BODY_BYTES = 64 * 1024

/** Upper bound on the session ids one durability request may carry. */
const MAX_QUERY_IDS = 512

/** The persistence row whose `root` names the session-log directory. */
const PERSISTENCE_PACKAGE = '@deepseek-ai/dsh-session-persistence-jsonl'

/** Name of the effect that owns the auto-purge timer. */
const AUTO_PURGE_EFFECT = 'sidebar-delete: auto-purge timer'

/**
 * Register the delete route, the read-only durability route, and the optional
 * daily auto-purge, for as long as this plugin is mounted.
 *
 * `config` is the plugin's own configuration object, handed over by the host as
 * the second argument of this call (the shape `@openviking/dsh-memory-plugin`
 * documents as `apply(ctx, input = {})`). The auto-purge feature is off unless
 * that config says `enabled: true`; see `resolveAutoPurgeConfig` for the
 * accepted fields.
 *
 * @param ctx - host context carrying `webServer`.
 * @param config - the plugin's config object.
 * @returns undefined; the mounted effects are owned by `ctx.effect`.
 */
export function apply(ctx, config = {}) {
  /** One in-flight deletion per session id, so concurrent requests share it. */
  const inFlight = new Map()
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: (request, response) => {
          // Returning the promise keeps the handler awaitable (tests drive it
          // directly); the web carrier ignores the return value.
          return handleDeleteRequest(ctx, inFlight, request, response)
        },
      }),
    'sidebar-delete: session delete route',
  )
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_SESSIONS,
        handler: (request, response) => handleDurabilityRequest(ctx, request, response),
      }),
    'sidebar-delete: session durability route',
  )
  mountAutoPurge(ctx, resolveAutoPurgeConfig(config))
}

/**
 * Answer one request: admit, parse, delete, report.
 *
 * @param ctx - host context.
 * @param inFlight - shared single-flight map.
 * @param request - incoming request.
 * @param response - outgoing response.
 */
async function handleDeleteRequest(ctx, inFlight, request, response) {
  const method = methodVerdict(request)
  if (!method.ok) {
    sendJson(response, method.status, { ok: false, code: method.code, message: method.message })
    return
  }
  const admission = admissionOf(ctx, request)
  if (admission !== undefined) {
    sendJson(response, admission.status, { ok: false, code: admission.code, message: admission.message })
    return
  }
  const body = await readJsonBody(request, MAX_BODY_BYTES)
  if (!body.ok) {
    sendJson(response, body.status, { ok: false, code: body.code, message: body.message })
    return
  }
  const sessionId = body.value.sessionId
  if (!isSessionId(sessionId)) {
    sendJson(response, 400, {
      ok: false,
      code: 'bad-request',
      message: 'sessionId must be a session id ("session-<uuid>" or a bare uuid)',
    })
    return
  }
  let pending = inFlight.get(sessionId)
  if (pending === undefined) {
    pending = deleteSession(ctx, sessionId)
    inFlight.set(sessionId, pending)
    void pending.finally(() => inFlight.delete(sessionId))
  }
  const result = await pending
  sendJson(response, result.ok ? 200 : 409, result)
}

/**
 * Answer one read-only durability request: admit, parse, classify, report.
 *
 * Nothing is deleted and no event is emitted here: the panel only asks which of
 * the ids it is about to list still have a log directory, so a session the
 * running host keeps in memory after its files were deleted can be filtered
 * out of the management panel. Every failure is answered as a JSON error; this
 * handler never rejects.
 *
 * @param ctx - host context.
 * @param request - incoming request.
 * @param response - outgoing response.
 */
async function handleDurabilityRequest(ctx, request, response) {
  try {
    const method = methodVerdict(request)
    if (!method.ok) {
      sendJson(response, method.status, { ok: false, code: method.code, message: method.message })
      return
    }
    const admission = admissionOf(ctx, request)
    if (admission !== undefined) {
      sendJson(response, admission.status, { ok: false, code: admission.code, message: admission.message })
      return
    }
    const body = await readJsonBody(request, MAX_BODY_BYTES)
    if (!body.ok) {
      sendJson(response, body.status, { ok: false, code: body.code, message: body.message })
      return
    }
    const sessionIds = body.value.sessionIds
    if (!Array.isArray(sessionIds)) {
      sendJson(response, 400, {
        ok: false,
        code: 'bad-request',
        message: 'sessionIds must be an array of session ids ("session-<uuid>" or a bare uuid)',
      })
      return
    }
    if (sessionIds.length > MAX_QUERY_IDS) {
      sendJson(response, 400, {
        ok: false,
        code: 'bad-request',
        message: `sessionIds must hold at most ${MAX_QUERY_IDS} ids`,
      })
      return
    }
    if (!sessionIds.every((sessionId) => isSessionId(sessionId))) {
      sendJson(response, 400, {
        ok: false,
        code: 'bad-request',
        message: 'every entry of sessionIds must be a session id ("session-<uuid>" or a bare uuid)',
      })
      return
    }
    const root = resolveSessionRoot({ configRoot: configuredSessionRoot(ctx) })
    const { durable, missing } = await partitionDurability(root, sessionIds)
    sendJson(response, 200, { ok: true, durable, missing })
  } catch (error) {
    log(ctx, 'error', 'sidebar-delete: session durability probe failed', error)
    sendJson(response, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) })
  }
}

/**
 * Split ids by whether a log directory for each exists under the session root.
 *
 * `findSessionDir` flattens an unreadable root into "no such session", which is
 * right for deletion (nothing to delete) but wrong here: the panel would hide
 * every row on a permission or layout error. So a root that exists but is not a
 * directory is refused as an internal error instead of being answered as "all
 * missing".
 *
 * @param root - the resolved session-log root.
 * @param ids - validated session ids, in request order.
 * @returns `{durable, missing}`, both in request order.
 */
async function partitionDurability(root, ids) {
  const info = await statOrUndefined(root)
  if (info !== undefined && !info.isDirectory()) {
    throw new Error(`the session-log root is not a directory: ${root}`)
  }
  const durable = []
  const missing = []
  for (const id of ids) {
    const directory = await findSessionDir(root, id)
    if (directory === undefined) missing.push(id)
    else durable.push(id)
  }
  return { durable, missing }
}

/**
 * `stat` that maps an absent target to undefined and lets every other failure
 * reach the caller.
 *
 * @param target - path to inspect.
 * @returns the stat result, or undefined when the target does not exist.
 */
async function statOrUndefined(target) {
  try {
    return await stat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Admit or refuse one request.
 *
 * The host's own connection gate decides whenever it is applicable (it also
 * enforces browser login there); otherwise this plugin's own loopback and
 * same-origin fence does.
 *
 * @param ctx - host context.
 * @param request - incoming request.
 * @returns undefined when admitted, or the refusal to answer.
 */
function admissionOf(ctx, request) {
  const gate = hostGateVerdict(ctx.get('connection'), request)
  if (gate.consulted) {
    if (gate.status === undefined) return undefined
    return gate.status === 401
      ? { status: 401, code: 'unauthorized', message: 'the request is not authenticated' }
      : { status: 403, code: 'untrusted-origin', message: 'the host connection gate refused this request' }
  }
  const authority = authorityVerdict(request, { trustedHosts: trustedHostsOf(ctx) })
  if (authority.ok) return undefined
  return { status: authority.status, code: authority.code, message: authority.message }
}

/**
 * Remove one session branch from local storage.
 *
 * @param ctx - host context.
 * @param requestedId - the session the user asked to delete.
 * @returns a JSON-safe outcome; never rejects.
 */
async function deleteSession(ctx, requestedId) {
  try {
    const result = await deleteSessionBranch({
      snapshots: await listSnapshots(ctx),
      rootId: requestedId,
      liveness: (id) => livenessOf(ctx, id),
      sessionRoot: resolveSessionRoot({ configRoot: configuredSessionRoot(ctx) }),
      projcacheDir: projectionCacheDir(defaultStoragesRoot()),
      remove: removeSessionFiles,
    })
    for (const id of result.deleted) ctx.emit('api-session/removed', id)
    if (result.deleted.length > 0) {
      // A deleted session's id also lives in the workspace service (archive set,
      // pin set, and per-workspace accounting). Retire those references here so
      // this plugin cannot leave dangling ids behind; both removal paths are
      // documented as tolerating a session that no longer exists.
      result.cleanupSteps = await cleanRegistrations(ctx, result.deleted)
    }
    if (result.ok) log(ctx, 'info', `sidebar-delete: deleted ${result.deleted.join(', ')}`)
    else log(ctx, 'warn', `sidebar-delete: ${requestedId} not deleted (${result.code})`, result.failures ?? result.live)
    return result
  } catch (error) {
    log(ctx, 'error', `sidebar-delete: deleting ${requestedId} failed`, error)
    return { ok: false, code: 'internal', message: String(error?.message ?? error), deleted: [], failures: [] }
  }
}

/**
 * Retire a deleted session's references from the workspace service.
 *
 * The registry keeps `archivedSessionIds`, `pinnedSessionIds`, and one
 * `sessionIds` accounting list per workspace, all keyed by session id. Deleting
 * the log would otherwise leave those pointing at nothing. `unarchiveSession`,
 * `unpinSession`, and `Workspace.detachSession` are the sanctioned removals and
 * none of them validates that the session still exists — removing a reference
 * cannot introduce an unknown one, which is exactly why they can retire an id
 * whose session is gone.
 *
 * @param ctx - host context.
 * @param ids - the sessions this request deleted.
 * @returns how many cleanup calls resolved, or undefined when the service is absent.
 *   The services' removals are void, so this is a step count, not a removed-reference count.
 */
async function cleanRegistrations(ctx, ids) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') return undefined
  let retired = 0
  for (const id of ids) {
    if (typeof registry.unarchiveSession === 'function') {
      try {
        await registry.unarchiveSession(id)
        retired += 1
      } catch (error) {
        log(ctx, 'warn', `sidebar-delete: could not unarchive ${id}`, error)
      }
    }
    if (typeof registry.unpinSession === 'function') {
      try {
        await registry.unpinSession(id)
      } catch (error) {
        log(ctx, 'warn', `sidebar-delete: could not unpin ${id}`, error)
      }
    }
  }
  let workspaces = []
  try {
    workspaces = registry.list() ?? []
  } catch (error) {
    log(ctx, 'warn', 'sidebar-delete: could not list workspaces for cleanup', error)
    return retired
  }
  for (const workspace of workspaces) {
    if (typeof workspace?.detachSession !== 'function') continue
    for (const id of ids) {
      // Deliberately not guarded by `workspace.sessionIds.includes(id)`:
      // that getter filters ids whose session is unknown, which is exactly the
      // dangling entry being retired here. `detachSession` filters the raw
      // record and its write path skips an unchanged record, so calling it for
      // every workspace is both safe and the only way to reach such an id.
      try {
        await workspace.detachSession(id)
        retired += 1
      } catch (error) {
        log(ctx, 'warn', `sidebar-delete: could not detach ${id} from a workspace`, error)
      }
    }
  }
  return retired
}

/**
 * Run one "delete every ungrouped session" round.
 *
 * The scope rule is directory-based: a session whose recorded `cwd` is inside a
 * registered workspace path (or equal to it, under the `exact` scope) is kept,
 * together with everything descending from it. Everything else is ungrouped.
 * Pinning and archiving deliberately exempt nothing; an open turn does, because
 * deleting underneath one corrupts state.
 *
 * Two refusals protect the round, and both of them change nothing:
 *
 * - No workspace registry: without it every session would look ungrouped, so
 *   the only safe answer is to delete nothing at all. This is the feature's
 *   safety red line.
 * - No session listing: without it there is nothing to decide on.
 *
 * @param ctx - host context.
 * @param options - optional `scope` override ('tree' | 'exact'; default 'tree').
 * @returns a JSON-safe summary `{ ok, code?, scanned, targets, deleted, skipped, failures }`
 *   where `scanned` is a count, `targets`/`deleted`/`skipped` are id lists, and
 *   `failures` holds `{id, code, message}` records. `ok` is false when the round
 *   aborted, when a target could not be fully removed, or when one threw.
 */
export async function purgeUngroupedOnce(ctx, options = {}) {
  const scope = options.scope === 'exact' ? 'exact' : 'tree'
  const aborted = (code) => ({ ok: false, code, scanned: 0, targets: [], deleted: [], skipped: [], failures: [] })

  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || registry === null || typeof registry.list !== 'function') {
    log(ctx, 'error', 'sidebar-delete: auto-purge aborted — no workspace registry, deleting nothing')
    return aborted('no-registry')
  }
  let workspaces
  try {
    workspaces = registry.list() ?? []
  } catch (error) {
    // Same red line: a registry that cannot be listed cannot tell grouped from
    // ungrouped either.
    log(ctx, 'error', 'sidebar-delete: auto-purge aborted — the workspace registry could not be listed, deleting nothing', error)
    return aborted('no-registry')
  }
  const workspacePaths = await workspacePathsOf(workspaces)

  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || persistence === null || typeof persistence.list !== 'function') {
    log(ctx, 'error', 'sidebar-delete: auto-purge aborted — no session persistence, deleting nothing')
    return aborted('no-persistence')
  }
  let snapshots
  try {
    snapshots = await listSnapshots(ctx)
  } catch (error) {
    log(ctx, 'error', 'sidebar-delete: auto-purge aborted — the session listing failed, deleting nothing', error)
    return aborted('list-failed')
  }

  const scanned = countSessionIds(snapshots)
  const plan = selectPurgeTargets({ snapshots, workspacePaths, scope })
  const kept = new Set(plan.kept)
  // A branch delete cascades to descendants, so a target whose subtree holds a
  // kept session is left alone: the directory rule that keeps workspace
  // sessions wins over the cascade. Without this guard an ungrouped parent with
  // one workspace-cwd child would take that child's log down with it.
  const targets = plan.targets.filter((id) => !branchTouchesKept(id, snapshots, kept))
  log(ctx, 'info', `sidebar-delete: auto-purge targets=${targets.length} [${targets.join(', ')}]`)

  const sessionRoot = resolveSessionRoot({ configRoot: configuredSessionRoot(ctx) })
  const projcacheDir = projectionCacheDir(defaultStoragesRoot())
  const deleted = []
  const skipped = []
  const failures = []
  for (const rootId of targets) {
    try {
      const outcome = await deleteSessionBranch({
        snapshots,
        rootId,
        liveness: (id) => livenessOf(ctx, id),
        sessionRoot,
        projcacheDir,
        remove: removeSessionFiles,
      })
      for (const id of outcome.deleted ?? []) if (!deleted.includes(id)) deleted.push(id)
      if (outcome.ok) continue
      if (outcome.code === 'session-active' || outcome.code === 'session-held') {
        skipped.push(rootId)
        log(ctx, 'warn', `sidebar-delete: auto-purge kept ${rootId} (${outcome.code})`)
        continue
      }
      // `partial`: the ids it did remove are gone and are reported like any
      // other deletion; the rest is a failure. One bad target must never abort
      // the round for the others.
      for (const failure of outcome.failures ?? []) {
        failures.push({
          id: failure?.id ?? rootId,
          code: failure?.code ?? 'EUNKNOWN',
          message: failure?.message ?? 'unknown failure',
        })
      }
    } catch (error) {
      failures.push({ id: rootId, code: 'EUNKNOWN', message: String(error?.message ?? error) })
      log(ctx, 'warn', `sidebar-delete: auto-purge failed on ${rootId}`, error)
    }
  }

  for (const id of deleted) ctx.emit('api-session/removed', id)
  if (deleted.length > 0) {
    try {
      await cleanRegistrations(ctx, deleted)
    } catch (error) {
      log(ctx, 'warn', 'sidebar-delete: auto-purge could not retire workspace registrations', error)
    }
  }

  log(
    ctx,
    'info',
    `sidebar-delete: auto-purge scanned=${scanned} targets=${targets.length} deleted=${deleted.length} skipped=${skipped.length} failures=${failures.length}`,
  )
  return { ok: failures.length === 0, scanned, targets, deleted, skipped, failures }
}

/**
 * The workspace paths a round may treat as "grouped".
 *
 * Both the declared path and its `realpath` are offered, because a workspace
 * registered through a symlinked (or `/var` vs `/private/var`) spelling must
 * still match the `cwd` recorded in a session header. A workspace whose
 * directory is gone keeps matching by its declared path; the realpath is only a
 * second chance.
 *
 * @param workspaces - `registry.list()` result.
 * @returns canonical candidate paths.
 */
async function workspacePathsOf(workspaces) {
  const paths = new Set()
  for (const workspace of workspaces ?? []) {
    const declared = workspace?.path
    if (typeof declared !== 'string' || declared.trim() === '') continue
    const normalized = normalizeDir(declared)
    if (normalized === undefined) continue
    paths.add(normalized)
    try {
      const real = normalizeDir(await realpath(declared))
      if (real !== undefined) paths.add(real)
    } catch {
      // An unresolvable path is not an error: the declared spelling still works.
    }
  }
  return [...paths]
}

/**
 * Whether deleting a target would cascade into a session the scope rule keeps.
 *
 * @param rootId - candidate delete root.
 * @param snapshots - persistence snapshots.
 * @param kept - the kept id set from `selectPurgeTargets`.
 * @returns whether any session in the branch is kept.
 */
function branchTouchesKept(rootId, snapshots, kept) {
  if (kept.size === 0) return false
  return collectSubtree(snapshots, rootId).some((id) => kept.has(id))
}

/**
 * How many distinct session ids a snapshot listing holds.
 *
 * @param snapshots - persistence snapshots.
 * @returns the distinct id count.
 */
function countSessionIds(snapshots) {
  const ids = new Set()
  for (const snapshot of snapshots ?? []) {
    const id = snapshot?.header?.id
    if (typeof id === 'string' && id !== '') ids.add(id)
  }
  return ids.size
}

/**
 * Arm the optional daily auto-purge timer.
 *
 * Disabled means *disabled*: the function returns undefined without reading the
 * state file and without creating a timer, so an unconfigured plugin costs
 * nothing and can never delete anything.
 *
 * When enabled it reads the state file once: if today's moment already passed
 * and no run was recorded for today, it starts a catch-up round immediately
 * (never blocking the caller's synchronous `apply` return) and resumes the
 * daily cadence afterwards; otherwise it just schedules the next run.
 *
 * @param ctx - host context.
 * @param config - resolved config from `resolveAutoPurgeConfig`.
 * @param deps - injectable `now`, `setTimer`, `clearTimer`, `run`, `statePath`,
 *   `readState`, `writeState` (tests).
 * @returns `{ dispose, ready }`, or undefined when the feature is disabled.
 *   `ready` settles once the startup decision has been applied.
 */
export function mountAutoPurge(ctx, config, deps = {}) {
  // Resolving again is idempotent for the caller's resolved config and makes the
  // exported function safe to call with a raw one: a bad `time` disarms the
  // feature instead of throwing out of a timer.
  const resolved = resolveAutoPurgeConfig(config)
  if (resolved.enabled !== true) {
    log(ctx, 'info', 'sidebar-delete: auto-purge is disabled')
    return undefined
  }
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const setTimer = typeof deps.setTimer === 'function' ? deps.setTimer : setTimeout
  const clearTimer = typeof deps.clearTimer === 'function' ? deps.clearTimer : clearTimeout
  const run =
    typeof deps.run === 'function' ? deps.run : (host) => purgeUngroupedOnce(host, { scope: resolved.workspaceScope })
  const statePath =
    typeof deps.statePath === 'string' && deps.statePath !== '' ? deps.statePath : defaultPurgeStatePath()
  const readState =
    typeof deps.readState === 'function'
      ? deps.readState
      : () => readPurgeState(statePath, { onWarn: (message, error) => log(ctx, 'warn', message, error) })
  const writeState = typeof deps.writeState === 'function' ? deps.writeState : (state) => writePurgeState(statePath, state)

  let timer
  let disposed = false
  let inFlight = false

  /** Schedule the next daily run. A disposed timer never re-arms itself. */
  function schedule() {
    if (disposed) return
    const current = now()
    timer = setTimer(() => fire(), nextRunAt(current, resolved.time) - current)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  /** Record one completed round. A failed write is a warning, never a failure. */
  async function persist(summary) {
    const stamp = now()
    const state = {
      version: PURGE_STATE_VERSION,
      lastRunDate: localDateKey(stamp),
      lastRunAt: new Date(stamp).toISOString(),
      summary: summary ?? null,
    }
    try {
      await writeState(state)
    } catch (error) {
      log(ctx, 'warn', 'sidebar-delete: auto-purge could not write its state file', error)
    }
  }

  /**
   * Run one round and re-arm. The in-flight flag is shared by the catch-up run
   * and timer fires, so an overlapping trigger is skipped rather than starting a
   * second round on top of the first.
   */
  async function fire() {
    if (disposed) return
    if (inFlight) {
      log(ctx, 'info', 'sidebar-delete: auto-purge skipped an overlapping run')
      return
    }
    inFlight = true
    let summary
    try {
      summary = await run(ctx)
    } catch (error) {
      log(ctx, 'warn', 'sidebar-delete: auto-purge run failed', error)
    } finally {
      inFlight = false
    }
    // Only a *completed* round is recorded: a round that threw must not mark the
    // day as done, or the next startup would never retry it.
    if (summary !== undefined) await persist(summary)
    schedule()
  }

  /** Stop the timer; idempotent, and used both by the host and by tests. */
  function dispose() {
    if (disposed) return
    disposed = true
    if (timer !== undefined) clearTimer(timer)
  }
  ctx.effect(() => dispose, AUTO_PURGE_EFFECT)

  const ready = (async () => {
    let state = {}
    try {
      state = (await readState()) ?? {}
    } catch (error) {
      log(ctx, 'warn', 'sidebar-delete: auto-purge could not read its state file', error)
    }
    if (shouldCatchUp({ nowMs: now(), time: resolved.time, lastRunDate: state.lastRunDate })) {
      log(ctx, 'info', 'sidebar-delete: auto-purge catching up on a missed run')
      await fire()
      return
    }
    schedule()
  })()

  return { dispose, ready }
}

/**
 * Every stored session snapshot, or none when persistence is unavailable.
 *
 * @param ctx - host context.
 * @returns persistence snapshots.
 */
async function listSnapshots(ctx) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || typeof persistence.list !== 'function') return []
  return await persistence.list()
}

/**
 * Classify one session's liveness, and — when it is live — whether a turn is
 * actually open.
 *
 * The harness keeps an agent alive for a session that was merely opened and
 * never released, which is why "live" alone is the wrong refusal test: it would
 * refuse idle, invisible sessions. Deleting underneath an OPEN TURN is what
 * corrupts state, so that is the only thing refused; when an agent holds a
 * session whose event stream cannot be read, the answer is "unknown" and the
 * caller refuses under its own code.
 *
 * @param ctx - host context.
 * @param sessionId - candidate.
 * @returns `{live, running}` where `running: undefined` means unknown.
 */
function livenessOf(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  const session = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
  if (session !== undefined) return { live: true, running: isTurnOpen(session) }
  const agents = ctx.get('agents')
  if (agents !== undefined && typeof agents.get === 'function' && agents.get(sessionId) !== undefined) {
    return { live: true, running: undefined }
  }
  return { live: false, running: false }
}

/**
 * Whether a live session has an open turn.
 *
 * Reads the last committed events: the newest `turn/end` before any `turn/start`
 * means idle. A session with no turn events at all (freshly created, never
 * prompted) is idle. Any failure to read the stream counts as "unknown", which
 * the caller treats as busy.
 *
 * @param session - a live harness session.
 * @returns whether a turn is open; `undefined` when the stream cannot be read.
 */
function isTurnOpen(session) {
  try {
    const last = Number(session.seq) - 1
    if (!Number.isFinite(last)) return undefined
    const floor = Math.max(0, last - 500)
    for (let seq = last; seq >= floor; seq -= 1) {
      const event = session.eventAt(seq)
      if (event === undefined) continue
      if (event.type === 'turn/end') return false
      if (event.type === 'turn/start') return true
    }
    return false
  } catch {
    return undefined
  }
}

/**
 * The session-log root as the mounted persistence row configures it.
 *
 * Read through the live config editor rather than assuming the dsh-base
 * default, so a profile that relocates `root` still deletes the real files.
 *
 * @param ctx - host context.
 * @returns the configured root, or undefined to fall back to `$DSH_HOME/sessions`.
 */
function configuredSessionRoot(ctx) {
  const editor = ctx.get('configEditor')
  if (editor === undefined) return undefined
  try {
    if (typeof editor.configuration === 'function') {
      for (const row of editor.configuration() ?? []) {
        if (rowName(row) !== PERSISTENCE_PACKAGE) continue
        const root = row?.override?.root ?? row?.inherited?.root
        if (typeof root === 'string' && root.trim() !== '') return root
      }
    }
    if (typeof editor.entries === 'function') {
      for (const entry of editor.entries() ?? []) {
        if (rowName(entry) !== PERSISTENCE_PACKAGE) continue
        const root = entry?.config?.root ?? entry?.options?.config?.root
        if (typeof root === 'string' && root.trim() !== '') return root
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/** @returns the package name a config-editor row or entry refers to. */
function rowName(row) {
  const name = row?.entry?.name ?? row?.name
  return typeof name === 'string' ? name : undefined
}

/**
 * The deployment's declared authorities, as the `connection` service exposes
 * them. That list is not part of the published service contract, so an absent
 * value simply narrows the fence to loopback.
 *
 * @param ctx - host context.
 * @returns declared authorities (empty when unavailable).
 */
function trustedHostsOf(ctx) {
  try {
    const connection = ctx.get('connection')
    const declared = connection?.trustedHosts
    return Array.isArray(declared) ? declared.filter((entry) => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/**
 * Write one JSON response.
 *
 * @param response - outgoing response.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/**
 * Log through the host logger when it exists, so this never throws on a
 * composition without one.
 *
 * @param ctx - host context.
 * @param level - log level.
 * @param message - message.
 * @param detail - optional detail.
 */
function log(ctx, level, message, detail) {
  const logger = ctx.logger
  const write = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : console[level]?.bind(console)
  if (typeof write !== 'function') return
  if (detail === undefined) write(message)
  else write(message, detail)
}
