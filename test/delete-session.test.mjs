/**
 * Unit tests for the delete decision: what a request covers, and whether the
 * live-session refusal holds.
 *
 * These are the tests a regression of the safety property must fail.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { deleteSessionBranch, planDelete } from '../src/delete-session.mjs'

const PARENT = 'session-11111111-1111-4111-8111-111111111111'
const CHILD = 'session-22222222-2222-4222-8222-222222222222'
const GRANDCHILD = 'af9d4b7e-0000-4000-8000-000000000000'
const UNRELATED = 'session-44444444-4444-4444-8444-444444444444'

function snapshot(id, parentSession) {
  return { header: { id, ...(parentSession === undefined ? {} : { parentSession }) } }
}

const SNAPSHOTS = [snapshot(PARENT), snapshot(CHILD, PARENT), snapshot(GRANDCHILD, CHILD), snapshot(UNRELATED)]

/** @returns a remove() spy whose result the test controls. */
function removeSpy(result = { removed: [], missing: [], failures: [] }) {
  const calls = []
  const remove = async (options) => {
    calls.push(options)
    return typeof result === 'function' ? result(options) : result
  }
  remove.calls = calls
  return remove
}

test('planDelete covers the requested session and every descendant', () => {
  const plan = planDelete(SNAPSHOTS, PARENT, () => false)
  assert.deepEqual(plan.targets, [PARENT, CHILD, GRANDCHILD])
  assert.deepEqual(plan.live, [])
  assert.equal(plan.allowed, true)
  assert.deepEqual(planDelete(SNAPSHOTS, UNRELATED, () => false).targets, [UNRELATED])
})

test('planDelete still attempts an unknown id, so a failed listing cannot strand a session', () => {
  const unknown = 'session-99999999-9999-4999-8999-999999999999'
  assert.deepEqual(planDelete(SNAPSHOTS, unknown, () => false).targets, [unknown])
  assert.deepEqual(planDelete([], unknown, () => false).targets, [unknown])
})

test('planDelete refuses when any node of the branch is live', () => {
  const childLive = planDelete(SNAPSHOTS, PARENT, (id) => id === CHILD)
  assert.equal(childLive.allowed, false)
  assert.deepEqual(childLive.live, [CHILD])
  const rootLive = planDelete(SNAPSHOTS, PARENT, (id) => id === PARENT)
  assert.equal(rootLive.allowed, false)
})

test('planDelete treats a throwing liveness predicate as "live"', () => {
  const plan = planDelete(SNAPSHOTS, PARENT, () => {
    throw new Error('store unavailable')
  })
  assert.equal(plan.allowed, false)
  assert.deepEqual(plan.live, [PARENT, CHILD, GRANDCHILD])
})

test('deleteSessionBranch refuses a live branch without touching any file', async () => {
  const remove = removeSpy()
  const result = await deleteSessionBranch({
    snapshots: SNAPSHOTS,
    rootId: PARENT,
    isLive: (id) => id === GRANDCHILD,
    sessionRoot: '/nonexistent',
    projcacheDir: '/nonexistent',
    remove,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'session-active')
  assert.deepEqual(result.live, [GRANDCHILD])
  assert.deepEqual(result.deleted, [])
  assert.equal(remove.calls.length, 0, 'a refused delete must not reach the filesystem')
})

test('deleteSessionBranch removes the whole branch and reports every id', async () => {
  const remove = removeSpy({ removed: [PARENT, CHILD], missing: [GRANDCHILD], failures: [] })
  const result = await deleteSessionBranch({
    snapshots: SNAPSHOTS,
    rootId: PARENT,
    isLive: () => false,
    sessionRoot: '/s',
    projcacheDir: '/p',
    remove,
  })
  assert.deepEqual(result, { ok: true, deleted: [PARENT, CHILD, GRANDCHILD], failures: [] })
  assert.equal(remove.calls.length, 1)
  assert.deepEqual(remove.calls[0], { sessionRoot: '/s', projcacheDir: '/p', ids: [PARENT, CHILD, GRANDCHILD] })
})

test('deleteSessionBranch keeps the deleted ids visible when part of the branch failed', async () => {
  const failures = [{ id: CHILD, path: '/s/--p--/' + CHILD, code: 'EPERM', message: 'denied' }]
  const remove = removeSpy({ removed: [PARENT], missing: [], failures })
  const result = await deleteSessionBranch({
    snapshots: SNAPSHOTS,
    rootId: PARENT,
    isLive: () => false,
    sessionRoot: '/s',
    projcacheDir: '/p',
    remove,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'partial')
  assert.deepEqual(result.deleted, [PARENT])
  assert.deepEqual(result.failures, failures)
})

test('deleteSessionBranch requires a remove implementation', async () => {
  await assert.rejects(
    deleteSessionBranch({ snapshots: [], rootId: PARENT, isLive: () => false, sessionRoot: '/s', projcacheDir: '/p' }),
    TypeError,
  )
})
