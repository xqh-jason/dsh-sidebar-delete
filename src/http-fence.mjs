/**
 * Pure request-fence helpers for the plugin's HTTP route.
 *
 * Kept free of cordis and of `node:http` types so the rules can be unit-tested
 * directly: the route registers on the bare `webServer`, so exact-match
 * registrations bypass the host's own /api fence and must decide admission
 * themselves.
 *
 * The rules mirror what a shipped third-party plugin in this profile uses
 * (dshmarket's lib/http.js): `Host` is the one header a DNS-rebinding page
 * cannot forge, so it has to name loopback or an authority the deployment
 * declared; an `Origin`, when present, must match that `Host`; an absent
 * `Origin` is allowed because the Desktop carrier strips it before forwarding.
 */

/** Read one header value from a Node request, or undefined. */
export function headerOf(request, name) {
  const headers = request?.headers
  if (headers === undefined || headers === null) return undefined
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : undefined
}

/**
 * Parse a bare `host[:port]` authority, or null when the value is not one.
 *
 * "Not one" is narrower than "`new URL` accepted it": an entry must survive
 * WHATWG parsing unchanged, so `dsh.example.org/path` never authorizes a name
 * the operator did not write.
 *
 * @param value - candidate authority.
 * @returns the parsed URL, or null.
 */
