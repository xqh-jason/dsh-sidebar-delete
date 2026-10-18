/**
 * Unit tests for the session-storage logic.
 *
 * Everything runs against a temporary fixture directory; no real harness state
 * is touched.
 */

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  collectSubtree,
  defaultSessionRoot,
  defaultStoragesRoot,
  findSessionDir,
  harnessHome,
  isSessionId,
  projectionCacheDir,
  removeSessionFiles,
  resolveSessionRoot,
} from '../src/session-store.mjs'

const ROOT_SESSION = 'session-11111111-1111-4111-8111-111111111111'
const CHILD = 'session-22222222-2222-4222-8222-222222222222'
const GRANDCHILD = 'session-33333333-3333-4333-8333-333333333333'
const UNRELATED = 'session-44444444-4444-4444-8444-444444444444'

const fixtures = []

after(async () => {
  for (const directory of fixtures) await rm(directory, { recursive: true, force: true })
})

/** @returns a persistence snapshot for one session. */
function snapshot(id, parentSession) {
  return { header: { id, ...(parentSession === undefined ? {} : { parentSession }) } }
}

/**
 * Build a session root plus projection cache holding the given ids.
 *
 * @returns the fixture's roots and the temp directory.
 */
async function fixture(ids) {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-sidebar-delete-'))
  fixtures.push(base)
  const sessionRoot = path.join(base, 'sessions')
  const storagesRoot = path.join(base, 'storages')
  const projcacheDir = projectionCacheDir(storagesRoot)
  await mkdir(projcacheDir, { recursive: true })
  for (const id of ids) {
    const directory = path.join(sessionRoot, '--proj--', id)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'session.v4.jsonl.zstd'), 'log')
    await writeFile(path.join(directory, 'session.lock'), '')
    await writeFile(path.join(projcacheDir, `${id}.json`), '{"version":1}')
  }
  return { base, sessionRoot, storagesRoot, projcacheDir }
}

test('isSessionId accepts both live id shapes and refuses path-shaped values', () => {
  // Both shapes exist in one installation: the Web client mints `session-<uuid>`
  // and teammates / subagents / some client-created sessions get a bare uuid.
  assert.equal(isSessionId(ROOT_SESSION), true)
  assert.equal(isSessionId('11111111-1111-4111-8111-111111111111'), true)
  assert.equal(isSessionId('session-7'), true)
  for (const bad of ['../etc/passwd', 'a/b', 'a\\b', '..', '.hidden', '', 'x'.repeat(200), undefined, null, 42]) {
    assert.equal(isSessionId(bad), false, `must refuse ${JSON.stringify(bad)}`)
  }
})

test('roots resolve from DSH_HOME with a ~/.dsh fallback', () => {
  const env = { DSH_HOME: '/tmp/dsh-home' }
  assert.equal(harnessHome(env), '/tmp/dsh-home')
  assert.equal(defaultSessionRoot(env), path.join('/tmp/dsh-home', 'sessions'))
  assert.equal(defaultStoragesRoot(env), path.join('/tmp/dsh-home', 'storages'))
  assert.equal(projectionCacheDir(defaultStoragesRoot(env)), path.join('/tmp/dsh-home', 'storages', 'session_projcache', 'sessions'))
  assert.ok(harnessHome({}).endsWith('/.dsh'))
  assert.equal(resolveSessionRoot({ configRoot: '/custom/logs', env }), '/custom/logs')
  assert.equal(resolveSessionRoot({ env }), path.join('/tmp/dsh-home', 'sessions'))
})

test('collectSubtree walks parent links and ignores unrelated sessions', () => {
  const snapshots = [
    snapshot(UNRELATED),
    snapshot(GRANDCHILD, CHILD),
    snapshot(ROOT_SESSION),
    snapshot(CHILD, ROOT_SESSION),
    { header: {} },
    null,
  ]
  assert.deepEqual(collectSubtree(snapshots, ROOT_SESSION), [ROOT_SESSION, CHILD, GRANDCHILD])
  assert.deepEqual(collectSubtree(snapshots, UNRELATED), [UNRELATED])
  assert.deepEqual(collectSubtree(snapshots, 'session-99999999-9999-4999-8999-999999999999'), [])
  assert.deepEqual(collectSubtree(undefined, ROOT_SESSION), [])
})

