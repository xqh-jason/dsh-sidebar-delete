/**
 * Host-half tests for the daily auto-purge.
 *
 * `index.js` is imported for real and mounted on a fake host context against a
 * temporary `$DSH_HOME` (never the real one), so every assertion here is about
 * files that actually exist or actually disappeared. The fake host doubles the
 * two services the feature reads (`workspaceRegistry`, `sessionPersistence`) and
 * the two it writes through (`sessions`/`agents` liveness, `emit`).
 *
 * The cases that matter are the ones where a real session log could be lost by
 * mistake: a missing registry (delete nothing), a workspace session (keep it,
 * and keep its children), a session with an open turn (skip it), an ungrouped
 * parent whose branch contains a kept session (leave the branch alone), and a
 * disabled feature (never touch anything, never schedule anything).
 */

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply, mountAutoPurge, purgeUngroupedOnce } from '../index.js'
import { localDateKey, nextRunAt, resolveAutoPurgeConfig } from '../src/auto-purge.mjs'
import { PURGE_STATE_VERSION, defaultPurgeStatePath, readPurgeState, writePurgeState } from '../src/purge-state.mjs'

const OPEN_TURN = 'turn/start'
const CLOSED_TURN = 'turn/end'

const created = []
const previousHome = process.env.DSH_HOME

after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const base of created) await rm(base, { recursive: true, force: true })
})

/** @returns epoch ms of a local wall-clock instant. */
function at(year, month, day, hour, minute, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime()
}

/** @returns a fresh temporary harness home. */
async function makeBase() {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-sidebar-delete-autopurge-'))
  created.push(base)
  return base
}

/**
 * Build a temporary harness home holding the given session ids.
 *
 * @param ids - session ids to materialize (log directory + cache record).
 * @returns the fixture roots.
 */
async function makeHome(ids) {
  const base = await makeBase()
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

/** @returns whether a session's log directory and cache record both exist. */
function sessionFilesExist(home, id) {
  return existsSync(path.join(home.projectDir, id)) && existsSync(path.join(home.projcache, `${id}.json`))
}

/** @returns a live-session double exposing the two members the liveness scan reads. */
function turnSession(types) {
  return {
    seq: types.length,
    eventAt: (seq) => (types[seq] === undefined ? undefined : { type: types[seq], seq }),
  }
}

/**
 * A workspace-registry double recording the cleanup calls it receives.
 *
 * @param workspacePaths - `path` values the registry lists.
 * @returns the double and its call log.
 */
function registryDouble(workspacePaths = []) {
  const calls = { unarchived: [], unpinned: [], detached: [], listed: 0 }
  const workspaces = workspacePaths.map((workspacePath) => ({
    path: workspacePath,
    sessionIds: [],
    async detachSession(id) {
      calls.detached.push(id)
    },
  }))
  return {
    calls,
    registry: {
      list: () => {
        calls.listed += 1
        return workspaces
      },
      async unarchiveSession(id) {
        calls.unarchived.push(id)
      },
      async unpinSession(id) {
        calls.unpinned.push(id)
      },
    },
  }
}

/** @returns a fake host context plus its recorders. */
function makeCtx(options = {}) {
  const {
    snapshots = [],
    running = [],
    idleLive = [],
    agentOnly = [],
    registry,
    persistence,
    persistenceThrows = false,
  } = options
  const emitted = []
  const logs = []
  const registrations = []
  const disposers = []
  const record = (level) => (message, detail) => logs.push({ level, message, detail })
  const ctx = {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    webServer: {
      register(route) {
        registrations.push(route)
        return () => {}
      },
    },
    effect(callback) {
      const dispose = callback()
      disposers.push(dispose)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    get(name) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessionPersistence') {
        if (persistence !== undefined) return persistence
        return {
          list: async () => {
            if (persistenceThrows) throw new Error('persistence unavailable')
            return snapshots
          },
        }
      }
      if (name === 'sessions') {
        return {
          get: (id) => {
            if (running.includes(id)) return turnSession([OPEN_TURN])
            if (idleLive.includes(id)) return turnSession([OPEN_TURN, CLOSED_TURN])
            return undefined
          },
        }
      }
      if (name === 'agents') return { get: (id) => (agentOnly.includes(id) ? { id } : undefined) }
      return undefined
    },
    emit(event, ...args) {
      emitted.push([event, ...args])
    },
  }
  return { ctx, emitted, logs, registrations, disposers }
}

