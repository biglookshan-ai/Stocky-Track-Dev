(function installSessionClient(root) {
  function create({
    getToken,
    fetchImpl,
    basePath = '/api',
    retryDelays = [80, 180],
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    let tokenPromise = null;
    let refreshPromise = null;
    let latestToken = null;

    async function requestToken() {
      if (!tokenPromise) {
        tokenPromise = Promise.resolve()
          .then(getToken)
          .then((token) => {
            latestToken = token;
            return token;
          })
          .finally(() => { tokenPromise = null; });
      }
      return tokenPromise;
    }

    async function refreshToken(rejectedToken, delay) {
      if (latestToken && latestToken !== rejectedToken) return latestToken;
      if (!refreshPromise) {
        refreshPromise = wait(delay)
          .then(requestToken)
          .finally(() => { refreshPromise = null; });
      }
      return refreshPromise;
    }

    async function authenticatedFetch(path, opts = {}) {
      let token = await requestToken();
      let response = null;
      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        response = await fetchImpl(`${basePath}${path}`, {
          ...opts,
          headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
        });
        if (response.status !== 401) return response;
        if (attempt < retryDelays.length) {
          token = await refreshToken(token, retryDelays[attempt]);
        }
      }
      return response;
    }

    return { fetch: authenticatedFetch };
  }

  root.InventorySessionClient = { create };
})(globalThis);
