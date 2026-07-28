import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SHOPIFY_API_SECRET = 'testsecret';
const {
  normalizeAppUrl,
  missingRequiredScopes,
  registerAll,
  verifyHmac,
  WEBHOOK_TOPICS,
} = await import('../src/webhooks.js');

test('verifyHmac accepts a correctly signed body', () => {
  const body = Buffer.from(JSON.stringify({ inventory_item_id: 1, available: 5 }));
  const sig = crypto.createHmac('sha256', 'testsecret').update(body).digest('base64');
  assert.equal(verifyHmac(body, sig), true);
});

test('verifyHmac rejects a tampered body', () => {
  const body = Buffer.from('{"available":5}');
  const sig = crypto.createHmac('sha256', 'testsecret').update('{"available":6}').digest('base64');
  assert.equal(verifyHmac(body, sig), false);
});

test('verifyHmac rejects a missing header', () => {
  assert.equal(verifyHmac(Buffer.from('x'), undefined), false);
});

test('normalizeAppUrl adds HTTPS to a Railway hostname', () => {
  assert.equal(
    normalizeAppUrl('stocky-track-dev-production.up.railway.app/'),
    'https://stocky-track-dev-production.up.railway.app',
  );
  assert.equal(normalizeAppUrl('https://example.com/'), 'https://example.com');
});

test('webhook topic list only uses supported transfer lifecycle names', () => {
  const topics = WEBHOOK_TOPICS.map(({ topic }) => topic);
  assert.equal(topics.includes('INVENTORY_TRANSFERS_UPDATED'), false);
  assert.equal(topics.includes('INVENTORY_TRANSFERS_ADD_ITEMS'), true);
  assert.equal(topics.includes('INVENTORY_TRANSFERS_REMOVE_ITEMS'), true);
});

test('missingRequiredScopes reports the exact optional inventory permissions', () => {
  const granted = [
    'read_products',
    'read_locations',
    'write_inventory',
    'read_orders',
    'read_reports',
  ];
  assert.deepEqual(missingRequiredScopes(granted), [
    'read_fulfillments',
    'read_inventory_transfers',
    'read_inventory_shipments',
    'read_inventory_shipments_received_items',
  ]);
});

test('registerAll isolates one topic failure and continues registering the rest', async () => {
  const attempted = [];
  const request = async (_ctx, _query, variables) => {
    attempted.push(variables.topic);
    if (variables.topic === 'INVENTORY_TRANSFERS_ADD_ITEMS') {
      throw new Error('topic unavailable for this shop');
    }
    return {
      webhookSubscriptionCreate: {
        webhookSubscription: { id: `gid://shopify/WebhookSubscription/${attempted.length}` },
        userErrors: [],
      },
    };
  };

  const results = await registerAll(
    { shop: 'example.myshopify.com', token: 'test' },
    'https://example.com/',
    request,
  );

  assert.equal(attempted.length, WEBHOOK_TOPICS.length);
  assert.equal(results.length, WEBHOOK_TOPICS.length);
  assert.deepEqual(results.find(({ topic }) => topic === 'INVENTORY_TRANSFERS_ADD_ITEMS'), {
    topic: 'INVENTORY_TRANSFERS_ADD_ITEMS',
    optional: true,
    requiredScope: 'read_inventory_transfers',
    ok: false,
    errors: [{ message: 'topic unavailable for this shop' }],
  });
  assert.equal(results.at(-1).ok, true);
});
