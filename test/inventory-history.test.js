import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHistoryQuery,
  coveredBySum,
  classifyHistorySource,
  externalChangeId,
  groupAuditEvents,
  incrementalHistoryStart,
  historyWindowDays,
  normalizeGid,
} from '../src/inventory-history.js';

test('buildHistoryQuery requests event-level adjustment dimensions', () => {
  const query = buildHistoryQuery(
    new Date('2026-07-22T10:00:00Z'),
    new Date('2026-07-22T11:00:00Z'),
    250,
  );
  assert.match(query, /FROM inventory_adjustment_history/);
  assert.match(query, /SINCE 2026-07-22T10:00:00 UNTIL 2026-07-22T11:00:00/);
  assert.match(query, /inventory_adjustment_group_id/);
  assert.match(query, /staff_member_name/);
  assert.match(query, /LIMIT 250/);
});

test('history sync batches recent and backfill windows without losing adaptive splitting', () => {
  assert.equal(historyWindowDays(true), 2);
  assert.equal(historyWindowDays(false), 7);
});

test('explicit recent replay ignores the saved incremental cursor', () => {
  const requestedStart = new Date('2026-07-26T12:00:00Z');
  const state = { mode: 'incremental', cursor: '2026-07-28T12:00:00Z' };
  assert.equal(
    incrementalHistoryStart({ since: requestedStart.toISOString(), state, requestedStart }),
    requestedStart,
  );
  assert.equal(
    incrementalHistoryStart({ since: null, state, requestedStart }).toISOString(),
    '2026-07-26T12:00:00.000Z',
  );
});

test('normalizes Shopify numeric identities without touching GIDs', () => {
  assert.equal(normalizeGid('InventoryItem', 123), 'gid://shopify/InventoryItem/123');
  assert.equal(
    normalizeGid('InventoryItem', 'gid://shopify/InventoryItem/123'),
    'gid://shopify/InventoryItem/123',
  );
});

test('history source classification prefers transfer, staff and app attribution', () => {
  assert.equal(classifyHistorySource({ reference_document_type: 'InventoryTransfer' }), 'transfer');
  assert.equal(classifyHistorySource({ staff_id: 1 }), 'admin_manual');
  assert.equal(classifyHistorySource({ inventory_app_name: 'Bundles.app' }), 'external_app');
});

test('external change ID is stable for retries', () => {
  const row = { inventory_adjustment_id: 99, inventory_state: 'Available' };
  assert.equal(externalChangeId(row), externalChangeId({ ...row }));
  assert.equal(externalChangeId(row), 'shopify:99:available');
});

test('groups state changes into an Admin-style inventory event', () => {
  const rows = [
    {
      event_id: 7, event_occurred_at: '2026-07-23T10:47:00Z',
      activity: 'Correction', event_app_name: 'Bundles.app',
      event_source_type: 'external_app', location: 'External Warehouse',
      event_reference_uri: 'gid://shopify/Order/123',
      event_reference_type: 'Order', event_reference_id: '123',
      state: 'available', delta: -1, computed_qty_after: 0,
    },
    {
      event_id: 7, event_occurred_at: '2026-07-23T10:47:00Z',
      activity: 'Correction', event_app_name: 'Bundles.app',
      event_source_type: 'external_app', location: 'External Warehouse',
      state: 'on_hand', delta: -1, computed_qty_after: 0,
    },
  ];
  const levels = [{
    name: 'External Warehouse', available: 0, on_hand: 0,
    committed: 0, incoming: 0, reserved: 0, damaged: 0,
    safety_stock: 0, quality_control: 0,
  }];
  const [event] = groupAuditEvents(rows, levels);
  assert.equal(event.created_by, 'Bundles.app');
  assert.equal(event.reference_document_uri, 'gid://shopify/Order/123');
  assert.equal(event.reference_document_type, 'Order');
  assert.equal(event.reference_document_id, '123');
  assert.deepEqual(event.changes.available, { delta: -1, qty_after: 0 });
  assert.deepEqual(event.changes.on_hand, { delta: -1, qty_after: 0 });
  assert.deepEqual(event.changes.unavailable, { delta: 0, qty_after: 0 });
  assert.deepEqual(event.changes.committed, { delta: 0, qty_after: 0 });
});

// --- coveredBySum (Pass 2 of provisional placeholder merging) ---

const P = (state, delta, at = '2026-07-31T10:00:00Z') => ({
  item_id: 1, location_id: 2, state, delta, occurred_at: at,
});
const F = (state, delta, at = '2026-07-31T10:01:00Z') => ({
  item_id: 1, location_id: 2, state, delta, occurred_at: at,
});

test('coveredBySum: coalesced webhook -2 covered by two formal -1 rows', () => {
  assert.equal(coveredBySum(
    [P('available', -2)],
    [F('available', -1, '2026-07-31T10:00:10Z'), F('available', -1, '2026-07-31T10:00:40Z')],
  ), true);
});

test('coveredBySum: contamination by an unrelated formal row fails closed', () => {
  assert.equal(coveredBySum(
    [P('available', -2)],
    [F('available', -1), F('available', -1), F('available', 5)],
  ), false);
});

test('coveredBySum: no formal rows fails', () => {
  assert.equal(coveredBySum([P('available', -1)], []), false);
});

test('coveredBySum: empty provisional never merges', () => {
  assert.equal(coveredBySum([], [F('available', -1)]), false);
});

test('coveredBySum: every provisional state must be covered', () => {
  assert.equal(coveredBySum(
    [P('available', -1), P('on_hand', -1)],
    [F('available', -1)],
  ), false);
  assert.equal(coveredBySum(
    [P('available', -1), P('on_hand', -1)],
    [F('available', -1), F('on_hand', -1)],
  ), true);
});

test('coveredBySum: formal rows outside the window are ignored', () => {
  assert.equal(coveredBySum(
    [P('available', -1)],
    [F('available', -1, '2026-07-31T10:20:00Z')],
  ), false);
});

test('coveredBySum: different item or location never matches', () => {
  assert.equal(coveredBySum(
    [P('available', -1)],
    [{ item_id: 9, location_id: 2, state: 'available', delta: -1, occurred_at: '2026-07-31T10:00:30Z' }],
  ), false);
});

test('coveredBySum: exact single formal row also passes (superset of pass 1)', () => {
  assert.equal(coveredBySum([P('available', 3)], [F('available', 3)]), true);
});

test('classifyHistorySource: TransferAdjustment by staff is a manual edit', () => {
  assert.equal(classifyHistorySource({
    reference_document_type: 'TransferAdjustment',
    staff_member_name: 'biglook shan',
  }), 'admin_manual');
});

test('classifyHistorySource: a real transfer is still a transfer', () => {
  assert.equal(classifyHistorySource({ reference_document_type: 'InventoryTransfer' }), 'transfer');
});
