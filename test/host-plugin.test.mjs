/**
 * Host-half tests.
 *
 * `index.js` is imported for real (it depends only on `src/`, never on cordis),
 * mounted on a fake host context, and driven through its registered handler
 * against a temporary `$DSH_HOME`. That is the coverage the independent review
 * found missing: the route wiring, the live-session refusal, the cascade, the
 * `api-session/removed` mirroring, and the real file removal.
 */

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply, MAX_BODY_BYTES, ROUTE_PATH } from '../index.js'

const PERSISTENCE_PACKAGE = '@deepseek-ai/dsh-session-persistence-jsonl'
const PARENT = 'session-aaaaaaaa-1111-4111-8111-111111111111'
const BARE_CHILD = 'bbbbbbbb-2222-4222-8222-222222222222'
const UNRELATED = 'session-cccccccc-3333-4333-8333-333333333333'

const created = []
const previousHome = process.env.DSH_HOME

after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const base of created) await rm(base, { recursive: true, force: true })
})

/**
 * Build a temporary harness home holding the given session ids.
 *
 * @param ids - session ids to materialize (log directory + cache record).
 * @returns the fixture roots.
 */
async function makeHome(ids) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-sidebar-delete-host-'))
  created.push(base)
  const projectDir = path.join(base, 'sessions', '--proj--')
  const projcache = path.join(base, 'storages', 'session_projcache', 'sessions')
  await mkdir(projcache, { recursive: true })
  for (const id of ids) {
    await mkdir(path.join(projectDir, id), { recursive: true })
    await writeFile(path.join(projectDir, id, 'session.v4.jsonl.zstd'), 'log')
    await writeFile(path.join(projectDir, id, 'session.lock'), '')
    await writeFile(path.join(projcache, `${id}.json`), '{}')
  }
  return { base, projectDir, projcache }
}

/**
 * Mount the plugin on a fake host context.
 *
 * @returns the registered handler, the routes, the emitted events, and the ctx.
 */
function mount(options = {}) {
  const { live = [], snapshots = [], connection, configRoot, workspaceRegistry } = options
  const routes = []
  const emitted = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(callback) {
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => (live.includes(id) ? { id } : undefined) }
      if (name === 'agents') return { get: () => undefined }
      if (name === 'sessionPersistence') {
        return {
          list: async () => {
            if (options.persistenceThrows === true) throw new Error('persistence unavailable')
            return snapshots
          },
        }
      }
      if (name === 'connection') return connection
      if (name === 'workspaceRegistry') return workspaceRegistry
      if (name === 'configEditor') {
        if (configRoot === undefined) return undefined
        return {
          configuration: () => [{ entry: { name: PERSISTENCE_PACKAGE }, inherited: { root: configRoot }, override: {} }],
        }
      }
      return undefined
    },
    emit(event, ...args) {
      emitted.push([event, ...args])
    },
  }
  apply(ctx)
  return { ctx, routes, emitted, handler: routes[0]?.handler }
}

/** @returns a request-shaped object with an async-iterable body. */
function request(options = {}) {
  const headers = { host: '127.0.0.1:58090', 'content-type': 'application/json', ...(options.headers ?? {}) }
  return {
    method: options.method ?? 'POST',
    headers,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(options.body ?? '{}')
    },
  }
}

/** @returns a response recorder. */
function response() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

/** @returns the parsed response body. */
function json(res) {
  return JSON.parse(res.body)
}

test('apply registers one exact route at the documented path', () => {
  const { routes } = mount()
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, ROUTE_PATH)
  assert.equal(ROUTE_PATH, '/dsh-sidebar-delete/session')
  assert.equal(MAX_BODY_BYTES, 64 * 1024)
})

