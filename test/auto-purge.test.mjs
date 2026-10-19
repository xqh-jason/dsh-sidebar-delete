/**
 * Unit tests for the auto-purge decision logic.
 *
 * Nothing here touches the filesystem or cordis: `src/auto-purge.mjs` is pure,
 * so the whole "when is a run due, and what counts as ungrouped" decision is
 * exercised directly — including the boundary cases that decide whether a real
 * session directory is deleted (a sibling directory sharing a name prefix, a
 * root workspace path, a case-insensitive filesystem, parent cycles).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'

import {
  DEFAULT_AUTO_PURGE_CONFIG,
  isInsideDir,
  localDateKey,
  nextRunAt,
  normalizeDir,
  parseTimeOfDay,
  resolveAutoPurgeConfig,
  selectPurgeTargets,
  shouldCatchUp,
} from '../src/auto-purge.mjs'

/** @returns epoch ms of a local wall-clock instant. */
function at(year, month, day, hour, minute, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime()
}

/** @returns a persistence snapshot for one session. */
function snapshot(id, header = {}) {
  return { header: { id, ...header } }
}

/** @returns the sorted ids of a list. */
function sorted(ids) {
  return [...ids].sort()
}

test('the shipped defaults are opt-in and point at 12:25', () => {
  assert.deepEqual(DEFAULT_AUTO_PURGE_CONFIG, { enabled: false, time: '12:25', workspaceScope: 'tree' })
})

test('parseTimeOfDay accepts valid wall-clock times, padded or not', () => {
  assert.deepEqual(parseTimeOfDay('12:25'), { hour: 12, minute: 25 })
  assert.deepEqual(parseTimeOfDay('9:05'), { hour: 9, minute: 5 })
  assert.deepEqual(parseTimeOfDay('09:05'), { hour: 9, minute: 5 })
  assert.deepEqual(parseTimeOfDay('0:00'), { hour: 0, minute: 0 })
  assert.deepEqual(parseTimeOfDay('00:00'), { hour: 0, minute: 0 })
  assert.deepEqual(parseTimeOfDay('23:59'), { hour: 23, minute: 59 })
  assert.deepEqual(parseTimeOfDay('00:10'), { hour: 0, minute: 10 })
})

test('parseTimeOfDay rejects out-of-range, malformed, and non-string values', () => {
  for (const value of [
    '24:00',
    '12:60',
    '25:00',
    '99:99',
    'abc',
    '',
    '12',
    '12:5',
    '12:25:00',
    ' 12:25',
    '12: 25',
    '12:25 ',
    '-1:00',
    '+9:05',
    '1e1:00',
  ]) {
    assert.equal(parseTimeOfDay(value), null, `${JSON.stringify(value)} must be rejected`)
  }
  for (const value of [1225, null, undefined, true, {}, [], () => {}]) {
    assert.equal(parseTimeOfDay(value), null, `${String(value)} must be rejected`)
  }
})

test('resolveAutoPurgeConfig defaults a missing or unusable input to disabled', () => {
  const expected = { enabled: false, time: '12:25', hour: 12, minute: 25, workspaceScope: 'tree', valid: true }
  assert.deepEqual(resolveAutoPurgeConfig(), expected)
  assert.deepEqual(resolveAutoPurgeConfig({}), expected)
  assert.deepEqual(resolveAutoPurgeConfig(undefined), expected)
  assert.deepEqual(resolveAutoPurgeConfig(null), expected)
  assert.deepEqual(resolveAutoPurgeConfig('nonsense'), expected)
  assert.deepEqual(resolveAutoPurgeConfig(0), expected)
})

test('resolveAutoPurgeConfig only arms on the strict boolean true', () => {
  assert.equal(resolveAutoPurgeConfig({ enabled: true }).enabled, true)
  for (const enabled of [false, 1, 0, 'true', 'yes', {}, []]) {
    assert.equal(resolveAutoPurgeConfig({ enabled }).enabled, false, `${JSON.stringify(enabled)} must not arm it`)
  }
})

test('resolveAutoPurgeConfig honors valid overrides', () => {
  assert.deepEqual(resolveAutoPurgeConfig({ enabled: true, time: '7:05', workspaceScope: 'exact' }), {
    enabled: true,
    time: '7:05',
    hour: 7,
    minute: 5,
    workspaceScope: 'exact',
    valid: true,
  })
})