/** @returns whether any logged line contains the given text. */
function logged(logs, needle) {
  return logs.some((entry) => String(entry.message).includes(needle))
}

/** @returns a promise that resolves after the given delay. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @returns whether the predicate became true before the deadline. */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(5)
  }
  return predicate()
}

/** @returns a fake timer registry for `mountAutoPurge`. */
function fakeTimers() {
  const timers = []
  return {
    timers,
    setTimer(fn, delayMs) {
      const timer = {
        fn,
        delayMs,
        unrefCalled: false,
        cleared: false,
        unref() {
          this.unrefCalled = true
        },
      }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      timer.cleared = true
    },
  }
}

// ---------------------------------------------------------------------------
// purgeUngroupedOnce: the safety red line and the scope rule
// ---------------------------------------------------------------------------

test('auto-purge deletes nothing without a workspace registry', async () => {
  const home = await makeHome(['session-out'])
  process.env.DSH_HOME = home.base
  const snapshots = [{ header: { id: 'session-out', cwd: '/Users/nobody' } }]

  const missing = makeCtx({ snapshots })
  const broken = makeCtx({ snapshots, registry: { list: 'not a function' } })
  const throwing = makeCtx({
    snapshots,
    registry: {
      list: () => {
        throw new Error('registry unavailable')
      },
    },
  })

  for (const [label, fake] of [['absent', missing], ['malformed', broken], ['throwing', throwing]]) {
    const result = await purgeUngroupedOnce(fake.ctx)
    assert.equal(result.ok, false, label)
    assert.equal(result.code, 'no-registry', label)
    assert.deepEqual(result.deleted, [], label)
    assert.deepEqual(result.targets, [], label)
    assert.deepEqual(fake.emitted, [], label)
  }
  assert.equal(sessionFilesExist(home, 'session-out'), true, 'the red line must leave every file alone')
})

test('auto-purge deletes nothing without a usable session listing', async () => {
  const home = await makeHome(['session-out'])
  process.env.DSH_HOME = home.base

  const noPersistence = makeCtx({ registry: registryDouble([]).registry, persistence: undefined })
  // `persistence: undefined` still yields the stub, so drop it from `get`:
  noPersistence.ctx.get = ((original) => (name) => (name === 'sessionPersistence' ? undefined : original(name)))(
    noPersistence.ctx.get,
  )
  const missing = await purgeUngroupedOnce(noPersistence.ctx)
  assert.equal(missing.code, 'no-persistence')

  const throwing = makeCtx({ registry: registryDouble([]).registry, persistenceThrows: true })
  const failed = await purgeUngroupedOnce(throwing.ctx)
  assert.equal(failed.code, 'list-failed')

  assert.equal(sessionFilesExist(home, 'session-out'), true)
})

