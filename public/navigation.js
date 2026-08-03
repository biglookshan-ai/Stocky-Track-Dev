(function installInventoryNavigation(root) {
  const STATE_KEY = 'inventoryNavigation';
  const STORAGE_KEY = 'inventoryNavigationStack:v3';
  const PLATFORM_PARAMS = new Set([
    'embedded', 'hmac', 'host', 'id_token', 'locale', 'session', 'shop', 'timestamp',
  ]);
  const APP_PATH = /^\/(?:dashboard|items(?:\/\d+)?|history(?:\/\d+)?|adjustments(?:\/new|\/\d+(?:\/edit)?)?|search|system|virtual-stock|local-items)\/?$/;

  const cleanSearch = (search = '') => {
    const params = new URLSearchParams(search);
    PLATFORM_PARAMS.forEach((name) => params.delete(name));
    const value = params.toString();
    return value ? `?${value}` : '';
  };

  const normalize = (value, base = 'https://inventory.local/dashboard') => {
    const raw = String(value || '/dashboard');
    if (raw.startsWith('#/')) return normalize(raw.slice(1), base);
    const url = new URL(raw, base);
    const pathname = url.pathname === '/' ? '/dashboard' : url.pathname.replace(/\/$/, '');
    return `${pathname}${cleanSearch(url.search)}`;
  };

  const routeFromLocation = (locationLike) => {
    if (String(locationLike.hash || '').startsWith('#/')) {
      return normalize(locationLike.hash, locationLike.href);
    }
    const pathname = locationLike.pathname === '/' ? '/dashboard' : locationLike.pathname;
    return normalize(`${pathname}${locationLike.search || ''}`, locationLike.href);
  };

  function create({
    historyImpl = root.history,
    locationImpl = root.location,
    storageImpl = root.sessionStorage,
  } = {}) {
    let entries = [];

    const readStack = () => {
      try {
        const value = JSON.parse(storageImpl?.getItem(STORAGE_KEY) || 'null');
        if (!Array.isArray(value?.entries) || !value.entries.length) return null;
        const storedEntries = value.entries
          .filter((route) => typeof route === 'string')
          .map((route) => normalize(route, locationImpl.href));
        return storedEntries.length ? storedEntries : null;
      } catch { return null; }
    };
    const saveStack = () => {
      try { storageImpl?.setItem(STORAGE_KEY, JSON.stringify({ entries })); }
      catch { /* Navigation still works in-memory when storage is unavailable. */ }
    };
    const stateForStack = () => ({
      ...(historyImpl.state && typeof historyImpl.state === 'object' ? historyImpl.state : {}),
      [STATE_KEY]: { depth: Math.max(entries.length - 1, 0) },
    });

    const initialize = () => {
      const route = routeFromLocation(locationImpl);
      const stored = readStack();
      if (stored) {
        entries = stored;
        const matchingIndex = entries.lastIndexOf(route);
        if (entries.at(-1) !== route) {
          entries = matchingIndex >= 0 ? entries.slice(0, matchingIndex + 1) : [...entries, route];
        }
      } else {
        entries = [route];
      }
      saveStack();
      historyImpl.replaceState(stateForStack(), '', route);
      return route;
    };

    const navigate = (value, { replace = false } = {}) => {
      const target = normalize(value, locationImpl.href);
      const current = routeFromLocation(locationImpl);
      if (replace || target === current) {
        entries[entries.length - 1] = target;
        saveStack();
        historyImpl.replaceState(stateForStack(), '', target);
      } else {
        entries.push(target);
        saveStack();
        historyImpl.pushState(stateForStack(), '', target);
      }
      return target;
    };

    const canGoBack = () => entries.length > 1;

    const back = (fallback = '/dashboard') => {
      let target;
      if (canGoBack()) {
        entries.pop();
        target = entries.at(-1);
      } else {
        target = normalize(fallback, locationImpl.href);
        entries = [target];
      }
      saveStack();
      historyImpl.replaceState(stateForStack(), '', target);
      return target;
    };

    return {
      back,
      canGoBack,
      initialize,
      isAppPath: (pathname) => APP_PATH.test(pathname),
      navigate,
      routeFromLocation: () => routeFromLocation(locationImpl),
    };
  }

  root.InventoryNavigation = { cleanSearch, create, normalize, routeFromLocation };
})(globalThis);