test('resolveAutoPurgeConfig falls back to defaults and disarms on an invalid field', () => {
  for (const time of ['24:00', '12:60', 'abc', '', 1225, null]) {
    const config = resolveAutoPurgeConfig({ enabled: true, time })
    assert.equal(config.valid, false, `${JSON.stringify(time)} must invalidate the config`)
    assert.equal(config.enabled, false, 'an invalid config must not stay armed')
    assert.equal(config.time, '12:25', 'an invalid time falls back to the default')
    assert.equal(config.hour, 12)
    assert.equal(config.minute, 25)
  }
  const scope = resolveAutoPurgeConfig({ enabled: true, workspaceScope: 'nope' })
  assert.equal(scope.valid, false)
  assert.equal(scope.enabled, false)
  assert.equal(scope.workspaceScope, 'tree')
})

test('localDateKey is the local calendar day, zero-padded', () => {
  assert.equal(localDateKey(at(2026, 10, 18, 0, 0)), '2026-10-18')
  assert.equal(localDateKey(at(2026, 10, 18, 23, 59, 59)), '2026-10-18')
  assert.equal(localDateKey(at(2026, 1, 2, 3, 4)), '2026-01-02')
  assert.equal(localDateKey(at(2026, 12, 31, 23, 59)), '2026-12-31')
  // One millisecond before local midnight still belongs to the previous day.
  assert.equal(localDateKey(at(2026, 10, 19, 0, 0) - 1), '2026-10-18')
})

test('nextRunAt finds the same day when the time is still ahead', () => {
  assert.equal(nextRunAt(at(2026, 10, 18, 12, 0), '12:25'), at(2026, 10, 18, 12, 25))
  assert.equal(nextRunAt(at(2026, 10, 18, 0, 0), '00:10'), at(2026, 10, 18, 0, 10))
  assert.equal(nextRunAt(at(2026, 10, 18, 12, 24, 59), '12:25'), at(2026, 10, 18, 12, 25))
})

test('nextRunAt rolls to tomorrow once the time has passed or is exactly now', () => {
  // Exactly at the scheduled minute the run is due *now*, so the next one is
  // tomorrow; a scheduler that returned the current instant would fire twice.
  assert.equal(nextRunAt(at(2026, 10, 18, 12, 25), '12:25'), at(2026, 10, 19, 12, 25))
  assert.equal(nextRunAt(at(2026, 10, 18, 12, 25, 0) + 1, '12:25'), at(2026, 10, 19, 12, 25))
  assert.equal(nextRunAt(at(2026, 10, 18, 23, 30), '12:25'), at(2026, 10, 19, 12, 25))
})

test('nextRunAt crosses midnight, month, and year boundaries', () => {
  assert.equal(nextRunAt(at(2026, 10, 18, 23, 30), '00:10'), at(2026, 10, 19, 0, 10))
  assert.equal(nextRunAt(at(2026, 10, 31, 23, 0), '08:00'), at(2026, 11, 1, 8, 0))
  assert.equal(nextRunAt(at(2026, 12, 31, 23, 59), '00:05'), at(2027, 1, 1, 0, 5))
})

test('nextRunAt is strictly in the future for every minute of a day', () => {
  for (let hour = 0; hour < 24; hour += 1) {
    for (const minute of [0, 10, 25, 59]) {
      const nowMs = at(2026, 10, 18, hour, minute, 30)
      for (const time of ['00:00', '9:05', '12:25', '23:59']) {
        const next = nextRunAt(nowMs, time)
        assert.ok(next > nowMs, `${time} from ${hour}:${minute} must be in the future`)
        assert.ok(next - nowMs <= 24 * 60 * 60 * 1000, `${time} must land within a day`)
      }
    }
  }
})

test('nextRunAt refuses a time it cannot parse', () => {
  assert.throws(() => nextRunAt(Date.now(), '24:00'), TypeError)
  assert.throws(() => nextRunAt(Date.now(), undefined), TypeError)
})

