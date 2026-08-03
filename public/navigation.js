(function installInventoryNavigation(root) {
  const STATE_KEY = 'inventoryNavigation';
  const STORAGE_KEY = 'inventoryNavigationStack:v2';
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
    let index = 0;

    const readStack = () => {
      try {
        const value = JSON.parse(storageImpl?.getItem(STORAGE_KEY) || 'null');
        if (!Array.isArray(value?.entries) || !value.entries.length || !Number.isInteger(value.index)) return null;
        const storedEntries = value.entries
          .filter((route) => typeof route === 'string')
          .map((route) => normalize(route, locationImpl.href));
        if (!storedEntries.length) return null;
        return {
          entries: storedEntries,
          index: Math.min(Math.max(value.index, 0), storedEntries.length - 1),
        };
      } catch { return null; }
    };
    const saveStack = () => {
      try { storageImpl?.setItem(STORAGE_KEY, JSON.stringify({ entries, index })); }
      catch { /* Navigation still works in-memory when storage is unavailable. */ }
    };
    const stateAtIndex = () => ({
      ...(historyImpl.state && typeof historyImpl.state === 'object' ? historyImpl.state : {}),
      [STATE_KEY]: { index },
    });
    const closestEntryIndex = (route) => entries.reduce((closest, entry, candidate) => {
      if (entry !== route) return closest;
      if (closest < 0) return candidate;
      return Math.abs(candidate - index) < Math.abs(closest - index) ? candidate : closest;
    }, -1);

    const initialize = () => {
      const route = routeFromLocation(locationImpl);
      const stored = readStack();
      if (stored) {
        entries = stored.entries;
        index = stored.index;
        if (entries[index] !== route) {
          const matchingIndex = closestEntryIndex(route);
          if (matchingIndex >= 0) index = matchingIndex;
          else {
            entries = [...entries.slice(0, index + 1), route];
            index = entries.length - 1;
          }
        }
      } else {
        entries = [route];
        index = 0;
      }
      saveStack();
      historyImpl.replaceState(stateAtIndex(), '', route);
      return route;
    };

    const navigate = (value, { replace = false } = {}) => {
      const target = normalize(value, locationImpl.href);
      const current = routeFromLocation(locationImpl);
      if (replace || target === current) {
        entries[index] = target;
        saveStack();
        historyImpl.replaceState(stateAtIndex(), '', target);
      } else {
        entries = [...entries.slice(0, index + 1), target];
        index = entries.length - 1;
        saveStack();
        historyImpl.pushState(stateAtIndex(), '', target);
      }
      return target;
    };

    const canGoBack = () => index > 0;
    const canGoForward = () => index < entries.length - 1;

    const back = (fallback = '/dashboard') => {
      if (canGoBack()) index -= 1;
      else {
        const target = normalize(fallback, locationImpl.href);
        if (target === entries[index]) return target;
        entries = [target, ...entries];
      }
      const target = entries[index];
      saveStack();
      historyImpl.replaceState(stateAtIndex(), '', target);
      return target;
    };

    const forward = () => {
      if (!canGoForward()) return routeFromLocation(locationImpl);
      index += 1;
      const target = entries[index];
      saveStack();
      historyImpl.replaceState(stateAtIndex(), '', target);
      return target;
    };

    return {
      back,
      canGoBack,
      canGoForward,
      forward,
      initialize,
      isAppPath: (pathname) => APP_PATH.test(pathname),
      navigate,
      routeFromLocation: () => routeFromLocation(locationImpl),
    };
  }

  root.InventoryNavigation = { cleanSearch, create, normalize, routeFromLocation };
})(globalThis);
