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

const idle = () => ({ live: false, running: false })

test('planDelete covers the requested session and every descendant', () => {
  const plan = planDelete(SNAPSHOTS, PARENT, idle)
  assert.deepEqual(plan.targets, [PARENT, CHILD, GRANDCHILD])
  assert.deepEqual(plan.blocked, [])
  assert.deepEqual(plan.running, [])
  assert.equal(plan.allowed, true)
  assert.deepEqual(planDelete(SNAPSHOTS, UNRELATED, idle).targets, [UNRELATED])
})

test('planDelete still attempts an unknown id, so a failed listing cannot strand a session', () => {
  const unknown = 'session-99999999-9999-4999-8999-999999999999'
  assert.deepEqual(planDelete(SNAPSHOTS, unknown, idle).targets, [unknown])
  assert.deepEqual(planDelete([], unknown, idle).targets, [unknown])
})

test('planDelete refuses only a branch with an OPEN TURN', () => {
  const childRunning = planDelete(SNAPSHOTS, PARENT, (id) => (id === CHILD ? { live: true, running: true } : idle()))
  assert.equal(childRunning.allowed, false)
  assert.deepEqual(childRunning.blocked, [CHILD])
  assert.deepEqual(childRunning.running, [CHILD])
})

test('planDelete allows a session that is live but idle, and one held with unknown activity blocks', () => {
  // Exactly the case a user reported: the host still holds an agent for a
  // session nobody is looking at, and its last turn already ended.
  const idleLive = planDelete(SNAPSHOTS, PARENT, (id) => (id === PARENT ? { live: true, running: false } : idle()))
  assert.equal(idleLive.allowed, true)
  assert.deepEqual(idleLive.blocked, [])

  const unknown = planDelete(SNAPSHOTS, PARENT, (id) => (id === PARENT ? { live: true, running: undefined } : idle()))
  assert.equal(unknown.allowed, false)
  assert.deepEqual(unknown.blocked, [PARENT])
  assert.deepEqual(unknown.running, [], 'an unknown state is not reported as running')
})

test('planDelete treats a throwing liveness predicate as held, not as idle', () => {
  const plan = planDelete(SNAPSHOTS, PARENT, () => {
    throw new Error('store unavailable')
  })
  assert.equal(plan.allowed, false)
  assert.deepEqual(plan.blocked, [PARENT, CHILD, GRANDCHILD])
  assert.deepEqual(plan.running, [])
})

test('deleteSessionBranch refuses a branch with an open turn without touching any file', async () => {
  const remove = removeSpy()
  const result = await deleteSessionBranch({
    snapshots: SNAPSHOTS,
    rootId: PARENT,
    liveness: (id) => (id === GRANDCHILD ? { live: true, running: true } : idle()),
    sessionRoot: '/nonexistent',
    projcacheDir: '/nonexistent',
    remove,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'session-active')
  assert.deepEqual(result.live, [GRANDCHILD])
  assert.deepEqual(result.running, [GRANDCHILD])
  assert.deepEqual(result.deleted, [])
  assert.equal(remove.calls.length, 0, 'a refused delete must not reach the filesystem')
})

test('deleteSessionBranch removes the whole branch and reports every id', async () => {
  const remove = removeSpy({ removed: [PARENT, CHILD], missing: [GRANDCHILD], failures: [] })
  const result = await deleteSessionBranch({
    snapshots: SNAPSHOTS,
    rootId: PARENT,
    liveness: idle,
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
    liveness: idle,
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
    deleteSessionBranch({ snapshots: [], rootId: PARENT, liveness: idle, sessionRoot: '/s', projcacheDir: '/p' }),
    TypeError,
  )
})

test('a held session reports its own code so the UI can say what to do', async () => {
  const remove = removeSpy()
  const result = await deleteSessionBranch({
    snapshots: SNAPSHOTS,
    rootId: PARENT,
    liveness: (id) => (id === PARENT ? { live: true, running: undefined } : idle()),
    sessionRoot: '/s',
    projcacheDir: '/p',
    remove,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'session-held')
  assert.deepEqual(result.running, [])
  assert.equal(remove.calls.length, 0)
})