test('shouldCatchUp is false before the scheduled moment', () => {
  assert.equal(shouldCatchUp({ nowMs: at(2026, 10, 18, 12, 0), time: '12:25' }), false)
  assert.equal(shouldCatchUp({ nowMs: at(2026, 10, 18, 0, 0), time: '12:25', lastRunDate: '2020-01-01' }), false)
  assert.equal(shouldCatchUp({ nowMs: at(2026, 10, 18, 12, 0), time: 'bogus' }), false)
})

test('shouldCatchUp is true after the moment when today was never recorded', () => {
  const nowMs = at(2026, 10, 18, 13, 0)
  assert.equal(shouldCatchUp({ nowMs, time: '12:25' }), true, 'no state at all')
  assert.equal(shouldCatchUp({ nowMs, time: '12:25', lastRunDate: null }), true, 'null state')
  assert.equal(shouldCatchUp({ nowMs, time: '12:25', lastRunDate: undefined }), true, 'undefined state')
  assert.equal(shouldCatchUp({ nowMs, time: '12:25', lastRunDate: '' }), true, 'empty state')
  assert.equal(shouldCatchUp({ nowMs, time: '12:25', lastRunDate: 42 }), true, 'non-string state')
  assert.equal(shouldCatchUp({ nowMs, time: '12:25', lastRunDate: {} }), true, 'object state')
  assert.equal(shouldCatchUp({ nowMs, time: '12:25', lastRunDate: '2026-10-17' }), true, 'yesterday')
})

test('shouldCatchUp is false once today is recorded, including exactly at the moment', () => {
  const today = '2026-10-18'
  assert.equal(shouldCatchUp({ nowMs: at(2026, 10, 18, 13, 0), time: '12:25', lastRunDate: today }), false)
  // Exactly at the scheduled instant the run is due, but if it already ran
  // today there is nothing to catch up on.
  assert.equal(shouldCatchUp({ nowMs: at(2026, 10, 18, 12, 25), time: '12:25', lastRunDate: today }), false)
  assert.equal(shouldCatchUp({ nowMs: at(2026, 10, 18, 12, 25), time: '12:25' }), true)
})

test('normalizeDir resolves, strips trailing separators, and keeps the root', () => {
  assert.equal(normalizeDir('/Users/x/a/'), '/Users/x/a')
  assert.equal(normalizeDir('/Users/x/a///'), '/Users/x/a')
  assert.equal(normalizeDir('/Users/x/a'), '/Users/x/a')
  assert.equal(normalizeDir('/'), '/')
  assert.equal(normalizeDir('/Users/x/./a/../a'), '/Users/x/a')
  assert.equal(normalizeDir('a'), path.resolve('a'))
  for (const value of ['', '   ', undefined, null, 42, {}, []]) {
    assert.equal(normalizeDir(value), undefined, `${String(value)} is not a directory`)
  }
})

test('isInsideDir compares path segments, not raw string prefixes', () => {
  assert.equal(isInsideDir('/x/a2', '/x/a'), false, "'/x/a2' is a sibling of '/x/a'")
  assert.equal(isInsideDir('/x/ab', '/x/a'), false)
  assert.equal(isInsideDir('/x/a.txt', '/x/a'), false)
  assert.equal(isInsideDir('/x/a', '/x/a'), true)
  assert.equal(isInsideDir('/x/a/b', '/x/a'), true)
  assert.equal(isInsideDir('/x/a/b/c', '/x/a'), true)
  assert.equal(isInsideDir('/x/a/b', '/x/a/'), true, 'a trailing separator on the directory is irrelevant')
  assert.equal(isInsideDir('/x/a/b/', '/x/a'), true)
})

test('isInsideDir treats the filesystem root as containing everything', () => {
  assert.equal(isInsideDir('/', '/'), true)
  assert.equal(isInsideDir('/anything/at/all', '/'), true)
  assert.equal(isInsideDir('relative', '/'), true)
})

test('isInsideDir is false when either side is not a usable path', () => {
  assert.equal(isInsideDir(undefined, '/x'), false)
  assert.equal(isInsideDir('/x', undefined), false)
  assert.equal(isInsideDir('', '/x'), false)
  assert.equal(isInsideDir('/x', ''), false)
  assert.equal(isInsideDir(42, '/x'), false)
})