export function parseAuthority(value) {
  if (typeof value !== 'string' || value === '') return null
  try {
    const url = new URL(`http://${value}`)
    const canonical = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`
    return canonical === value.toLowerCase() ? url : null
  } catch {
    return null
  }
}

/**
 * Whether a `Host` header names a loopback authority.
 *
 * `localhost` is included because browsers and RFC 6761 pin it to loopback;
 * `localhost.evil.com` does not match, and the port is dropped before comparing.
 *
 * @param host - the request's `Host` header.
 * @returns whether it names a loopback authority.
 */
export function isLoopbackAuthority(host) {
  if (typeof host !== 'string' || host === '') return false
  const lower = host.toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/**
 * Whether a `Host` header matches one of the deployment's declared authorities.
 *
 * A port-less entry matches the hostname on any port (the shape the CLI derives
 * for IP-literal LAN serving, where the bound port may be OS-assigned); an entry
 * with a port matches that exact authority.
 *
 * @param host - the request's `Host` header.
 * @param trustedHosts - declared authorities.
 * @returns whether the request authority is declared.
 */
export function isTrustedAuthority(host, trustedHosts) {
  const hostUrl = parseAuthority(host)
  if (hostUrl === null || !Array.isArray(trustedHosts)) return false
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === null) return false
    return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

/**
 * True when the request's `Origin`, if it has one, matches its `Host`.
 *
 * A cross-site page is refused (its Origin is present and different), `null`
 * and empty origins are refused (present but unparseable is not absent), and
 * only absence is treated as "not a page" — which is what a stripping Desktop
 * proxy produces.
 *
 * @param origin - the request's `Origin` header.
 * @param host - the request's `Host` header.
 * @returns whether the request may mutate plugin-visible state.
 */
export function sameOrigin(origin, host) {
  if (typeof origin !== 'string' || origin === '') return false
  if (typeof host !== 'string' || host === '') return false
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  return url.host.toLowerCase() === host.toLowerCase()
}

/**
 * Decide whether the request's method and media type are acceptable, before
 * anything about the caller is considered.
 *
 * @param request - incoming request.
 * @returns an admission verdict; `{ ok: false }` carries the status to answer.
 */
export function methodVerdict(request) {
  const method = String(request?.method ?? 'GET').toUpperCase()
  if (method !== 'POST') {
    return { ok: false, status: 405, code: 'method-not-allowed', message: 'only POST is accepted' }
  }
  const contentType = headerOf(request, 'content-type')
  if (contentType === undefined || !contentType.toLowerCase().includes('application/json')) {
    return { ok: false, status: 415, code: 'unsupported-media-type', message: 'content-type must be application/json' }
  }
  return { ok: true }
}

/**
 * Decide whether this plugin trusts the request's authority and origin.
 *
 * The fallback used when the host publishes no connection gate. It answers the
 * two questions such a gate answers for a local carrier: the `Host` is loopback
 * or an authority the deployment declared, and a present `Origin` matches it.
 *
 * @param request - incoming request.
 * @param options - declared authorities (from the host `connection` service).
 * @returns an admission verdict; `{ ok: false }` carries the status to answer.
 */
export function authorityVerdict(request, options = {}) {
  const host = headerOf(request, 'host')
  if (!isLoopbackAuthority(host) && !isTrustedAuthority(host, options.trustedHosts ?? [])) {
    return {
      ok: false,
      status: 403,
      code: 'untrusted-origin',
      message: 'the request Host is neither loopback nor an authority this deployment declared',
    }
  }
  const origin = headerOf(request, 'origin')
  if (origin !== undefined && !sameOrigin(origin, host)) {
    return { ok: false, status: 403, code: 'untrusted-origin', message: 'the request Origin does not match its Host' }
  }
  return { ok: true }
}

/**
 * Decide whether a request may reach the delete handler using this plugin's own
 * checks alone (method, media type, authority, origin).
 *
 * @param request - incoming request.
 * @param options - declared authorities (from the host `connection` service).
 * @returns an admission verdict; `{ ok: false }` carries the status to answer.
 */
export function fenceVerdict(request, options = {}) {
  const method = methodVerdict(request)
  if (!method.ok) return method
  return authorityVerdict(request, options)
}

/**
 * Ask the host's own connection gate, which applies the harness' Host/Origin
 * checks *and* browser authentication to another route.
 *
 * Consulted only where the deployment accepts remote authorities. On the
 * loopback-only Desktop carrier that gate's authentication half is unmeasured
 * for this carrier (a shipped third-party plugin in the same profile documents
 * the same gap), so there the plugin's own authority fence stays the floor;
 * anything reachable by name gets the host's decision, login included.
 *
 * @param connection - the host `connection` service, when present.
 * @param request - incoming request.
 * @returns `{consulted:false}` when the gate is not applicable, otherwise the
 *   gate's status (`401`/`403`) or `undefined` when it admits the request.
 */
export function hostGateVerdict(connection, request) {
  if (connection === null || connection === undefined) return { consulted: false }
  if (connection.allowsRemoteAuthorities !== true) return { consulted: false }
  if (typeof connection.requestRejection !== 'function') return { consulted: false }
  try {
    const status = connection.requestRejection({ headers: request?.headers ?? {} })
    if (status === undefined) return { consulted: true, status: undefined }
    // The contract answers 401 | 403 | undefined; anything else is treated as a
    // refusal rather than as an admission.
    return { consulted: true, status: status === 401 ? 401 : 403 }
  } catch {
    // A gate that throws has admitted nothing; failing open would be the
    // exposure this exists to close.
    return { consulted: true, status: 403 }
  }
}

/**
 * Read a size-capped JSON object body.
 *
 * @param request - async-iterable incoming request.
 * @param maxBytes - hard cap; exceeding it answers 413.
 * @returns the parsed object, or a refusal carrying the status to answer.
 */
export async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += bytes.length
      if (size > maxBytes) {
        return { ok: false, status: 413, code: 'too-large', message: `request body exceeds ${maxBytes} bytes` }
      }
      chunks.push(bytes)
    }
  } catch {
    return { ok: false, status: 400, code: 'bad-request', message: 'could not read the request body' }
  }
  if (size === 0) {
    return { ok: false, status: 400, code: 'bad-request', message: 'the request body is empty' }
  }
  let value
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return { ok: false, status: 400, code: 'bad-request', message: 'the request body is not valid JSON' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, status: 400, code: 'bad-request', message: 'the request body must be a JSON object' }
  }
  return { ok: true, value }
}
