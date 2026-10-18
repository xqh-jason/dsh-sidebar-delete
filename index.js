/**
 * Host half of `dsh-sidebar-delete`.
 *
 * Owns exactly one capability: a session's local logs are removed on request
 * from the plugin's own browser half, and connected clients are told the
 * session is gone through the harness' own `api-session/removed` event (the
 * allowlisted event the session controller raises when a session is disposed).
 *
 * The harness has no deletion API for sessions, so this route is deliberately
 * narrow: one exact path, JSON only, a 64 KiB cap, loopback-or-declared-host
 * admission (or the host's own connection gate where it applies), and a
 * refusal whenever any session in the affected branch is still live. It never
 * touches attachments (content-addressed and shared) and never writes another
 * plugin's storage.
 *
 * The safety decision itself lives in `src/delete-session.mjs`; this file is
 * wiring plus the two host facts it reads (where the logs are, which sessions
 * are live).
 *
 * @module dsh-sidebar-delete
 */

import { deleteSessionBranch } from './src/delete-session.mjs'
import {
  defaultStoragesRoot,
  isSessionId,
  projectionCacheDir,
  removeSessionFiles,
  resolveSessionRoot,
} from './src/session-store.mjs'
import { authorityVerdict, hostGateVerdict, methodVerdict, readJsonBody } from './src/http-fence.mjs'

/** Required Host service: the browser HTTP carrier this route registers on. */
export const inject = ['webServer']

/** Exact path of the only route this plugin publishes. */
export const ROUTE_PATH = '/dsh-sidebar-delete/session'

/** Hard request-body cap; the payload is one session id. */
export const MAX_BODY_BYTES = 64 * 1024

/** The persistence row whose `root` names the session-log directory. */
const PERSISTENCE_PACKAGE = '@deepseek-ai/dsh-session-persistence-jsonl'

/**
 * Register the delete route for as long as this plugin is mounted.
 *
 * @param ctx - host context carrying `webServer`.
 */
export function apply(ctx) {
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
      isLive: (id) => isLive(ctx, id),
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
 * Whether a session is live in this process: entered in the session store or
 * held by an agent. Deleting files underneath either would corrupt state.
 *
 * @param ctx - host context.
 * @param sessionId - candidate.
 * @returns whether the session is live.
 */
function isLive(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && typeof sessions.get === 'function' && sessions.get(sessionId) !== undefined) {
    return true
  }
  const agents = ctx.get('agents')
  if (agents !== undefined && typeof agents.get === 'function' && agents.get(sessionId) !== undefined) {
    return true
  }
  return false
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
