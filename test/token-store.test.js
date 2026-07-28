import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptToken, encryptToken } from '../src/token-store.js';

test('offline Shopify tokens round-trip through authenticated encryption', () => {
  const secret = 'test-secret-that-is-not-a-real-shopify-key';
  const token = 'shpat_test_offline_token';
  const ciphertext = encryptToken(token, secret);
  assert.notEqual(ciphertext, token);
  assert.equal(decryptToken(ciphertext, secret), token);
});

test('offline Shopify token ciphertext rejects the wrong secret', () => {
  const ciphertext = encryptToken('shpat_test', 'secret-a');
  assert.throws(() => decryptToken(ciphertext, 'secret-b'));
});
