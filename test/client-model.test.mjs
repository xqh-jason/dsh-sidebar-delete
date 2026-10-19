/**
 * Browser-half model tests.
 *
 * `client.js` is a Module Loader package, so it is loaded the way the page
 * loads it: a `window.__ModuleLoader__.load` stub captures the package record
 * and its factory is called with a minimal React double. That keeps the test on
 * the shipped file instead of on a copy, while the only exercised surface here
 * is the pure projection (`__test.buildManagerModel`) — no DOM, no rendering.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * React double: enough for the factory to build its module object. The tested
 * projection never calls a hook, so these members only have to exist.
 */
const reactStub = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}

/** The captured loader record (id + factory). */
let packageRecord

globalThis.window = {
  __ModuleLoader__: {
    load: (record) => {
      packageRecord = record
    },
  },
}

await import('../client.js')

assert.notEqual(packageRecord, undefined, 'client.js must register through the Module Loader')
assert.equal(packageRecord.id, 'dsh-sidebar-delete')

const module = packageRecord.factory((specifier) => {
  if (specifier === 'react') return reactStub
  throw new Error(`unexpected require: ${specifier}`)
})

assert.notEqual(module.__test, undefined, 'the module must expose its model seat for node tests')
const { buildManagerModel, requestSessionDurability } = module.__test

/** @returns one Session row with the fields the projection reads. */
function row(id, overrides = {}) {
  return { id, cwd: '/tmp/probe', title: id, ...overrides }
}

/** @returns a Session snapshot shaped like the framework's. */
function sessionSnapshot(rows) {
  return { ids: rows.map((entry) => entry.id), byId: Object.fromEntries(rows.map((entry) => [entry.id, entry])) }
}

/** @returns every row id the model lists across Workspaces and Ungrouped. */
function listedIds(model) {
  const ids = []
  for (const entry of model.workspaces) for (const node of entry.nodes) ids.push(node.row.id)
  for (const group of model.groups) for (const node of group.nodes) ids.push(node.row.id)
  return ids.sort()
}

/** @returns a probe result from id lists. */
function probe(probed, durable) {
  return { probed: new Set(probed), durable: new Set(durable) }
}

const EMPTY_WORKSPACES = { items: [], archivedSessionIds: [] }

test('a probed row whose log is gone is hidden, together with its ghost child', () => {
  const sessions = sessionSnapshot([
    row('session-ghost-parent'),
    row('ghost-child', { parentId: 'session-ghost-parent' }),
    row('session-durable'),
  ])
  const known = probe(['session-ghost-parent', 'ghost-child', 'session-durable'], ['session-durable'])

  const model = buildManagerModel(EMPTY_WORKSPACES, sessions, known)

  assert.deepEqual(listedIds(model), ['session-durable'])
  assert.equal(model.hiddenGhosts, 2)
})

test('the Session the main view holds is listed even when its log is gone', () => {
  const sessions = sessionSnapshot([row('session-current', { retainedBy: { mainView: 1 } }), row('session-durable')])
  const known = probe(['session-current', 'session-durable'], ['session-durable'])

  const model = buildManagerModel(EMPTY_WORKSPACES, sessions, known)

  assert.deepEqual(listedIds(model), ['session-current', 'session-durable'])
  assert.equal(model.hiddenGhosts, 0)
})

test('a failed probe (known === null) lists every row', () => {
  const sessions = sessionSnapshot([row('session-a'), row('session-b')])

  const model = buildManagerModel(EMPTY_WORKSPACES, sessions, null)

  assert.deepEqual(listedIds(model), ['session-a', 'session-b'])
  assert.equal(model.hiddenGhosts, 0)
})

test('a row the probe did not cover is never treated as a ghost', () => {
  const sessions = sessionSnapshot([row('session-probed-ghost'), row('session-unprobed')])
  const known = probe(['session-probed-ghost'], [])

  const model = buildManagerModel(EMPTY_WORKSPACES, sessions, known)

  assert.deepEqual(listedIds(model), ['session-unprobed'])
  assert.equal(model.hiddenGhosts, 1)
})

test('an archived row stays hidden and is not counted as a ghost', () => {
  const sessions = sessionSnapshot([row('session-archived'), row('session-ghost')])
  const known = probe(['session-archived', 'session-ghost'], [])

  const model = buildManagerModel({ items: [], archivedSessionIds: ['session-archived'] }, sessions, known)

  assert.deepEqual(listedIds(model), [])
  assert.equal(model.hiddenGhosts, 1, 'only the non-archived row counts as a ghost')
})

