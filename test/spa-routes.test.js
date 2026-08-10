import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SPA_ROUTES } from '../src/spa-routes.js';

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// Adding a page to the SPA without adding it here used to ship a page that
// worked when navigated to in-app but answered "Cannot GET /page" on a direct
// load or refresh — exactly how someone opens it from a link or a bookmark.
test('every page the SPA routes to is served on a direct load', () => {
  const handled = new Set();
  for (const match of appSource.matchAll(/path === '(\/[a-z0-9-/]*)'/g)) handled.add(match[1]);
  const missing = [...handled].filter((route) => !SPA_ROUTES.includes(route));
  assert.deepEqual(missing, [], `public/app.js routes these paths that the server does not serve: ${missing.join(', ')}`);
});

test('every served route still has a page behind it', () => {
  const stale = SPA_ROUTES
    .filter((route) => !route.includes(':'))
    .filter((route) => !appSource.includes(`'${route}'`));
  assert.deepEqual(stale, [], `the server serves these paths but public/app.js has no page for them: ${stale.join(', ')}`);
});