test('auto-purge deletes only ungrouped sessions and their branches', async () => {
  const home = await makeHome(['session-ws', 'session-ws-child', 'session-out'])
  process.env.DSH_HOME = home.base
  const workspaceDir = path.join(home.base, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const { registry, calls } = registryDouble([workspaceDir])
  const snapshots = [
    { header: { id: 'session-ws', cwd: path.join(workspaceDir, 'proj') } },
    // A workspace session's child is kept even though its own cwd is elsewhere.
    { header: { id: 'session-ws-child', cwd: '/tmp/elsewhere', parentSession: 'session-ws' } },
    { header: { id: 'session-out', cwd: '/Users/nobody' } },
  ]
  const { ctx, emitted, logs } = makeCtx({ snapshots, registry })

  const result = await purgeUngroupedOnce(ctx)

  assert.equal(result.ok, true)
  assert.equal(result.scanned, 3)
  assert.deepEqual(result.targets, ['session-out'])
  assert.deepEqual(result.deleted, ['session-out'])
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(result.failures, [])
  assert.equal(sessionFilesExist(home, 'session-ws'), true, 'a workspace session is kept')
  assert.equal(sessionFilesExist(home, 'session-ws-child'), true, 'its child is kept with it')
  assert.equal(sessionFilesExist(home, 'session-out'), false, 'the ungrouped session is gone')
  assert.deepEqual(emitted, [['api-session/removed', 'session-out']])
  assert.deepEqual(calls.unarchived, ['session-out'], 'only the deleted id is retired')
  assert.ok(logged(logs, 'auto-purge targets=1 [session-out]'), 'the plan is logged before deleting')
  assert.ok(
    logged(logs, 'auto-purge scanned=3 targets=1 deleted=1 skipped=0 failures=0'),
    'the summary is logged after deleting',
  )
})

test('auto-purge matches a workspace session through the registry path realpath', async () => {
  const home = await makeHome(['session-ws'])
  process.env.DSH_HOME = home.base
  const workspaceDir = path.join(home.base, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const resolved = await realpath(workspaceDir)
  const { registry } = registryDouble([workspaceDir])
  // The cwd spells the directory the way realpath does, which on macOS differs
  // from the /var spelling the registry may hold.
  const snapshots = [{ header: { id: 'session-ws', cwd: path.join(resolved, 'proj') } }]
  const { ctx } = makeCtx({ snapshots, registry })

  const result = await purgeUngroupedOnce(ctx)

  assert.deepEqual(result.targets, [])
  assert.equal(sessionFilesExist(home, 'session-ws'), true)
})

test('auto-purge skips a session with an open turn, keeping its files and emitting nothing', async () => {
  const home = await makeHome(['session-busy', 'session-held'])
  process.env.DSH_HOME = home.base
  const { registry } = registryDouble([])
  const snapshots = [
    { header: { id: 'session-busy', cwd: '/tmp/busy' } },
    { header: { id: 'session-held', cwd: '/tmp/held' } },
  ]
  const { ctx, emitted, logs } = makeCtx({ snapshots, registry, running: ['session-busy'], agentOnly: ['session-held'] })

  const result = await purgeUngroupedOnce(ctx)

  assert.equal(result.ok, true, 'a skip is not a failure')
  assert.deepEqual(result.skipped, ['session-busy', 'session-held'])
  assert.deepEqual(result.deleted, [])
  assert.deepEqual(result.failures, [])
  assert.equal(sessionFilesExist(home, 'session-busy'), true)
  assert.equal(sessionFilesExist(home, 'session-held'), true)
  assert.deepEqual(emitted, [])
  assert.ok(logged(logs, 'kept session-busy (session-active)'))
  assert.ok(logged(logs, 'kept session-held (session-held)'))
})

test('auto-purge deletes an idle session the host still holds', async () => {
  const home = await makeHome(['session-idle'])
  process.env.DSH_HOME = home.base
  const { registry } = registryDouble([])
  const snapshots = [{ header: { id: 'session-idle', cwd: '/tmp/idle' } }]
  const { ctx, emitted } = makeCtx({ snapshots, registry, idleLive: ['session-idle'] })

  const result = await purgeUngroupedOnce(ctx)

  assert.deepEqual(result.deleted, ['session-idle'])
  assert.equal(sessionFilesExist(home, 'session-idle'), false)
  assert.deepEqual(emitted, [['api-session/removed', 'session-idle']])
})

test('auto-purge retires the deleted ids from the workspace registry', async () => {
  const home = await makeHome(['session-out', 'session-other'])
  process.env.DSH_HOME = home.base
  const { registry, calls } = registryDouble(['/a-workspace', '/another-workspace'])
  const snapshots = [
    { header: { id: 'session-out', cwd: '/Users/nobody' } },
    { header: { id: 'session-other', cwd: '/tmp/other' } },
  ]
  const { ctx } = makeCtx({ snapshots, registry })

  const result = await purgeUngroupedOnce(ctx)

  assert.deepEqual(result.deleted, ['session-out', 'session-other'])
  assert.deepEqual(calls.unarchived, ['session-out', 'session-other'])
  assert.deepEqual(calls.unpinned, ['session-out', 'session-other'])
  assert.deepEqual(calls.detached, ['session-out', 'session-other', 'session-out', 'session-other'])
})

test('auto-purge never cascades into a kept session through an ungrouped parent', async () => {
  const home = await makeHome(['session-parent', 'session-child', 'session-out'])
  process.env.DSH_HOME = home.base
  const workspaceDir = path.join(home.base, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const { registry } = registryDouble([workspaceDir])
  const snapshots = [
    { header: { id: 'session-parent', cwd: '/tmp/parent' } },
    { header: { id: 'session-child', cwd: path.join(workspaceDir, 'deep'), parentSession: 'session-parent' } },
    { header: { id: 'session-out', cwd: '/Users/nobody' } },
  ]
  const { ctx, emitted } = makeCtx({ snapshots, registry })

  const result = await purgeUngroupedOnce(ctx)

  assert.deepEqual(result.targets, ['session-out'], 'the mixed branch is not a target')
  assert.deepEqual(result.deleted, ['session-out'])
  assert.equal(sessionFilesExist(home, 'session-parent'), true, 'the ungrouped parent survives')
  assert.equal(sessionFilesExist(home, 'session-child'), true, 'the kept child survives')
  assert.deepEqual(emitted, [['api-session/removed', 'session-out']])
})

test('auto-purge reports a partial failure without stopping the round', async () => {
  const home = await makeHome(['session-out'])
  process.env.DSH_HOME = home.base
  const { registry } = registryDouble([])
  const snapshots = [
    // An id that is not a single path segment cannot be removed; the round must
    // record it and carry on to the next target.
    { header: { id: '../../etc/passwd', cwd: '/tmp/evil' } },
    { header: { id: 'session-out', cwd: '/Users/nobody' } },
  ]
  const { ctx, emitted, logs } = makeCtx({ snapshots, registry })

  const result = await purgeUngroupedOnce(ctx)

  assert.equal(result.ok, false)
  assert.deepEqual(result.deleted, ['session-out'])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].code, 'EBADID')
  assert.equal(sessionFilesExist(home, 'session-out'), false, 'a failure on one target does not stop the others')
  assert.deepEqual(emitted, [['api-session/removed', 'session-out']])
  assert.ok(logged(logs, 'failures=1'))
})

// ---------------------------------------------------------------------------
// mountAutoPurge: disabled, scheduling, catch-up, state
// ---------------------------------------------------------------------------

test('a disabled auto-purge returns no handle, reads no state, and sets no timer', () => {
  let readCalls = 0
  const probe = () => {
    readCalls += 1
    return {}
  }
  const { timers, setTimer, clearTimer } = fakeTimers()
  const deps = {
    setTimer,
    clearTimer,
    readState: probe,
    statePath: '/tmp/never-read.json',
  }
  for (const config of [{ enabled: false }, { enabled: 1 }, {}, resolveAutoPurgeConfig({}), undefined]) {
    const handle = mountAutoPurge(makeCtx().ctx, config, deps)
    assert.equal(handle, undefined, `${JSON.stringify(config)} must stay disabled`)
  }
  assert.equal(readCalls, 0, 'a disabled feature must not read the state file')
  assert.equal(timers.length, 0, 'a disabled feature must not create a timer')
})

test('mountAutoPurge re-resolves a raw config, so a bad field disarms it instead of throwing', async () => {
  const home = await makeBase()
  process.env.DSH_HOME = home
  const nowMs = at(2026, 10, 18, 12, 0)
  let readCalls = 0
  let runCalls = 0
  const { timers, setTimer, clearTimer } = fakeTimers()
  const { ctx } = makeCtx()
  const deps = {
    now: () => nowMs,
    setTimer,
    clearTimer,
    run: async () => {
      runCalls += 1
      return { ok: true }
    },
    readState: () => {
      readCalls += 1
      return {}
    },
    statePath: path.join(home, 'sidebar-delete', 'auto-purge.json'),
  }

  for (const config of [
    { enabled: true, time: '25:00' },
    { enabled: true, time: 'abc' },
    { enabled: true, time: 1225 },
    { enabled: true, workspaceScope: 'nope' },
  ]) {
    assert.equal(mountAutoPurge(ctx, config, deps), undefined, JSON.stringify(config))
  }
  assert.equal(readCalls, 0)
  assert.equal(runCalls, 0)
  assert.equal(timers.length, 0)

  // A raw but usable config still arms, with the documented default time.
  const handle = mountAutoPurge(ctx, { enabled: true }, deps)
  assert.notEqual(handle, undefined)
  await handle.ready
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delayMs, nextRunAt(nowMs, '12:25') - nowMs, 'the default 12:25 applies')
  handle.dispose()
})