test('a ghost Workspace member and its ghost child leave the Workspace block', () => {
  const sessions = sessionSnapshot([
    row('session-ws-durable'),
    row('session-ws-ghost'),
    row('ws-ghost-child', { parentId: 'session-ws-ghost' }),
  ])
  const workspaces = {
    items: [{ workspaceId: 'w1', title: 'W', path: '/w', sessionIds: ['session-ws-durable', 'session-ws-ghost'] }],
    archivedSessionIds: [],
  }
  const known = probe(['session-ws-durable', 'session-ws-ghost', 'ws-ghost-child'], ['session-ws-durable'])

  const model = buildManagerModel(workspaces, sessions, known)

  assert.equal(model.workspaces.length, 1)
  assert.deepEqual(model.workspaces[0].nodes.map((node) => node.row.id), ['session-ws-durable'])
  assert.deepEqual(model.groups, [], 'a hidden ghost must not resurface under Ungrouped')
  assert.equal(model.hiddenGhosts, 2)
})

test('the Workspace listing is unchanged when the probe is unknown', () => {
  const sessions = sessionSnapshot([row('session-ws-a'), row('session-ws-b')])
  const workspaces = { items: [{ workspaceId: 'w1', title: 'W', path: '/w', sessionIds: ['session-ws-a', 'session-ws-b'] }], archivedSessionIds: [] }

  const model = buildManagerModel(workspaces, sessions, null)

  assert.deepEqual(model.workspaces[0].nodes.map((node) => node.row.id), ['session-ws-a', 'session-ws-b'])
  assert.equal(model.hiddenGhosts, 0)
})

// ---------------------------------------------------------------------------
// The read-only durability probe: every failure must read as "unknown"
// ---------------------------------------------------------------------------

/** Ids used by the probe tests. */
const PROBE_IDS = ['session-a', 'bbbbbbbb-2222-4222-8222-222222222222']

/**
 * Run one probe against stubbed globals, then restore them.
 *
 * `document` and `fetch` are stubbed per test instead of at module load so a
 * failure here cannot leak into another assertion, and the originals are put
 * back even when the probe throws.
 *
 * @param fetchImpl - the stubbed `fetch`.
 * @param ids - the ids to probe.
 * @returns the probe result.
 */
async function probeWith(fetchImpl, ids = PROBE_IDS) {
  const previousFetch = globalThis.fetch
  const previousDocument = globalThis.document
  globalThis.fetch = fetchImpl
  globalThis.document = { baseURI: 'http://127.0.0.1:1/' }
  try {
    return await requestSessionDurability(ids)
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
}

/** @returns a response double whose `json()` yields the given payload. */
function responseWith(status, payload) {
  return {
    status,
    json: async () => payload,
  }
}

test('a fetch rejection makes the durability probe unknown', async () => {
  const result = await probeWith(async () => {
    throw new Error('offline')
  })

  assert.equal(result, null, 'a failed fetch must be unknown, never "all missing"')
})

test('a non-200 answer makes the durability probe unknown', async () => {
  for (const status of [404, 500]) {
    const result = await probeWith(async () => responseWith(status, { ok: true, durable: PROBE_IDS }))
    assert.equal(result, null, `HTTP ${status} must be unknown`)
  }
})

test('a malformed payload makes the durability probe unknown', async () => {
  const payloads = [
    null,
    { ok: false, durable: [] },
    { ok: true },
    { ok: true, durable: 'session-a' },
    { ok: true, durable: [42] },
  ]
  for (const payload of payloads) {
    const result = await probeWith(async () => responseWith(200, payload))
    assert.equal(result, null, `malformed payload ${JSON.stringify(payload)} must be unknown`)
  }

  const badJson = await probeWith(async () => ({
    status: 200,
    json: async () => {
      throw new SyntaxError('bad json')
    },
  }))
  assert.equal(badJson, null, 'unparseable JSON must be unknown')
})

test('a valid answer reports the probed ids and the durable subset', async () => {
  const calls = []
  const result = await probeWith(async (url, options) => {
    calls.push({ url, options })
    return responseWith(200, { ok: true, durable: [PROBE_IDS[0]], missing: [PROBE_IDS[1]] })
  })

  assert.deepEqual([...result.probed].sort(), [...PROBE_IDS].sort())
  assert.deepEqual([...result.durable], [PROBE_IDS[0]])
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/dsh-sidebar-delete\/sessions$/)
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.credentials, 'same-origin')
  assert.deepEqual(JSON.parse(calls[0].options.body), { sessionIds: PROBE_IDS })
})

test('the probe is unknown when there is no fetch at all', async () => {
  const previousFetch = globalThis.fetch
  const previousDocument = globalThis.document
  delete globalThis.fetch
  globalThis.document = { baseURI: 'http://127.0.0.1:1/' }
  try {
    assert.equal(await requestSessionDurability(PROBE_IDS), null)
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})
