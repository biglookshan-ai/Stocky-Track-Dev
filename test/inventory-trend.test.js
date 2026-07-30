import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInventoryTrend,
  trendStart,
} from '../src/inventory-trend.js';

test('trendStart returns an inclusive rolling window', () => {
  const now = new Date('2026-07-30T12:00:00.000Z');
  assert.equal(trendStart('30', null, now).toISOString(), '2026-07-01T00:00:00.000Z');
  assert.equal(
    trendStart('all', '2026-02-03T18:30:00.000Z', now).toISOString(),
    '2026-02-03T00:00:00.000Z',
  );
});

test('inventory trend reconstructs baseline from current quantity and ledger deltas', () => {
  const result = buildInventoryTrend({
    current: -1,
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-30T12:00:00.000Z'),
    hasHistory: true,
    deltas: [
      {
        at: '2026-07-10T09:00:00.000Z',
        delta: 3,
        activity: 'inventory_received',
        location: 'CN Warehouse',
      },
      {
        at: '2026-07-20T18:30:00.000Z',
        delta: -5,
        activity: 'order_fulfilled',
        location: 'CineGearPro Shop',
      },
    ],
  });

  assert.equal(result.points[0].value, 1);
  assert.deepEqual(
    result.points.filter((point) => point.kind === 'change').map((point) => point.value),
    [4, -1],
  );
  assert.equal(result.points[1].at, '2026-07-10T09:00:00.000Z');
  assert.equal(result.points[1].activity, 'inventory_received');
  assert.equal(result.points[1].location, 'CN Warehouse');
  assert.equal(result.points.at(-1).value, -1);
  assert.equal(result.points.at(-1).kind, 'current');
});

test('inventory trend preserves same-day changes that cancel each other', () => {
  const result = buildInventoryTrend({
    current: 0,
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-30T12:00:00.000Z'),
    hasHistory: true,
    deltas: [
      {
        at: '2026-07-14T20:59:42.000Z',
        delta: -1,
        activity: 'purchased',
        location: 'CineGearPro Shop',
      },
      {
        at: '2026-07-14T21:00:01.000Z',
        delta: 1,
        activity: 'other',
        location: 'CineGearPro Shop',
      },
    ],
  });

  const changes = result.points.filter((point) => point.kind === 'change');
  assert.deepEqual(changes.map((point) => point.value), [-1, 0]);
  assert.deepEqual(changes.map((point) => point.delta), [-1, 1]);
  assert.deepEqual(changes.map((point) => point.location), [
    'CineGearPro Shop',
    'CineGearPro Shop',
  ]);
});

test('inventory trend does not invent history when the current state is unavailable', () => {
  const result = buildInventoryTrend({
    current: null,
    from: new Date('2026-07-01T00:00:00.000Z'),
    hasHistory: true,
    deltas: [{ at: '2026-07-10T12:00:00.000Z', delta: 2 }],
  });
  assert.deepEqual(result.points, []);
  assert.equal(result.current, null);
});