test('an enabled auto-purge schedules the next run at the configured time', async () => {
  const home = await makeBase()
  process.env.DSH_HOME = home
  const statePath = path.join(home, 'sidebar-delete', 'auto-purge.json')
  const { timers, setTimer, clearTimer } = fakeTimers()
  const nowMs = at(2026, 10, 18, 12, 0)
  let runCalls = 0
  const run = async () => {
    runCalls += 1
    return { ok: true, scanned: 0, targets: [], deleted: [], skipped: [], failures: [] }
  }
  const { ctx, logs } = makeCtx()

  const handle = mountAutoPurge(
    ctx,
    resolveAutoPurgeConfig({ enabled: true, time: '12:25' }),
    { now: () => nowMs, setTimer, clearTimer, run, statePath },
  )
  assert.notEqual(handle, undefined)
  await handle.ready

  assert.equal(runCalls, 0, 'nothing is due before 12:25')
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delayMs, 25 * 60 * 1000, 'now = 12:00 must schedule 25 minutes out')
  assert.equal(timers[0].unrefCalled, true, 'the timer must not hold the process open')
  assert.equal(existsSync(statePath), false, 'no round ran, so no state is recorded')

  // Fire the timer: the round runs, the day is recorded, and the next run is
  // scheduled.
  await timers[0].fn()
  assert.equal(runCalls, 1)
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(state.version, PURGE_STATE_VERSION)
  assert.equal(state.lastRunDate, localDateKey(nowMs))
  assert.equal(state.lastRunAt, new Date(nowMs).toISOString())
  assert.deepEqual(state.summary, { ok: true, scanned: 0, targets: [], deleted: [], skipped: [], failures: [] })
  assert.equal(timers.length, 2, 'the round re-arms the timer')
  assert.equal(timers[1].delayMs, 25 * 60 * 1000)

  handle.dispose()
  assert.equal(timers[1].cleared, true, 'dispose clears the pending timer')
  assert.equal(logged(logs, 'auto-purge run failed'), false)
})

