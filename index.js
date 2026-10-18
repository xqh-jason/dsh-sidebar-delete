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
 * admission, and a refusal whenever any session in the affected branch is still
 * live. It never touches attachments (content-addressed and shared) and never
 * writes another plugin's storage.
 *
 * @module dsh-sidebar-delete
 */

import {
  collectSubtree,
  defaultStoragesRoot,
  isSessionId,
  projectionCacheDir,
  removeSessionFiles,
  resolveSessionRoot,
} from './src/session-store.mjs'
import { fenceVerdict, readJsonBody } from './src/http-fence.mjs'

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
          void handleDeleteRequest(ctx, inFlight, request, response)
        },
      }),
    'sidebar-delete: session delete route',
  )
}

/**
 * Answer one request: fence, parse, delete, report.
 *
 * @param ctx - host context.
 * @param inFlight - shared single-flight map.
 * @param request - incoming request.
 * @param response - outgoing response.
 */
async function handleDeleteRequest(ctx, inFlight, request, response) {
  const verdict = fenceVerdict(request, { trustedHosts: trustedHostsOf(ctx) })
  if (!verdict.ok) {
    sendJson(response, verdict.status, { ok: false, code: verdict.code, message: verdict.message })
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
      message: 'sessionId must be a session id of the form "session-<uuid>"',
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
 * Remove one session branch from local storage.
 *
 * @param ctx - host context.
 * @param requestedId - the session the user asked to delete.
 * @returns a JSON-safe outcome; never rejects.
 */
async function deleteSession(ctx, requestedId) {
  try {
    const snapshots = await listSnapshots(ctx)
    const subtree = collectSubtree(snapshots, requestedId)
    // An unknown id still gets its directory removed: a session whose listing
    // failed must not become undeletable.
    const targets = subtree.length > 0 ? subtree : [requestedId]
    const live = targets.filter((id) => isLive(ctx, id))
    if (live.length > 0) {
      return {
        ok: false,
        code: 'session-active',
        message:
          'this session (or one of its child sessions) is still running or open; stop it before deleting',
        live,
        deleted: [],
      }
    }
    const sessionRoot = resolveSessionRoot({ configRoot: configuredSessionRoot(ctx) })
    const projcache = projectionCacheDir(defaultStoragesRoot())
    const outcome = await removeSessionFiles({ sessionRoot, projcacheDir: projcache, ids: targets })
    const gone = [...outcome.removed, ...outcome.missing]
    for (const id of gone) ctx.emit('api-session/removed', id)
    if (outcome.failures.length > 0) {
      log(ctx, 'warn', `sidebar-delete: ${requestedId} partially deleted`, outcome.failures)
      return {
        ok: false,
        code: 'partial',
        message: `${outcome.failures.length} file target(s) could not be removed`,
        deleted: gone,
        failures: outcome.failures,
      }
    }
    log(ctx, 'info', `sidebar-delete: deleted ${gone.join(', ')}`)
    return { ok: true, deleted: gone, sessionRoot }
  } catch (error) {
    log(ctx, 'error', `sidebar-delete: deleting ${requestedId} failed`, error)
    return {
      ok: false,
      code: 'internal',
      message: String(error?.message ?? error),
      deleted: [],
    }
  }
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
 * @param ctx - host context.
 * @returns the deployment's declared authorities (empty when unavailable).
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