test('isInsideDir follows the platform on a case-insensitive filesystem', () => {
  const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32'
  assert.equal(isInsideDir('/X/A/B', '/x/a'), caseInsensitive, `platform ${process.platform}`)
  assert.equal(isInsideDir('/x/a/b', '/X/A'), caseInsensitive, `platform ${process.platform}`)
})

test('selectPurgeTargets keeps workspace sessions (and only them) under the tree scope', () => {
  const snapshots = [
    snapshot('inside', { cwd: '/ws/proj' }),
    snapshot('at-root', { cwd: '/ws' }),
    snapshot('outside', { cwd: '/Users/nobody' }),
    snapshot('no-cwd'),
  ]
  const plan = selectPurgeTargets({ snapshots, workspacePaths: ['/ws'], scope: 'tree' })
  assert.deepEqual(sorted(plan.kept), ['at-root', 'inside'])
  assert.deepEqual(sorted(plan.ungrouped), ['no-cwd', 'outside'])
  assert.deepEqual(sorted(plan.targets), ['no-cwd', 'outside'])
})

test('selectPurgeTargets under the exact scope keeps only the workspace directory itself', () => {
  const snapshots = [snapshot('inside', { cwd: '/ws/proj' }), snapshot('at-root', { cwd: '/ws' })]
  const plan = selectPurgeTargets({ snapshots, workspacePaths: ['/ws/'], scope: 'exact' })
  assert.deepEqual(plan.kept, ['at-root'])
  assert.deepEqual(sorted(plan.ungrouped), ['inside'])
  assert.deepEqual(plan.targets, ['inside'])
})

test('selectPurgeTargets carries workspace membership down the parent chain', () => {
  const snapshots = [
    snapshot('parent', { cwd: '/ws' }),
    snapshot('child', { cwd: '/tmp/child', parentSession: 'parent' }),
    snapshot('grandchild', { cwd: '/tmp/grandchild', parentSession: 'child' }),
  ]
  const plan = selectPurgeTargets({ snapshots, workspacePaths: ['/ws'], scope: 'tree' })
  assert.deepEqual(sorted(plan.kept), ['child', 'grandchild', 'parent'])
  assert.deepEqual(plan.ungrouped, [])
  assert.deepEqual(plan.targets, [])
})

test('selectPurgeTargets reports only the roots of an ungrouped branch', () => {
  const snapshots = [
    snapshot('parent', { cwd: '/tmp/p' }),
    snapshot('child', { cwd: '/tmp/c', parentSession: 'parent' }),
    snapshot('grandchild', { cwd: '/tmp/g', parentSession: 'child' }),
  ]
  const plan = selectPurgeTargets({ snapshots, workspacePaths: ['/ws'], scope: 'tree' })
  assert.deepEqual(sorted(plan.ungrouped), ['child', 'grandchild', 'parent'])
  assert.deepEqual(plan.targets, ['parent'], 'one cascade covers the whole branch')
})

test('selectPurgeTargets keeps the children of a kept session even when their cwd is elsewhere', () => {
  const snapshots = [snapshot('parent', { cwd: '/ws' }), snapshot('child', { cwd: '/tmp/c', parentSession: 'parent' })]
  const plan = selectPurgeTargets({ snapshots, workspacePaths: ['/ws'], scope: 'tree' })
  assert.deepEqual(plan.targets, [])
  assert.deepEqual(sorted(plan.ungrouped), [])
})

test('selectPurgeTargets treats a missing or unknown parent as a root', () => {
  const snapshots = [
    snapshot('orphan', { cwd: '/tmp/o', parentSession: 'session-does-not-exist' }),
    snapshot('plain', { cwd: '/tmp/p' }),
  ]
  const plan = selectPurgeTargets({ snapshots, workspacePaths: [], scope: 'tree' })
  assert.deepEqual(sorted(plan.targets), ['orphan', 'plain'])
})

test('selectPurgeTargets treats a session without a usable cwd as ungrouped', () => {
  const snapshots = [snapshot('missing'), snapshot('blank', { cwd: '   ' }), snapshot('numeric', { cwd: 42 })]
  const plan = selectPurgeTargets({ snapshots, workspacePaths: ['/ws'], scope: 'tree' })
  assert.deepEqual(plan.kept, [])
  assert.deepEqual(sorted(plan.ungrouped), ['blank', 'missing', 'numeric'])
  assert.deepEqual(sorted(plan.targets), ['blank', 'missing', 'numeric'])
})