test('an enabled auto-purge catches up on a missed run and then keeps the daily cadence', async () => {
  const home = await makeBase()
  process.env.DSH_HOME = home
  const statePath = path.join(home, 'sidebar-delete', 'auto-purge.json')
  const { timers, setTimer, clearTimer } = fakeTimers()
  const nowMs = at(2026, 10, 18, 18, 0)
  let runCalls = 0
  const run = async () => {
    runCalls += 1
    return { ok: true, scanned: 3, targets: [], deleted: [], skipped: [], failures: [] }
  }
  const { ctx, logs } = makeCtx()

  const handle = mountAutoPurge(
    ctx,
    resolveAutoPurgeConfig({ enabled: true, time: '12:25' }),
    { now: () => nowMs, setTimer, clearTimer, run, statePath },
  )
  await handle.ready

  assert.equal(runCalls, 1, 'the missed 12:25 run is caught up at startup')
  assert.ok(logged(logs, 'catching up on a missed run'))
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(state.lastRunDate, localDateKey(nowMs))
  assert.deepEqual(state.summary, { ok: true, scanned: 3, targets: [], deleted: [], skipped: [], failures: [] })
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delayMs, nextRunAt(nowMs, '12:25') - nowMs)
  assert.equal(timers[0].delayMs, 18 * 60 * 60 * 1000 + 25 * 60 * 1000, '18:00 to tomorrow 12:25 is 18h25m')
  handle.dispose()
})

test('a second mount on the same day does not catch up again', async () => {
  const home = await makeBase()
  process.env.DSH_HOME = home
  const statePath = path.join(home, 'sidebar-delete', 'auto-purge.json')
  const nowMs = at(2026, 10, 18, 13, 0, 0)
  await writePurgeState(statePath, {
    version: PURGE_STATE_VERSION,
    lastRunDate: localDateKey(nowMs),
    lastRunAt: new Date(nowMs).toISOString(),
    summary: { ok: true },
  })
  const { timers, setTimer, clearTimer } = fakeTimers()
  let runCalls = 0
  const { ctx } = makeCtx()

  const handle = mountAutoPurge(ctx, resolveAutoPurgeConfig({ enabled: true, time: '12:25' }), {
    now: () => nowMs,
    setTimer,
    clearTimer,
    run: async () => {
      runCalls += 1
      return { ok: true }
    },
    statePath,
  })
  await handle.ready

  assert.equal(runCalls, 0, 'today already ran')
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delayMs, nextRunAt(nowMs, '12:25') - nowMs)
  assert.equal(timers[0].delayMs, 23 * 60 * 60 * 1000 + 25 * 60 * 1000, '13:00 to tomorrow 12:25 is 23h25m')
  handle.dispose()
})

