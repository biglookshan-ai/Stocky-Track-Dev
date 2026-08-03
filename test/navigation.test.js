import assert from 'node:assert/strict';
import test from 'node:test';

await import('../public/navigation.js');
const { cleanSearch, create, routeFromLocation } = globalThis.InventoryNavigation;

function fakeBrowser(start) {
  const origin = 'https://inventory.example';
  const entries = [];
  let index = -1;
  const location = {};
  const applyUrl = (value) => {
    const url = new URL(value, origin);
    Object.assign(location, {
      origin,
      href: url.href,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    });
  };
  applyUrl(start);
  const history = {
    state: null,
    replaceState(state, _title, value) {
      applyUrl(value);
      const entry = { state, value };
      if (index < 0) { entries.push(entry); index = 0; } else entries[index] = entry;
      this.state = state;
    },
    pushState(state, _title, value) {
      applyUrl(value);
      entries.splice(index + 1, entries.length, { state, value });
      index++;
      this.state = state;
    },
    back() {
      if (index <= 0) return;
      index--;
      const entry = entries[index];
      applyUrl(entry.value);
      this.state = entry.state;
    },
    forward() {
      if (index >= entries.length - 1) return;
      index++;
      const entry = entries[index];
      applyUrl(entry.value);
      this.state = entry.state;
    },
  };
  return { entries, history, location };
}

function fakeStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('legacy hash routes migrate to clean URLs and discard Shopify bootstrap params', () => {
  const browser = fakeBrowser('/?shop=test.myshopify.com&host=abc#/items/42?historyPage=3');
  const navigation = create({ historyImpl: browser.history, locationImpl: browser.location });
  navigation.initialize();
  assert.equal(browser.location.pathname, '/items/42');
  assert.equal(browser.location.search, '?historyPage=3');
  assert.equal(browser.location.hash, '');
});

test('navigation records support repeated back in the actual visit order', () => {
  const browser = fakeBrowser('/items?q=arcana&page=2');
  const navigation = create({ historyImpl: browser.history, locationImpl: browser.location });
  navigation.initialize();
  navigation.navigate('/items/42');
  navigation.navigate('/history/99');
  navigation.back();
  assert.equal(routeFromLocation(browser.location), '/items/42');
  navigation.back();
  assert.equal(routeFromLocation(browser.location), '/items?q=arcana&page=2');
});

test('direct detail-page back uses the safe parent fallback', () => {
  const browser = fakeBrowser('/items/42');
  const storage = fakeStorage();
  const navigation = create({ historyImpl: browser.history, locationImpl: browser.location, storageImpl: storage });
  navigation.initialize();
  navigation.back('/items');
  assert.equal(routeFromLocation(browser.location), '/items');
  assert.equal(browser.entries.length, 1);
});

test('replacing detail controls keeps the list as the previous page', () => {
  const browser = fakeBrowser('/items?q=arcana&page=2');
  const navigation = create({ historyImpl: browser.history, locationImpl: browser.location });
  navigation.initialize();
  navigation.navigate('/items/42');
  navigation.navigate('/items/42?trend=committed', { replace: true });
  navigation.back();
  assert.equal(routeFromLocation(browser.location), '/items?q=arcana&page=2');
});

test('back stack survives Shopify replacing the embedded frame', () => {
  const browser = fakeBrowser('/items?q=arcana&page=2');
  const storage = fakeStorage();
  const firstLoad = create({
    historyImpl: browser.history,
    locationImpl: browser.location,
    storageImpl: storage,
  });
  firstLoad.initialize();
  firstLoad.navigate('/items/42');

  // Shopify reloads the iframe at every route and does not preserve the
  // frame's history.state. Build a three-page visit across those reloads.
  browser.history.state = null;
  const detailFrame = create({
    historyImpl: browser.history,
    locationImpl: browser.location,
    storageImpl: storage,
  });
  detailFrame.initialize();
  assert.equal(detailFrame.canGoBack(), true);
  detailFrame.navigate('/history/99');

  browser.history.state = null;
  const historyFrame = create({
    historyImpl: browser.history,
    locationImpl: browser.location,
    storageImpl: storage,
  });
  historyFrame.initialize();
  historyFrame.back();
  assert.equal(routeFromLocation(browser.location), '/items/42');

  browser.history.state = null;
  const reloadedDetailFrame = create({
    historyImpl: browser.history,
    locationImpl: browser.location,
    storageImpl: storage,
  });
  reloadedDetailFrame.initialize();
  reloadedDetailFrame.back();
  assert.equal(routeFromLocation(browser.location), '/items?q=arcana&page=2');
});

test('cleanSearch retains page state but removes embedded-app bootstrap values', () => {
  assert.equal(
    cleanSearch('?embedded=1&shop=test.myshopify.com&q=prime&page=4&host=abc'),
    '?q=prime&page=4',
  );
});