test('a known session is deleted with its files and mirrored to clients', async () => {
  const home = await makeHome([UNRELATED])
  process.env.DSH_HOME = home.base
  const { handler, emitted } = mount({ snapshots: [{ header: { id: UNRELATED } }] })

  const res = response()
  await handler(request({ body: JSON.stringify({ sessionId: UNRELATED }) }), res)

  assert.equal(res.status, 200)
  const body = json(res)
  assert.equal(body.ok, true)
  assert.deepEqual(body.deleted, [UNRELATED])
  assert.equal(existsSync(path.join(home.projectDir, UNRELATED)), false)
  assert.equal(existsSync(path.join(home.projcache, `${UNRELATED}.json`)), false)
  assert.deepEqual(emitted, [['api-session/removed', UNRELATED]])
})

test('a live session is refused with zero file changes and zero events', async () => {
  const home = await makeHome([UNRELATED])
  process.env.DSH_HOME = home.base
  const { handler, emitted } = mount({ live: [UNRELATED], snapshots: [{ header: { id: UNRELATED } }] })

  const res = response()
  await handler(request({ body: JSON.stringify({ sessionId: UNRELATED }) }), res)

  assert.equal(res.status, 409)
  const body = json(res)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'session-active')
  assert.deepEqual(body.live, [UNRELATED])
  assert.deepEqual(body.deleted, [])
  assert.equal(existsSync(path.join(home.projectDir, UNRELATED)), true)
  assert.equal(existsSync(path.join(home.projcache, `${UNRELATED}.json`)), true)
  assert.deepEqual(emitted, [])
})

test('a live child refuses the whole branch', async () => {
  const home = await makeHome([PARENT, BARE_CHILD])
  process.env.DSH_HOME = home.base
  const snapshots = [{ header: { id: PARENT } }, { header: { id: BARE_CHILD, parentSession: PARENT } }]
  const { handler, emitted } = mount({ live: [BARE_CHILD], snapshots })

  const res = response()
  await handler(request({ body: JSON.stringify({ sessionId: PARENT }) }), res)

  assert.equal(res.status, 409)
  assert.equal(json(res).code, 'session-active')
  assert.equal(existsSync(path.join(home.projectDir, PARENT)), true)
  assert.equal(existsSync(path.join(home.projectDir, BARE_CHILD)), true)
  assert.deepEqual(emitted, [])
})

test('a parent deletes its descendants, including a bare-uuid child', async () => {
  const home = await makeHome([PARENT, BARE_CHILD])
  process.env.DSH_HOME = home.base
  const snapshots = [{ header: { id: PARENT } }, { header: { id: BARE_CHILD, parentSession: PARENT } }]
  const { handler, emitted } = mount({ snapshots })

  const res = response()
  await handler(request({ body: JSON.stringify({ sessionId: PARENT }) }), res)

  assert.equal(res.status, 200)
  assert.deepEqual(json(res).deleted, [PARENT, BARE_CHILD])
  assert.equal(existsSync(path.join(home.projectDir, PARENT)), false)
  assert.equal(existsSync(path.join(home.projectDir, BARE_CHILD)), false)
  assert.deepEqual(emitted, [
    ['api-session/removed', PARENT],
    ['api-session/removed', BARE_CHILD],
  ])
})

test('a bare-uuid session is deletable on its own', async () => {
  const home = await makeHome([BARE_CHILD])
  process.env.DSH_HOME = home.base
  const { handler } = mount({ snapshots: [{ header: { id: BARE_CHILD } }] })

  const res = response()
  await handler(request({ body: JSON.stringify({ sessionId: BARE_CHILD }) }), res)

  assert.equal(res.status, 200)
  assert.deepEqual(json(res).deleted, [BARE_CHILD])
  assert.equal(existsSync(path.join(home.projectDir, BARE_CHILD)), false)
})

