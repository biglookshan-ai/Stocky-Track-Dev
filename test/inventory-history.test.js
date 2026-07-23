import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHistoryQuery,
  classifyHistorySource,
  externalChangeId,
  groupAuditEvents,
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
