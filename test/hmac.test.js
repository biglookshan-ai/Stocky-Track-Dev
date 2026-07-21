import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SHOPIFY_API_SECRET = 'testsecret';
const { verifyHmac } = await import('../src/webhooks.js');

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
