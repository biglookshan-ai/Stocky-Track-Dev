import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInventoryAdjustmentInput,
  csvCell,
  normalizeAdjustmentInput,
  shopifyAdjustmentReason,
} from '../src/adjustment-core.js';

test('normalizes a valid multi-line adjustment draft', () => {
  assert.deepEqual(normalizeAdjustmentInput({
    locationId: '2',
    reasonId: '4',
    notes: '  cycle count  ',
    lines: [{ itemId: '10', delta: '-2' }, { itemId: 11, delta: 3 }],
  }), {
    locationId: 2,
    reasonId: 4,
    notes: 'cycle count',
    lines: [{ itemId: 10, delta: -2 }, { itemId: 11, delta: 3 }],
  });
});

test('rejects zero, fractional and duplicate draft lines', () => {
  assert.throws(() => normalizeAdjustmentInput({
    locationId: 1, reasonId: 1, lines: [{ itemId: 1, delta: 0 }],
  }), /非零整数/);
  assert.throws(() => normalizeAdjustmentInput({
    locationId: 1, reasonId: 1, lines: [{ itemId: 1, delta: 1.5 }],
  }), /非零整数/);
  assert.throws(() => normalizeAdjustmentInput({
    locationId: 1, reasonId: 1,
    lines: [{ itemId: 1, delta: 1 }, { itemId: 1, delta: 2 }],
  }), /商品重复/);
});

test('maps business reasons to Shopify adjustment reasons', () => {
  assert.equal(shopifyAdjustmentReason('-Damaged'), 'damaged');
  assert.equal(shopifyAdjustmentReason('+Return restock'), 'restock');
  assert.equal(shopifyAdjustmentReason('-Staff purchase'), 'other');
  assert.equal(shopifyAdjustmentReason('Manual Stock count'), 'correction');
});

test('builds compare-and-set inventory adjustment input', () => {
  assert.deepEqual(buildInventoryAdjustmentInput({
    reasonName: 'Manual adjustment',
    referenceDocumentUri: 'https://example.test/adjustments/4',
    lines: [{
      delta: -2,
      qty_before: 7,
      shopify_inventory_item_gid: 'gid://shopify/InventoryItem/1',
      shopify_location_gid: 'gid://shopify/Location/2',
    }],
  }), {
    name: 'available',
    reason: 'correction',
    referenceDocumentUri: 'https://example.test/adjustments/4',
    changes: [{
      delta: -2,
      inventoryItemId: 'gid://shopify/InventoryItem/1',
      locationId: 'gid://shopify/Location/2',
      changeFromQuantity: 7,
    }],
  });
});

test('escapes CSV values without changing plain identifiers', () => {
  assert.equal(csvCell('540770'), '540770');
  assert.equal(csvCell('note, with "quote"'), '"note, with ""quote"""');
  assert.equal(csvCell('line 1\nline 2'), '"line 1\nline 2"');
});