test('a corrupt state file reads as never run and never breaks the mount', async () => {
  const home = await makeBase()
  process.env.DSH_HOME = home
  const statePath = path.join(home, 'sidebar-delete', 'auto-purge.json')
  await mkdir(path.dirname(statePath), { recursive: true })
  await writeFile(statePath, '{ not json at all')
  const { timers, setTimer, clearTimer } = fakeTimers()
  const nowMs = at(2026, 10, 18, 18, 0)
  let runCalls = 0
  const { ctx, logs } = makeCtx()

  const handle = mountAutoPurge(ctx, resolveAutoPurgeConfig({ enabled: true, time: '12:25' }), {
    now: () => nowMs,
    setTimer,
    clearTimer,
    run: async () => {
      runCalls += 1
      return { ok: true }
    },
    statePath,
  })
  await assert.doesNotReject(handle.ready)

  assert.equal(runCalls, 1, 'an unreadable state is treated as "never ran"')
  assert.equal(timers.length, 1)
  assert.ok(logged(logs, 'not valid JSON'))
  // The broken file is repaired, not left behind.
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(state.lastRunDate, localDateKey(nowMs))
  handle.dispose()
})

test('an overlapping round is skipped instead of running twice', async () => {
  const home = await makeBase()
  process.env.DSH_HOME = home
  const statePath = path.join(home, 'sidebar-delete', 'auto-purge.json')
  const { timers, setTimer, clearTimer } = fakeTimers()
  const nowMs = at(2026, 10, 18, 12, 0)
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let runCalls = 0
  const run = async () => {
    runCalls += 1
    await gate
    return { ok: true, scanned: 0, targets: [], deleted: [], skipped: [], failures: [] }
  }
  const { ctx, logs } = makeCtx()

  const handle = mountAutoPurge(ctx, resolveAutoPurgeConfig({ enabled: true, time: '12:25' }), {
    now: () => nowMs,
    setTimer,
    clearTimer,
    run,
    statePath,
  })
  await handle.ready

  const first = timers[0].fn()
  const second = timers[0].fn()
  release()
  await Promise.all([first, second])

  assert.equal(runCalls, 1, 'the second trigger must not start a second round')
  assert.ok(logged(logs, 'skipped an overlapping run'))
  assert.equal(timers.length, 2, 'the round still re-arms exactly one timer')
  handle.dispose()
})

test('a thrown round is not recorded as today\'s run, and the timer still re-arms', async () => {
  const home = await makeBase()
  process.env.DSH_HOME = home
  const statePath = path.join(home, 'sidebar-delete', 'auto-purge.json')
  const { timers, setTimer, clearTimer } = fakeTimers()
  const nowMs = at(2026, 10, 18, 18, 0)
  const { ctx, logs } = makeCtx()

  const handle = mountAutoPurge(ctx, resolveAutoPurgeConfig({ enabled: true, time: '12:25' }), {
    now: () => nowMs,
    setTimer,
    clearTimer,
    run: async () => {
      throw new Error('round exploded')
    },
    statePath,
  })
  await handle.ready

  assert.ok(logged(logs, 'auto-purge run failed'))
  assert.equal(existsSync(statePath), false, 'a failed round must not mark the day as done')
  assert.equal(timers.length, 1, 'the cadence survives a failed round')
  handle.dispose()
})

test('a disposed auto-purge runs nothing and arms nothing more', async () => {
  const home = await makeBase()
  process.env.DSH_HOME = home
  const statePath = path.join(home, 'sidebar-delete', 'auto-purge.json')
  const { timers, setTimer, clearTimer } = fakeTimers()
  const nowMs = at(2026, 10, 18, 12, 0)
  let runCalls = 0
  const { ctx } = makeCtx()

  const handle = mountAutoPurge(ctx, resolveAutoPurgeConfig({ enabled: true, time: '12:25' }), {
    now: () => nowMs,
    setTimer,
    clearTimer,
    run: async () => {
      runCalls += 1
      return { ok: true }
    },
    statePath,
  })
  await handle.ready
  const pending = timers[0]
  handle.dispose()
  assert.equal(pending.cleared, true)

  // A timer that was already queued when the plugin unloaded must not delete
  // anything or schedule another round.
  await pending.fn()
  assert.equal(runCalls, 0)
  assert.equal(timers.length, 1)
  handle.dispose()
  assert.equal(timers.length, 1)
})

