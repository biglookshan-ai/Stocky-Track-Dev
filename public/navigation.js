(function installInventoryNavigation(root) {
  const STATE_KEY = 'inventoryNavigation';
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

  function create({ historyImpl = root.history, locationImpl = root.location } = {}) {
    let maxDepth = 0;

    const meta = () => historyImpl.state?.[STATE_KEY] || null;
    const stateAtDepth = (depth) => ({
      ...(historyImpl.state && typeof historyImpl.state === 'object' ? historyImpl.state : {}),
      [STATE_KEY]: { depth },
    });

    const initialize = () => {
      const route = routeFromLocation(locationImpl);
      const depth = Number.isInteger(meta()?.depth) ? meta().depth : 0;
      maxDepth = Math.max(maxDepth, depth);
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
      }
      return target;
    };

    const canGoBack = () => Number(meta()?.depth || 0) > 0;
    const canGoForward = () => {
      if (root.navigation?.entries && root.navigation?.currentEntry) {
        const entries = root.navigation.entries();
        const index = entries.findIndex((entry) => entry.key === root.navigation.currentEntry.key);
        const nextState = index >= 0 ? entries[index + 1]?.getState?.() : null;
        if (nextState?.[STATE_KEY]) return true;
      }
      return Number(meta()?.depth || 0) < maxDepth;
    };

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