test('selectPurgeTargets considers every session ungrouped when no workspace is registered', () => {
  const snapshots = [snapshot('a', { cwd: '/anywhere' }), snapshot('b', { cwd: '/anywhere/deep' })]
  for (const workspacePaths of [[], undefined]) {
    const plan = selectPurgeTargets({ snapshots, workspacePaths, scope: 'tree' })
    assert.deepEqual(plan.kept, [])
    assert.deepEqual(sorted(plan.ungrouped), ['a', 'b'])
    assert.deepEqual(sorted(plan.targets), ['a', 'b'])
  }
})

test('selectPurgeTargets survives a parent cycle instead of looping forever', () => {
  const snapshots = [
    snapshot('a', { cwd: '/tmp/a', parentSession: 'b' }),
    snapshot('b', { cwd: '/tmp/b', parentSession: 'a' }),
  ]
  const plan = selectPurgeTargets({ snapshots, workspacePaths: [], scope: 'tree' })
  assert.deepEqual(sorted(plan.ungrouped), ['a', 'b'])
  // Neither is a root, so neither is deleted: a cycle has no cascade entry
  // point, and leaving it alone is the safe direction.
  assert.deepEqual(plan.targets, [])
})

test('selectPurgeTargets survives a cycle even when an unrelated session is kept', () => {
  const snapshots = [
    snapshot('ws', { cwd: '/ws' }),
    snapshot('a', { cwd: '/tmp/a', parentSession: 'b' }),
    snapshot('b', { cwd: '/tmp/b', parentSession: 'a' }),
  ]
  const plan = selectPurgeTargets({ snapshots, workspacePaths: ['/ws'], scope: 'tree' })
  assert.deepEqual(plan.kept, ['ws'])
  assert.deepEqual(sorted(plan.ungrouped), ['a', 'b'])
  // The cycle has no root, and the kept session is outside it, so nothing in it
  // is deleted — the safe direction. The traversal still terminates.
  assert.deepEqual(plan.targets, [])
})

test('selectPurgeTargets normalizes both sides of the comparison', () => {
  const snapshots = [snapshot('inside', { cwd: '/ws/proj/../proj' }), snapshot('outside', { cwd: '/ws2' })]
  const plan = selectPurgeTargets({ snapshots, workspacePaths: ['/ws/'], scope: 'tree' })
  assert.deepEqual(plan.kept, ['inside'])
  assert.deepEqual(plan.targets, ['outside'])
})

test('selectPurgeTargets ignores malformed snapshots and duplicate ids', () => {
  const snapshots = [
    { header: { id: 'dup', cwd: '/tmp/one' } },
    { header: { id: 'dup', cwd: '/ws' } },
    { header: { id: 42 } },
    { header: {} },
    {},
    null,
  ]
  const plan = selectPurgeTargets({ snapshots, workspacePaths: ['/ws'], scope: 'tree' })
  assert.deepEqual(plan.targets, ['dup'], 'the first snapshot of an id wins')
  assert.deepEqual(plan.ungrouped, ['dup'])
  assert.deepEqual(plan.kept, [])
})

test('selectPurgeTargets defaults to the tree scope and tolerates junk options', () => {
  const snapshots = [snapshot('inside', { cwd: '/ws/deep' })]
  assert.deepEqual(selectPurgeTargets({ snapshots, workspacePaths: ['/ws'], scope: 'weird' }).kept, ['inside'])
  assert.deepEqual(selectPurgeTargets().targets, [])
  assert.deepEqual(selectPurgeTargets({ snapshots: 'nope', workspacePaths: 'nope' }).targets, [])
})

test('selectPurgeTargets deduplicates and drops junk workspace paths', () => {
  const snapshots = [snapshot('inside', { cwd: '/ws/deep' })]
  const plan = selectPurgeTargets({
    snapshots,
    workspacePaths: ['/ws', '/ws/', '', '   ', undefined, 42, '/other'],
    scope: 'tree',
  })
  assert.deepEqual(plan.kept, ['inside'])
  assert.deepEqual(plan.ungrouped, [])
})
