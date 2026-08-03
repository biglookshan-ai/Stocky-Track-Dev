import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalReference, referenceAdminUrl } from '../src/references.js';

test('canonicalizes Order and Inventory::Transfer references', () => {
  assert.deepEqual(canonicalReference({
    reference_document_uri: 'gid://shopify/Order/123',
  }), {
    canonicalUri: 'gid://shopify/Order/123',
    type: 'Order',
    id: '123',
    originalUri: 'gid://shopify/Order/123',
  });
  assert.deepEqual(canonicalReference({
    reference_document_type: 'Inventory::Transfer',
    reference_document_id: '456',
  }), {
    canonicalUri: 'gid://shopify/InventoryTransfer/456',
    type: 'InventoryTransfer',
    id: '456',
    originalUri: null,
  });
});

test('builds Shopify Admin links for supported references', () => {
  assert.equal(
    referenceAdminUrl('cinegearpro.myshopify.com', 'Order', '123'),
    'https://admin.shopify.com/store/cinegearpro/orders/123',
  );
  assert.equal(
    referenceAdminUrl('cinegearpro.myshopify.com', 'InventoryTransfer', '456'),
    'https://admin.shopify.com/store/cinegearpro/inventory/transfers/456',
  );
});

test('normalizedType: TransferAdjustment is not an InventoryTransfer', () => {
  // Substring matching used to turn a manual stock edit into a transfer link.
  assert.equal(canonicalReference({
    reference_document_type: 'TransferAdjustment',
    reference_document_id: '19cf7524-82e0-4eab-81a9-05d10a15ad62',
  }), null);
});

test('normalizedType: a real transfer still resolves', () => {
  const ref = canonicalReference({
    reference_document_type: 'InventoryTransfer',
    reference_document_id: '10654',
  });
  assert.equal(ref.type, 'InventoryTransfer');
});
