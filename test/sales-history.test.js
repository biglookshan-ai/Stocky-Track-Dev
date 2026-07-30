import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifySalesMovement,
  salesHistoryStart,
  summarizeSalesHistory,
} from '../src/sales-history.js';

const base = {
  occurred_at: '2026-07-20T12:00:00.000Z',
  reference_document_type: 'Order',
  reference_document_uri: 'gid://shopify/Order/42',
  source_type: 'order',
};

test('sales movement classification ignores reservations and manual inventory changes', () => {
  assert.equal(classifySalesMovement({
    ...base,
    activity: 'purchase',
    on_hand_delta: 0,
    available_delta: -1,
  }), null);
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
      activity: 'order_fulfilled',
      on_hand_delta: -2,
    },
    {
      ...base,
      event_id: 2,
      occurred_at: '2026-07-21T12:00:00.000Z',
      activity: 'return_restock',
      source_type: 'refund',
      on_hand_delta: 1,
    },
    {
      event_id: 3,
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

  assert.equal(result.summary.sold, 2);
  assert.equal(result.summary.returned, 1);
  assert.equal(result.summary.netSold, 1);
  assert.equal(result.summary.received, 8);
  assert.equal(result.summary.salesOrders, 1);
  assert.equal(result.series.length, 30);
  assert.deepEqual(
    result.series.find((row) => row.period === '2026-07-20'),
    { period: '2026-07-20', sold: 2, returned: 0, received: 0 },
  );
  assert.ok(result.summary.averageWeekly > 0);
  assert.ok(result.summary.coverageDays > 0);
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
