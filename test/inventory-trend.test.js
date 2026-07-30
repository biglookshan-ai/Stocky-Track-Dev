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
      { day: '2026-07-10', delta: 3 },
      { day: '2026-07-20', delta: -5 },
    ],
  });

  assert.equal(result.points[0].value, 1);
  assert.deepEqual(
    result.points.filter((point) => point.kind === 'change').map((point) => point.value),
    [4, -1],
  );
  assert.equal(result.points.at(-1).value, -1);
  assert.equal(result.points.at(-1).kind, 'current');
});

test('inventory trend does not invent history when the current state is unavailable', () => {
  const result = buildInventoryTrend({
    current: null,
    from: new Date('2026-07-01T00:00:00.000Z'),
    hasHistory: true,
    deltas: [{ day: '2026-07-10', delta: 2 }],
  });
  assert.deepEqual(result.points, []);
  assert.equal(result.current, null);
});
