import assert from 'node:assert/strict';
import test from 'node:test';

await import('../public/session-client.js');
const { create } = globalThis.InventorySessionClient;

test('session client refreshes an expired token and retries the request', async () => {
  const tokens = ['expired-token', 'fresh-token'];
  const calls = [];
  const client = create({
    getToken: async () => tokens.shift(),
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      return { status: options.headers.Authorization.includes('expired') ? 401 : 200 };
    },
    retryDelays: [0],
    wait: async () => {},
  });

  const response = await client.fetch('/status');
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    { url: '/api/status', authorization: 'Bearer expired-token' },
    { url: '/api/status', authorization: 'Bearer fresh-token' },
  ]);
});

test('concurrent expired requests share the same token refresh', async () => {
  let tokenCalls = 0;
  const client = create({
    getToken: async () => {
      tokenCalls++;
      return tokenCalls === 1 ? 'expired-token' : 'fresh-token';
    },
    fetchImpl: async (_url, options) => ({
      status: options.headers.Authorization.includes('expired') ? 401 : 200,
    }),
    retryDelays: [0],
    wait: async () => {},
  });

  const responses = await Promise.all([
    client.fetch('/status'),
    client.fetch('/recent-items'),
    client.fetch('/alerts'),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
  assert.equal(tokenCalls, 2);
});

test('session client returns the final 401 after bounded retries', async () => {
  let fetchCalls = 0;
  const client = create({
    getToken: async () => `token-${fetchCalls}`,
    fetchImpl: async () => {
      fetchCalls++;
      return { status: 401 };
    },
    retryDelays: [0, 0],
    wait: async () => {},
  });

  const response = await client.fetch('/status');
  assert.equal(response.status, 401);
  assert.equal(fetchCalls, 3);
});