test('the configured persistence root wins over $DSH_HOME', async () => {
  const decoy = await makeHome([])
  const home = await makeHome([UNRELATED])
  process.env.DSH_HOME = decoy.base
  const { handler } = mount({ snapshots: [], configRoot: path.join(home.base, 'sessions') })

  const res = response()
  await handler(request({ body: JSON.stringify({ sessionId: UNRELATED }) }), res)

  assert.equal(res.status, 200)
  assert.equal(existsSync(path.join(home.projectDir, UNRELATED)), false)
})

test('an unknown id is reported as deleted and is idempotent', async () => {
  const home = await makeHome([])
  process.env.DSH_HOME = home.base
  const { handler, emitted } = mount({ snapshots: [] })

  const first = response()
  await handler(request({ body: JSON.stringify({ sessionId: UNRELATED }) }), first)
  const second = response()
  await handler(request({ body: JSON.stringify({ sessionId: UNRELATED }) }), second)

  assert.equal(first.status, 200)
  assert.deepEqual(json(first).deleted, [UNRELATED])
  assert.equal(second.status, 200)
  assert.deepEqual(json(second).deleted, [UNRELATED])
  assert.equal(emitted.length, 2)
})

test('a path-shaped or empty id is refused before any file work', async () => {
  const home = await makeHome([UNRELATED])
  process.env.DSH_HOME = home.base
  const { handler, emitted } = mount()

  for (const sessionId of ['../etc/passwd', 'a/b', '', 42]) {
    const res = response()
    await handler(request({ body: JSON.stringify({ sessionId }) }), res)
    assert.equal(res.status, 400, `must refuse ${JSON.stringify(sessionId)}`)
    assert.equal(json(res).code, 'bad-request')
  }
  assert.equal(existsSync(path.join(home.projectDir, UNRELATED)), true)
  assert.deepEqual(emitted, [])
})

test('method, media type, and body size are enforced before admission', async () => {
  const home = await makeHome([])
  process.env.DSH_HOME = home.base
  const { handler } = mount()

  const get = response()
  await handler(request({ method: 'GET' }), get)
  assert.equal(get.status, 405)

  const noType = response()
  await handler(
    request({ body: '{}', headers: { 'content-type': 'text/plain' } }),
    noType,
  )
  assert.equal(noType.status, 415)

  const huge = response()
  await handler(request({ body: JSON.stringify({ sessionId: UNRELATED, pad: 'x'.repeat(70 * 1024) }) }), huge)
  assert.equal(huge.status, 413)
})

test('without a connection gate the loopback and origin fence decides', async () => {
  const home = await makeHome([])
  process.env.DSH_HOME = home.base
  const { handler } = mount()

  const foreign = response()
  await handler(
    request({ body: JSON.stringify({ sessionId: UNRELATED }), headers: { host: 'evil.com:58090' } }),
    foreign,
  )
  assert.equal(foreign.status, 403)
  assert.equal(json(foreign).code, 'untrusted-origin')

  const crossSite = response()
  await handler(
    request({ body: JSON.stringify({ sessionId: UNRELATED }), headers: { origin: 'http://evil.com' } }),
    crossSite,
  )
  assert.equal(crossSite.status, 403)
})

test('the host connection gate decides whenever it is applicable', async () => {
  const home = await makeHome([UNRELATED])
  process.env.DSH_HOME = home.base

  const refusing = mount({
    connection: {
      allowsRemoteAuthorities: true,
      requestRejection: () => 401,
    },
  })
  const refused = response()
  await refusing.handler(request({ body: JSON.stringify({ sessionId: UNRELATED }) }), refused)
  assert.equal(refused.status, 401)
  assert.equal(json(refused).code, 'unauthorized')

  const admitting = mount({
    connection: {
      allowsRemoteAuthorities: true,
      requestRejection: () => undefined,
    },
    snapshots: [{ header: { id: UNRELATED } }],
  })
  const admitted = response()
  await admitting.handler(
    // A non-loopback Host is fine: the host gate already admitted it.
    request({ body: JSON.stringify({ sessionId: UNRELATED }), headers: { host: 'dsh.example.org' } }),
    admitted,
  )
  assert.equal(admitted.status, 200)
  assert.equal(existsSync(path.join(home.projectDir, UNRELATED)), false)
})

