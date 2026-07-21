import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSale, matchRefund } from '../src/attribution.js';

const T0 = new Date('2026-07-10T10:00:00Z');
const at = (mins) => new Date(+T0 + mins * 60000);

test('matchSale: negative delta matches order line within window', () => {
  const row = { delta: -1, occurred_at: at(2), item_variant_num: '191088076' };
  const orders = [{ name: '#CGP126744', created_at: T0, lines: [{ variant_id: 191088076, quantity: 1 }] }];
  assert.deepEqual(matchSale(row, orders), { ref: '#CGP126744', kind: 'sale' });
});

test('matchSale: quantity smaller than |delta| does not match', () => {
  const row = { delta: -3, occurred_at: at(2), item_variant_num: '1' };
  const orders = [{ name: '#1', created_at: T0, lines: [{ variant_id: 1, quantity: 2 }] }];
  assert.equal(matchSale(row, orders), null);
});

test('matchSale: outside time window does not match', () => {
  const row = { delta: -1, occurred_at: at(45), item_variant_num: '1' };
  const orders = [{ name: '#1', created_at: T0, lines: [{ variant_id: 1, quantity: 1 }] }];
  assert.equal(matchSale(row, orders), null);
});

test('matchSale: level change slightly BEFORE order create still matches (clock skew)', () => {
  const row = { delta: -1, occurred_at: at(-0.5), item_variant_num: '1' };
  const orders = [{ name: '#1', created_at: T0, lines: [{ variant_id: 1, quantity: 1 }] }];
  assert.ok(matchSale(row, orders));
});

test('matchSale: positive delta never matches a sale', () => {
  const row = { delta: 2, occurred_at: at(1), item_variant_num: '1' };
  const orders = [{ name: '#1', created_at: T0, lines: [{ variant_id: 1, quantity: 5 }] }];
  assert.equal(matchSale(row, orders), null);
});

test('matchRefund: positive delta matches restocked refund line', () => {
  const row = { delta: 1, occurred_at: at(1), item_variant_num: '99' };
  const refunds = [{ id: 5, order_name: 'order 42', created_at: T0, lines: [{ variant_id: 99, quantity: 1, restock: true }] }];
  assert.deepEqual(matchRefund(row, refunds), { ref: 'order 42', kind: 'refund' });
});

test('matchRefund: no_restock refund does not match', () => {
  const row = { delta: 1, occurred_at: at(1), item_variant_num: '99' };
  const refunds = [{ id: 5, order_name: 'order 42', created_at: T0, lines: [{ variant_id: 99, quantity: 1, restock: false }] }];
  assert.equal(matchRefund(row, refunds), null);
});
