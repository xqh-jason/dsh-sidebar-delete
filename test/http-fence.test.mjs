/**
 * Unit tests for the route's admission and body rules.
 *
 * These run without cordis and without a real HTTP server: the rules are pure
 * functions over a request-shaped object.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authorityVerdict,
  fenceVerdict,
  headerOf,
  hostGateVerdict,
  isLoopbackAuthority,
  isTrustedAuthority,
  methodVerdict,
  parseAuthority,
  readJsonBody,
} from '../src/http-fence.mjs'

const LOOPBACK_HOST = '127.0.0.1:58090'

/** @returns a request-shaped object with the given method and headers. */
function request(method, headers) {
  return { method, headers }
}

/** @returns an async-iterable body source. */
function bodySource(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

test('accepts a loopback POST with a matching origin', () => {
  const verdict = fenceVerdict(
    request('POST', {
      host: LOOPBACK_HOST,
      origin: `http://${LOOPBACK_HOST}`,
      'content-type': 'application/json',
    }),
  )
  assert.deepEqual(verdict, { ok: true })
})

test('accepts a POST with no origin at all (the Desktop proxy strips it)', () => {
  const verdict = fenceVerdict(request('POST', { host: 'localhost:58090', 'content-type': 'application/json' }))
  assert.deepEqual(verdict, { ok: true })
})

test('loopback detection accepts only real loopback names', () => {
  assert.equal(isLoopbackAuthority('[::1]:58090'), true)
  assert.equal(isLoopbackAuthority('127.0.0.1'), true)
  assert.equal(isLoopbackAuthority('localhost'), true)
  assert.equal(isLoopbackAuthority('[::2]:58090'), false)
  assert.equal(isLoopbackAuthority('localhost.evil.com'), false)
  assert.equal(isLoopbackAuthority(undefined), false)
})

test('refuses a non-POST method', () => {
  const verdict = fenceVerdict(request('GET', { host: LOOPBACK_HOST, 'content-type': 'application/json' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 405)
  assert.equal(verdict.code, 'method-not-allowed')
})

test('refuses a Host that is neither loopback nor declared', () => {
  const verdict = fenceVerdict(
    request('POST', {
      host: 'evil.com:58090',
      origin: 'http://evil.com:58090',
      'content-type': 'application/json',
    }),
  )
  assert.equal(verdict.ok, false)
  assert.equal(verdict.status, 403)
  assert.equal(verdict.code, 'untrusted-origin')
})

test('accepts a declared authority and respects its port shape', () => {
  const options = { trustedHosts: ['dsh.example.org', '10.0.0.4:8080'] }
  assert.deepEqual(
    fenceVerdict(request('POST', { host: 'dsh.example.org:9999', 'content-type': 'application/json' }), options),
    { ok: true },
  )
  assert.deepEqual(
    fenceVerdict(request('POST', { host: '10.0.0.4:8080', 'content-type': 'application/json' }), options),
    { ok: true },
  )
  const mismatchedPort = fenceVerdict(
    request('POST', { host: '10.0.0.4:9090', 'content-type': 'application/json' }),
    options,
  )
  assert.equal(mismatchedPort.ok, false)
  assert.equal(mismatchedPort.status, 403)
})

test('authority parsing refuses anything that is not a bare authority', () => {
  assert.equal(parseAuthority('dsh.example.org/path'), null)
  assert.equal(parseAuthority('http://dsh.example.org'), null)
  assert.equal(parseAuthority(''), null)
  assert.equal(parseAuthority(undefined), null)
  assert.notEqual(parseAuthority('dsh.example.org'), null)
  assert.notEqual(parseAuthority('10.0.0.4:8080'), null)
})

test('refuses a cross-site, null, or empty origin', () => {
  for (const origin of ['http://evil.com', 'null', '']) {
    const verdict = fenceVerdict(request('POST', { host: LOOPBACK_HOST, origin, 'content-type': 'application/json' }))
    assert.equal(verdict.ok, false, `origin ${JSON.stringify(origin)} must be refused`)
    assert.equal(verdict.status, 403)
  }
  const otherPort = fenceVerdict(
    request('POST', { host: LOOPBACK_HOST, origin: 'http://127.0.0.1:1234', 'content-type': 'application/json' }),
  )
  assert.equal(otherPort.ok, false)
})

test('refuses a body that is not declared as JSON', () => {
  assert.equal(fenceVerdict(request('POST', { host: LOOPBACK_HOST })).status, 415)
  assert.equal(fenceVerdict(request('POST', { host: LOOPBACK_HOST, 'content-type': 'text/plain' })).status, 415)
})

test('headerOf reads plain and Headers-like containers', () => {
  assert.equal(headerOf({ headers: { host: 'a' } }, 'host'), 'a')
  assert.equal(headerOf({ headers: new Map([['host', 'b']]) }, 'host'), 'b')
  assert.equal(headerOf({ headers: { get: (name) => (name === 'host' ? 'c' : undefined) } }, 'host'), 'c')
  assert.equal(headerOf({ headers: { host: ['d', 'e'] } }, 'host'), 'd')
  assert.equal(headerOf({}, 'host'), undefined)
})

test('readJsonBody parses an object body', async () => {
  const result = await readJsonBody(bodySource(['{"sessionId":', '"session-1"}']))
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { sessionId: 'session-1' })
})

test('readJsonBody refuses empty, malformed, and non-object bodies', async () => {
  assert.equal((await readJsonBody(bodySource([]))).status, 400)
  assert.equal((await readJsonBody(bodySource(['not json']))).status, 400)
  assert.equal((await readJsonBody(bodySource(['[1,2]']))).status, 400)
  assert.equal((await readJsonBody(bodySource(['null']))).status, 400)
})

test('readJsonBody enforces the byte cap', async () => {
  const oversize = await readJsonBody(bodySource(['{"x":"', 'a'.repeat(200), '"}']), 64)
  assert.equal(oversize.ok, false)
  assert.equal(oversize.status, 413)
  assert.equal(oversize.code, 'too-large')
})

test('readJsonBody reports a body source that throws', async () => {
  const broken = {
    async *[Symbol.asyncIterator]() {
      throw new Error('socket')
    },
  }
  const result = await readJsonBody(broken)
  assert.equal(result.ok, false)
  assert.equal(result.status, 400)
})

test('isTrustedAuthority tolerates a missing list', () => {
  assert.equal(isTrustedAuthority('127.0.0.1:1', undefined), false)
})

test('methodVerdict splits the caller-independent checks from the authority checks', () => {
  assert.deepEqual(methodVerdict(request('POST', { 'content-type': 'application/json' })), { ok: true })
  assert.equal(methodVerdict(request('GET', { 'content-type': 'application/json' })).status, 405)
  assert.equal(methodVerdict(request('POST', {})).status, 415)
})

test('authorityVerdict only judges host and origin', () => {
  assert.deepEqual(authorityVerdict(request('POST', { host: LOOPBACK_HOST })), { ok: true })
  assert.equal(authorityVerdict(request('POST', { host: 'evil.com' })).status, 403)
  assert.equal(
    authorityVerdict(request('POST', { host: LOOPBACK_HOST, origin: 'http://evil.com' })).status,
    403,
  )
  // A declared authority is accepted when the deployment exposes the list.
  assert.deepEqual(
    authorityVerdict(request('POST', { host: 'dsh.example.org' }), { trustedHosts: ['dsh.example.org'] }),
    { ok: true },
  )
})

test('hostGateVerdict stays out of the way when the gate is not applicable', () => {
  assert.deepEqual(hostGateVerdict(undefined, request('POST', {})), { consulted: false })
  assert.deepEqual(hostGateVerdict({ allowsRemoteAuthorities: false }, request('POST', {})), { consulted: false })
  assert.deepEqual(
    hostGateVerdict({ allowsRemoteAuthorities: true }, request('POST', {})),
    { consulted: false },
    'a gate without requestRejection cannot decide',
  )
})

test('hostGateVerdict carries the gate decision through', () => {
  const admitted = { allowsRemoteAuthorities: true, requestRejection: () => undefined }
  assert.deepEqual(hostGateVerdict(admitted, request('POST', {})), { consulted: true, status: undefined })
  for (const status of [401, 403]) {
    const refusing = { allowsRemoteAuthorities: true, requestRejection: () => status }
    assert.deepEqual(hostGateVerdict(refusing, request('POST', {})), { consulted: true, status })
  }
})

test('hostGateVerdict fails closed when the gate throws or answers nonsense', () => {
  const throwing = {
    allowsRemoteAuthorities: true,
    requestRejection: () => {
      throw new Error('broken')
    },
  }
  assert.deepEqual(hostGateVerdict(throwing, request('POST', {})), { consulted: true, status: 403 })
  const odd = { allowsRemoteAuthorities: true, requestRejection: () => 500 }
  assert.deepEqual(hostGateVerdict(odd, request('POST', {})), { consulted: true, status: 403 })
})