test('a throwing connection gate fails closed', async () => {
  const home = await makeHome([])
  process.env.DSH_HOME = home.base
  const { handler } = mount({
    connection: {
      allowsRemoteAuthorities: true,
      requestRejection: () => {
        throw new Error('gate broken')
      },
    },
  })
  const res = response()
  await handler(request({ body: JSON.stringify({ sessionId: UNRELATED }) }), res)
  assert.equal(res.status, 403)
})

test('a persistence failure answers an internal error instead of throwing', async () => {
  const home = await makeHome([])
  process.env.DSH_HOME = home.base
  const { handler } = mount({ persistenceThrows: true })

  const res = response()
  await handler(request({ body: JSON.stringify({ sessionId: UNRELATED }) }), res)
  assert.equal(res.status, 409)
  assert.equal(json(res).code, 'internal')
  assert.equal(json(res).deleted.length, 0)
})

/** @returns a workspace service double recording the cleanup calls it receives. */
function registryDouble(listedIds) {
  const calls = { unarchived: [], unpinned: [], detached: [] }
  const workspace = {
    path: '/somewhere',
    sessionIds: [...listedIds],
    async detachSession(id) {
      calls.detached.push(id)
    },
  }
  return {
    calls,
    registry: {
      list: () => [workspace],
      async unarchiveSession(id) {
        calls.unarchived.push(id)
      },
      async unpinSession(id) {
        calls.unpinned.push(id)
      },
    },
  }
}

test('a deleted session is retired from the workspace service as well as the disk', async () => {
  const home = await makeHome([UNRELATED])
  process.env.DSH_HOME = home.base
  const { calls, registry } = registryDouble([UNRELATED, PARENT])
  const { handler } = mount({ snapshots: [{ header: { id: UNRELATED } }], workspaceRegistry: registry })

  const res = response()
  await handler(request({ body: JSON.stringify({ sessionId: UNRELATED }) }), res)

  assert.equal(res.status, 200)
  assert.deepEqual(json(res).deleted, [UNRELATED])
  assert.deepEqual(calls.unarchived, [UNRELATED], 'the archived id is retired')
  assert.deepEqual(calls.unpinned, [UNRELATED], 'the pinned id is retired')
  assert.deepEqual(calls.detached, [UNRELATED], 'only the deleted id leaves a workspace account')
  assert.equal(json(res).registrations, 2, 'one unarchive plus one detach')
})

test('a live refusal retires no registration', async () => {
  const home = await makeHome([UNRELATED])
  process.env.DSH_HOME = home.base
  const { calls, registry } = registryDouble([UNRELATED])
  const { handler } = mount({ live: [UNRELATED], snapshots: [{ header: { id: UNRELATED } }], workspaceRegistry: registry })

  const res = response()
  await handler(request({ body: JSON.stringify({ sessionId: UNRELATED }) }), res)

  assert.equal(res.status, 409)
  assert.deepEqual(calls.unarchived, [])
  assert.deepEqual(calls.detached, [])
})

test('a broken workspace service never turns a successful delete into a failure', async () => {
  const home = await makeHome([UNRELATED])
  process.env.DSH_HOME = home.base
  const broken = {
    list: () => {
      throw new Error('registry unavailable')
    },
    unarchiveSession: async () => {
      throw new Error('write failed')
    },
  }
  const { handler } = mount({ snapshots: [{ header: { id: UNRELATED } }], workspaceRegistry: broken })

  const res = response()
  await handler(request({ body: JSON.stringify({ sessionId: UNRELATED }) }), res)

  assert.equal(res.status, 200)
  assert.equal(json(res).ok, true)
  assert.equal(existsSync(path.join(home.projectDir, UNRELATED)), false)
})
