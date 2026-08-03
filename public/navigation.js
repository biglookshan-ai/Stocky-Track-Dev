(function installInventoryNavigation(root) {
  const STATE_KEY = 'inventoryNavigation';
  const STORAGE_PREFIX = 'inventoryNavigation:';
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
    let navigationId = null;
    let maxDepth = 0;

    const meta = () => historyImpl.state?.[STATE_KEY] || null;
    const newNavigationId = () => root.crypto?.randomUUID?.()
      || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const readMaxDepth = (id) => {
      try {
        const value = Number.parseInt(storageImpl?.getItem(`${STORAGE_PREFIX}${id}`), 10);
        return Number.isInteger(value) && value >= 0 ? value : 0;
      } catch { return 0; }
    };
    const saveMaxDepth = () => {
      try { storageImpl?.setItem(`${STORAGE_PREFIX}${navigationId}`, String(maxDepth)); }
      catch { /* History still works in-memory when storage is unavailable. */ }
    };
    const stateAtDepth = (depth) => ({
      ...(historyImpl.state && typeof historyImpl.state === 'object' ? historyImpl.state : {}),
      [STATE_KEY]: { id: navigationId, depth },
    });

    const initialize = () => {
      const route = routeFromLocation(locationImpl);
      const currentMeta = meta();
      navigationId = currentMeta?.id || newNavigationId();
      const depth = Number.isInteger(currentMeta?.depth) ? currentMeta.depth : 0;
      // Shopify can reload the embedded frame while moving through top-level
      // Admin history. sessionStorage survives that reload, so keep the known
      // furthest entry and make Forward available again on the restored page.
      maxDepth = Math.max(maxDepth, depth, readMaxDepth(navigationId));
      saveMaxDepth();
      historyImpl.replaceState(stateAtDepth(depth), '', route);
      return route;
    };

    const navigate = (value, { replace = false } = {}) => {
      const target = normalize(value, locationImpl.href);
      const current = routeFromLocation(locationImpl);
      const currentDepth = Number.isInteger(meta()?.depth) ? meta().depth : 0;
      if (replace || target === current) {
        historyImpl.replaceState(stateAtDepth(currentDepth), '', target);
      } else {
        const nextDepth = currentDepth + 1;
        historyImpl.pushState(stateAtDepth(nextDepth), '', target);
        maxDepth = nextDepth;
        saveMaxDepth();
      }
      return target;
    };

    const canGoBack = () => Number(meta()?.depth || 0) > 0;
    const canGoForward = () => Number(meta()?.depth || 0) < maxDepth;

    const back = (fallback = '/dashboard') => {
      if (canGoBack()) historyImpl.back();
      else navigate(fallback, { replace: true });
    };

    const forward = () => {
      if (canGoForward()) historyImpl.forward();
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