test('the host disposer stops the auto-purge when the plugin unmounts', async () => {
  const home = await makeBase()
  process.env.DSH_HOME = home
  const statePath = path.join(home, 'sidebar-delete', 'auto-purge.json')
  const { timers, setTimer, clearTimer } = fakeTimers()
  const nowMs = at(2026, 10, 18, 12, 0)
  const { ctx, disposers } = makeCtx()

  const handle = mountAutoPurge(ctx, resolveAutoPurgeConfig({ enabled: true, time: '12:25' }), {
    now: () => nowMs,
    setTimer,
    clearTimer,
    run: async () => ({ ok: true }),
    statePath,
  })
  await handle.ready

  assert.equal(disposers.length, 1, 'the timer is owned by a ctx.effect')
  disposers[0]()
  assert.equal(timers[0].cleared, true)
  assert.equal(timers.length, 1, 'no follow-up timer is armed after unmounting')
})

// ---------------------------------------------------------------------------
// apply(): the feature is off by default and reads its own config argument
// ---------------------------------------------------------------------------

test('apply without a config keeps the auto-purge off and still registers the route', async () => {
  const home = await makeHome(['session-out'])
  process.env.DSH_HOME = home.base
  const { registry } = registryDouble([])
  const snapshots = [{ header: { id: 'session-out', cwd: '/Users/nobody' } }]
  const { ctx, emitted, logs, registrations } = makeCtx({ snapshots, registry })

  apply(ctx)
  await delay(30)

  assert.equal(registrations.length, 2, 'the delete and durability routes are still registered')
  assert.ok(logged(logs, 'auto-purge is disabled'))
  assert.deepEqual(emitted, [])
  assert.equal(sessionFilesExist(home, 'session-out'), true, 'the default must be off')
})

test('apply receives the plugin config as its second argument and honors it', async () => {
  const home = await makeHome(['session-out'])
  process.env.DSH_HOME = home.base
  const { registry } = registryDouble([])
  const snapshots = [{ header: { id: 'session-out', cwd: '/Users/nobody' } }]
  const { ctx, emitted, logs, registrations, disposers } = makeCtx({ snapshots, registry })

  // 00:00 has always already passed today, so an enabled auto-purge catches up
  // immediately and deletes the ungrouped session for real.
  apply(ctx, { enabled: true, time: '00:00' })

  assert.equal(registrations.length, 2, 'the delete and durability routes are still registered')
  assert.equal(await waitFor(() => emitted.length > 0), true, 'the caught-up round must run')
  assert.deepEqual(emitted, [['api-session/removed', 'session-out']])
  assert.equal(sessionFilesExist(home, 'session-out'), false)
  assert.equal(logged(logs, 'auto-purge is disabled'), false)
  for (const dispose of disposers) dispose()
})

test('apply keeps the auto-purge off when its config is invalid', async () => {
  const home = await makeHome(['session-out'])
  process.env.DSH_HOME = home.base
  const { registry } = registryDouble([])
  const snapshots = [{ header: { id: 'session-out', cwd: '/Users/nobody' } }]
  const { ctx, logs } = makeCtx({ snapshots, registry })

  apply(ctx, { enabled: true, time: '25:00' })
  await delay(30)

  assert.ok(logged(logs, 'auto-purge is disabled'))
  assert.equal(sessionFilesExist(home, 'session-out'), true)
})

