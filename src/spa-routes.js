// Clean SPA routes are real URLs so Shopify App Bridge can mirror them in the
// top-level Admin URL and the browser's back button can restore the right page.
// The server serves the same shell for each of these on a direct load or a
// refresh — a page missing from this list answers "Cannot GET /whatever".
//
// test/spa-routes.test.js checks this list against the routes public/app.js
// actually handles, so adding a page without listing it here fails the build
// rather than in the user's browser.
export const SPA_ROUTES = [
  '/dashboard',
  '/items', '/items/:id',
  '/history', '/history/:id',
  '/adjustments', '/adjustments/new', '/adjustments/:id', '/adjustments/:id/edit',
  '/search',
  '/system',
  '/virtual-stock',
  '/local-items',
  '/lark-settings',
];