test('collectSubtree survives a parent cycle', () => {
  const snapshots = [snapshot(ROOT_SESSION, CHILD), snapshot(CHILD, ROOT_SESSION)]
  assert.deepEqual(collectSubtree(snapshots, ROOT_SESSION), [ROOT_SESSION, CHILD])
})

test('findSessionDir locates a session under its project directory', async () => {
  const { sessionRoot } = await fixture([ROOT_SESSION])
  assert.equal(await findSessionDir(sessionRoot, ROOT_SESSION), path.join(sessionRoot, '--proj--', ROOT_SESSION))
  assert.equal(await findSessionDir(sessionRoot, UNRELATED), undefined)
  assert.equal(await findSessionDir(path.join(sessionRoot, 'nope'), ROOT_SESSION), undefined)
  assert.equal(await findSessionDir(sessionRoot, UNRELATED, async () => [{ isDirectory: () => true, name: '--proj--' }]), undefined)
})

test('removeSessionFiles deletes the log directory and the cache record', async () => {
  const { sessionRoot, projcacheDir } = await fixture([ROOT_SESSION, UNRELATED])
  const result = await removeSessionFiles({ sessionRoot, projcacheDir, ids: [ROOT_SESSION] })
  assert.deepEqual(result, { removed: [ROOT_SESSION], missing: [], failures: [] })
  assert.equal(existsSync(path.join(sessionRoot, '--proj--', ROOT_SESSION)), false)
  assert.equal(existsSync(path.join(projcacheDir, `${ROOT_SESSION}.json`)), false)
  assert.equal(existsSync(path.join(sessionRoot, '--proj--', UNRELATED)), true)
})

test('removeSessionFiles is idempotent for an already-deleted session', async () => {
  const { sessionRoot, projcacheDir } = await fixture([ROOT_SESSION])
  await removeSessionFiles({ sessionRoot, projcacheDir, ids: [ROOT_SESSION] })
  const second = await removeSessionFiles({ sessionRoot, projcacheDir, ids: [ROOT_SESSION] })
  assert.deepEqual(second, { removed: [], missing: [ROOT_SESSION], failures: [] })
})

test('removeSessionFiles reports a per-target failure without blocking the rest', async () => {
  const { sessionRoot, projcacheDir } = await fixture([ROOT_SESSION, UNRELATED])
  const blocked = path.join(sessionRoot, '--proj--', ROOT_SESSION)
  const rmImpl = async (target, options) => {
    if (target === blocked) {
      const error = new Error('operation not permitted')
      error.code = 'EPERM'
      throw error
    }
    const { rm } = await import('node:fs/promises')
    return rm(target, options)
  }
  const result = await removeSessionFiles({ sessionRoot, projcacheDir, ids: [ROOT_SESSION, UNRELATED], rmImpl })
  assert.deepEqual(result.removed, [UNRELATED])
  assert.deepEqual(result.missing, [])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].id, ROOT_SESSION)
  assert.equal(result.failures[0].code, 'EPERM')
  assert.equal(existsSync(blocked), true)
  assert.equal(existsSync(path.join(sessionRoot, '--proj--', UNRELATED)), false)
})

test('removeSessionFiles tolerates a session with no cache record', async () => {
  const { sessionRoot, projcacheDir } = await fixture([])
  await mkdir(path.join(sessionRoot, '--proj--', UNRELATED), { recursive: true })
  const result = await removeSessionFiles({ sessionRoot, projcacheDir, ids: [UNRELATED] })
  assert.deepEqual(result, { removed: [UNRELATED], missing: [], failures: [] })
})

test('removeSessionFiles reports a broken directory scan instead of throwing', async () => {
  const { sessionRoot, projcacheDir } = await fixture([ROOT_SESSION])
  const result = await removeSessionFiles({
    sessionRoot,
    projcacheDir,
    ids: [ROOT_SESSION],
    readdirImpl: async () => {
      const error = new Error('io')
      error.code = 'EIO'
      throw error
    },
  })
  assert.equal(result.removed.length, 0)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].code, 'EIO')
})
