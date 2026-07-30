import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifySalesMovement,
  dedupeProvisionalSalesRows,
  salesHistoryStart,
  summarizeSalesHistory,
} from '../src/sales-history.js';

const base = {
  occurred_at: '2026-07-20T12:00:00.000Z',
  reference_document_type: 'Order',
  reference_document_uri: 'gid://shopify/Order/42',
  source_type: 'order',
};

test('sales movement classification separates order reservations and releases', () => {
  assert.deepEqual(classifySalesMovement({
    ...base,
    activity: 'purchased',
    on_hand_delta: 0,
    available_delta: -1,
  }), { type: 'order', quantity: 1 });
  assert.deepEqual(classifySalesMovement({
    ...base,
    activity: 'order_edited',
    on_hand_delta: 0,
    available_delta: 2,
  }), { type: 'cancel', quantity: 2 });
});

test('sales movement classification ignores manual inventory changes', () => {
  assert.equal(classifySalesMovement({
    activity: 'manually_adjusted',
    source_type: 'admin_manual',
    on_hand_delta: -2,
  }), null);
});

test('sales movement classification separates fulfilled sales, returns and purchase receipts', () => {
  assert.deepEqual(classifySalesMovement({
    ...base,
    activity: 'order_fulfilled',
    on_hand_delta: -2,
  }), { type: 'sale', quantity: 2 });
  assert.deepEqual(classifySalesMovement({
    ...base,
    activity: 'return_restock',
    source_type: 'refund',
    on_hand_delta: 1,
  }), { type: 'return', quantity: 1 });
  assert.deepEqual(classifySalesMovement({
    activity: 'purchase_order_received',
    reference_document_type: 'PurchaseOrder',
    on_hand_delta: 8,
  }), { type: 'receipt', quantity: 8 });
});

test('sales movement classification excludes internal transfers from replenishment', () => {
  assert.equal(classifySalesMovement({
    activity: 'shipment_received',
    source_type: 'transfer',
    reference_document_type: 'InventoryTransfer',
    on_hand_delta: 5,
  }), null);
});

test('sales history summarizes business movements and builds complete daily buckets', () => {
  const result = summarizeSalesHistory([
    {
      ...base,
      event_id: 1,
      occurred_at: '2026-07-19T12:00:00.000Z',
      activity: 'purchased',
      on_hand_delta: 0,
      available_delta: -2,
    },
    {
      ...base,
      event_id: 2,
      activity: 'order_fulfilled',
      on_hand_delta: -2,
    },
    {
      ...base,
      event_id: 3,
      occurred_at: '2026-07-21T12:00:00.000Z',
      activity: 'return_restock',
      source_type: 'refund',
      on_hand_delta: 1,
    },
    {
      event_id: 4,
      occurred_at: '2026-07-22T12:00:00.000Z',
      activity: 'purchase_order_received',
      reference_document_type: 'PurchaseOrder',
      on_hand_delta: 8,
    },
  ], {
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-30T00:00:00.000Z'),
    bucket: 'day',
    currentAvailable: 10,
  });

  assert.equal(result.summary.ordered, 2);
  assert.equal(result.summary.sold, 2);
  assert.equal(result.summary.pending, 0);
  assert.equal(result.summary.cancelled, 0);
  assert.equal(result.summary.returned, 1);
  assert.equal(result.summary.netSold, 1);
  assert.equal(result.summary.received, 8);
  assert.equal(result.summary.orderedOrders, 1);
  assert.equal(result.summary.salesOrders, 1);
  assert.equal(result.summary.pendingOrders, 0);
  assert.equal(result.series.length, 30);
  assert.deepEqual(
    result.series.find((row) => row.period === '2026-07-20'),
    {
      period: '2026-07-20',
      ordered: 0,
      sold: 2,
      cancelled: 0,
      returned: 0,
      received: 0,
    },
  );
  assert.ok(result.summary.averageWeekly > 0);
  assert.ok(result.summary.coverageDays > 0);
});

test('sales history derives pending quantities per order without treating them as sales', () => {
  const result = summarizeSalesHistory([
    {
      ...base,
      event_id: 10,
      activity: 'purchased',
      on_hand_delta: 0,
      available_delta: -3,
    },
    {
      ...base,
      event_id: 11,
      activity: 'order_fulfilled',
      on_hand_delta: -1,
      available_delta: 0,
    },
    {
      ...base,
      event_id: 12,
      activity: 'order_edited',
      on_hand_delta: 0,
      available_delta: 1,
    },
  ], {
    from: new Date('2026-07-20T00:00:00.000Z'),
    to: new Date('2026-07-20T23:59:59.000Z'),
    bucket: 'day',
  });

  assert.equal(result.summary.ordered, 3);
  assert.equal(result.summary.sold, 1);
  assert.equal(result.summary.cancelled, 1);
  assert.equal(result.summary.pending, 1);
  assert.equal(result.summary.orderedOrders, 1);
  assert.equal(result.summary.salesOrders, 1);
  assert.equal(result.summary.pendingOrders, 1);
  assert.equal(result.summary.cancelledOrders, 1);
});

test('sales history prefers the formal order event over its realtime placeholder', () => {
  const rows = [
    {
      event_id: 20,
      occurred_at: '2026-07-30T13:01:15.000Z',
      activity: 'inventory_updated',
      reason: 'pending_attribution',
      source_type: 'unknown',
      ledger_source_type: 'sale',
      location_id: 1,
      on_hand_delta: 0,
      available_delta: -1,
    },
    {
      ...base,
      event_id: 21,
      occurred_at: '2026-07-30T13:01:11.000Z',
      activity: 'purchased',
      location_id: 1,
      on_hand_delta: 0,
      available_delta: -1,
    },
  ];

  assert.deepEqual(dedupeProvisionalSalesRows(rows).map((row) => row.event_id), [21]);
  const result = summarizeSalesHistory(rows, {
    from: new Date('2026-07-30T00:00:00.000Z'),
    to: new Date('2026-07-30T23:59:59.000Z'),
    bucket: 'day',
  });
  assert.equal(result.summary.ordered, 1);
  assert.equal(result.summary.pending, 1);
  assert.equal(result.summary.orderedOrders, 1);
});

test('salesHistoryStart supports rolling week through annual periods', () => {
  const now = new Date('2026-07-30T12:00:00.000Z');
  assert.equal(salesHistoryStart('7', null, now).toISOString(), '2026-07-24T00:00:00.000Z');
  assert.equal(salesHistoryStart('365', null, now).toISOString(), '2025-07-31T00:00:00.000Z');
  assert.equal(
    salesHistoryStart('all', '2026-01-24T12:30:00.000Z', now).toISOString(),
    '2026-01-24T00:00:00.000Z',
  );
});
