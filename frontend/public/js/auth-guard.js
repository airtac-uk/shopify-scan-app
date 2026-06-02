(function () {
  const loginPaths = new Set(['/', '/index.html']);
  const authStatusUrl = '/api/auth/status';
  const originalFetch = window.fetch.bind(window);
  let redirecting = false;

  function isLoginPage() {
    return loginPaths.has(window.location.pathname || '/');
  }

  function getReturnTo() {
    return `${window.location.pathname}${window.location.search}${window.location.hash}` || '/scan.html';
  }

  function getCookie(name) {
    const prefix = `${name}=`;
    return document.cookie
      .split('; ')
      .find((entry) => entry.startsWith(prefix))
      ?.slice(prefix.length) || '';
  }

  function getKnownShop() {
    try {
      return decodeURIComponent(getCookie('shop')).trim();
    } catch (_err) {
      return getCookie('shop').trim();
    }
  }

  function buildLoginUrl() {
    const url = new URL('/', window.location.origin);
    const returnTo = getReturnTo();
    if (!loginPaths.has(window.location.pathname || '/') && returnTo !== '/') {
      url.searchParams.set('returnTo', returnTo);
    }
    return url.toString();
  }

  function buildAuthUrl() {
    const shop = getKnownShop();
    if (!shop) return '';
    const url = new URL('/auth', window.location.origin);
    url.searchParams.set('shop', shop);
    url.searchParams.set('returnTo', getReturnTo());
    return url.toString();
  }

  function redirectToLogin() {
    if (redirecting || isLoginPage()) return;
    redirecting = true;
    window.location.replace(buildAuthUrl() || buildLoginUrl());
  }

  function getSameOriginApiPath(input) {
    try {
      const url = input instanceof Request
        ? new URL(input.url, window.location.origin)
        : new URL(String(input || ''), window.location.origin);
      if (url.origin !== window.location.origin) return '';
      return url.pathname.startsWith('/api/') ? url.pathname : '';
    } catch (_err) {
      return '';
    }
  }

  window.fetch = async function guardedFetch(input, init) {
    const response = await originalFetch(input, init);
    const path = getSameOriginApiPath(input);
    if (path && response.status === 401) {
      redirectToLogin();
    }
    return response;
  };

  window.authGuard = {
    redirectToLogin,
  };

  if (isLoginPage()) return;

  originalFetch(authStatusUrl, {
    credentials: 'same-origin',
    cache: 'no-store',
  }).then((response) => {
    if (response.status === 401) {
      redirectToLogin();
    }
  }).catch(() => {
    // Leave transient network/server failures to the page. Only confirmed 401s redirect.
  });
}());