test('apply forwards the workspace scope to the round it runs', async () => {
  const home = await makeHome(['session-inside', 'session-deep'])
  process.env.DSH_HOME = home.base
  const workspaceDir = path.join(home.base, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const { registry } = registryDouble([workspaceDir])
  const snapshots = [
    { header: { id: 'session-inside', cwd: workspaceDir } },
    // Below the workspace path: kept under `tree`, ungrouped under `exact`.
    { header: { id: 'session-deep', cwd: path.join(workspaceDir, 'deep') } },
  ]
  const { ctx, emitted, disposers } = makeCtx({ snapshots, registry })

  apply(ctx, { enabled: true, time: '00:00', workspaceScope: 'exact' })

  assert.equal(await waitFor(() => emitted.length > 0), true)
  assert.deepEqual(emitted, [['api-session/removed', 'session-deep']])
  assert.equal(sessionFilesExist(home, 'session-inside'), true)
  assert.equal(sessionFilesExist(home, 'session-deep'), false)
  for (const dispose of disposers) dispose()
})

// ---------------------------------------------------------------------------
// The state file itself
// ---------------------------------------------------------------------------

test('the default state path lives under $DSH_HOME', () => {
  process.env.DSH_HOME = '/tmp/dsh-home-probe'
  assert.equal(defaultPurgeStatePath(), path.join('/tmp/dsh-home-probe', 'sidebar-delete', 'auto-purge.json'))
  assert.equal(defaultPurgeStatePath({ DSH_HOME: '/tmp/other' }), '/tmp/other/sidebar-delete/auto-purge.json')
})

test('the state file round-trips and leaves no temp file behind', async () => {
  const home = await makeBase()
  const statePath = path.join(home, 'sidebar-delete', 'auto-purge.json')
  const state = {
    version: PURGE_STATE_VERSION,
    lastRunDate: '2026-10-18',
    lastRunAt: '2026-10-18T04:25:00.000Z',
    summary: { ok: true, scanned: 2, targets: [], deleted: [], skipped: [], failures: [] },
  }

  await writePurgeState(statePath, state)

  assert.deepEqual(await readPurgeState(statePath), state)
  assert.deepEqual(await readdir(path.dirname(statePath)), ['auto-purge.json'])
  assert.ok((await readFile(statePath, 'utf8')).endsWith('\n'))
})

test('an unreadable or malformed state file reads as "never ran" without throwing', async () => {
  const home = await makeBase()
  const statePath = path.join(home, 'sidebar-delete', 'auto-purge.json')

  assert.deepEqual(await readPurgeState(statePath), {}, 'missing')

  await mkdir(path.dirname(statePath), { recursive: true })
  const warnings = []
  const onWarn = (message) => warnings.push(String(message))
  for (const raw of ['{ not json', '[]', '"a string"', 'null', '42', '{"version":2,"lastRunDate":"2026-10-18"}', '{"version":1}', '{"version":1,"lastRunDate":42}']) {
    await writeFile(statePath, raw)
    assert.deepEqual(await readPurgeState(statePath, { onWarn }), {}, raw)
  }
  assert.equal(warnings.length, 8, 'every malformed file is reported once')
  assert.ok(warnings.every((message) => message.includes('auto-purge state file')))
})

test('a broken state read is a warning, not a crash', async () => {
  const home = await makeBase()
  const brokenPath = path.join(home, 'a-directory-not-a-file')
  await mkdir(brokenPath, { recursive: true })
  const warnings = []

  // Reading a directory fails with EISDIR rather than ENOENT; the feature must
  // still start and treat it as "never ran".
  assert.deepEqual(await readPurgeState(brokenPath, { onWarn: (message) => warnings.push(message) }), {})
  assert.equal(warnings.length, 1)
})

test('a failing state write surfaces to the caller as an error the mount only warns about', async () => {
  const home = await makeBase()
  const statePath = path.join(home, 'sidebar-delete', 'auto-purge.json')
  await assert.rejects(writePurgeState('/proc/definitely/not/writable/auto-purge.json', { version: 1 }, {}))

  const { timers, setTimer, clearTimer } = fakeTimers()
  const { ctx, logs } = makeCtx()
  const nowMs = at(2026, 10, 18, 18, 0)
  const handle = mountAutoPurge(ctx, resolveAutoPurgeConfig({ enabled: true, time: '12:25' }), {
    now: () => nowMs,
    setTimer,
    clearTimer,
    run: async () => ({ ok: true }),
    writeState: () => writePurgeState('/proc/definitely/not/writable/auto-purge.json', { version: 1 }),
    statePath,
  })
  await assert.doesNotReject(handle.ready)

  assert.equal(timers.length, 1, 'a write failure must not break the cadence')
  assert.ok(logged(logs, 'could not write its state file'))
  handle.dispose()
})
