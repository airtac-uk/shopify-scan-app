(function () {
  const NAV_LINKS = [
    { href: '/pick_list.html', label: 'Orders' },
    { href: '/order_flow.html', label: 'Monitor' },
    { href: '/putting_away.html', label: 'Part Explorer' },
    { href: '/awaiting_parts.html', label: 'Awaiting Parts' },
    { href: '/print_queue.html', label: 'Print Queue' },
    { href: '/fdm_print_queue.html', label: 'FDM Print Queue' },
    { href: '/scan.html', label: 'Scanner' },
  ];

  function getCurrentPath() {
    return String(window.location.pathname || '').toLowerCase();
  }

  function isActiveLink(href, currentPath) {
    const normalizedHref = String(href || '').toLowerCase();
    if (normalizedHref === '/scan.html') {
      return currentPath === '/scan.html' ||
        currentPath === '/scan_usb.html' ||
        currentPath === '/scan_photo.html';
    }
    return currentPath === normalizedHref;
  }

  function buildLoginUrl() {
    const url = new URL('/', window.location.origin);
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (returnTo && returnTo !== '/') {
      url.searchParams.set('returnTo', returnTo);
    }
    return url.toString();
  }

  function createNav() {
    const nav = document.createElement('nav');
    nav.className = 'employee-shell-nav';
    nav.id = 'employeeShellNav';
    nav.setAttribute('aria-label', 'Employee tools');

    const currentPath = getCurrentPath();
    NAV_LINKS.forEach((item) => {
      const link = document.createElement('a');
      link.className = 'employee-shell-link';
      link.href = item.href;
      link.textContent = item.label;
      if (isActiveLink(item.href, currentPath)) {
        link.classList.add('is-active');
        link.setAttribute('aria-current', 'page');
      }
      nav.appendChild(link);
    });

    return nav;
  }

  function createMenuButton(shell) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'employee-shell-menu-btn';
    button.setAttribute('aria-controls', 'employeeShellNav');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', 'Open navigation menu');

    for (let index = 0; index < 3; index += 1) {
      const line = document.createElement('span');
      line.setAttribute('aria-hidden', 'true');
      button.appendChild(line);
    }

    function setOpen(open) {
      shell.classList.toggle('is-menu-open', open);
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      button.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
    }

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      setOpen(!shell.classList.contains('is-menu-open'));
    });

    document.addEventListener('click', (event) => {
      if (!shell.classList.contains('is-menu-open')) return;
      if (shell.contains(event.target)) return;
      setOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setOpen(false);
    });

    return button;
  }

  function createAccount() {
    const account = document.createElement('div');
    account.className = 'employee-shell-account';
    account.setAttribute('aria-live', 'polite');

    const details = document.createElement('div');
    details.className = 'employee-shell-account__details';

    const user = document.createElement('strong');
    user.className = 'employee-shell-account__user';
    user.textContent = 'Checking session';

    const shop = document.createElement('span');
    shop.className = 'employee-shell-account__shop';
    shop.textContent = 'Please wait';

    details.append(user, shop);

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'employee-shell-account__action';
    action.textContent = 'Log out';
    action.disabled = true;

    account.append(details, action);
    return { account, user, shop, action };
  }

  function updateAccount(accountParts, status) {
    const { user, shop, action } = accountParts;
    const authenticated = Boolean(status?.authenticated);

    action.disabled = false;
    action.replaceChildren();

    if (authenticated) {
      user.textContent = status.user || 'Signed in';
      shop.textContent = status.shop || 'Employee session';
      action.textContent = 'Log out';
      action.addEventListener('click', () => {
        action.disabled = true;
        action.textContent = 'Logging out...';
        if (window.authGuard?.logout) {
          window.authGuard.logout();
          return;
        }
        window.location.assign('/auth/logout');
      }, { once: true });
      return;
    }

    user.textContent = status?.unavailable ? 'Session unavailable' : 'Not signed in';
    shop.textContent = 'Employee tools';
    action.textContent = 'Log in';
    action.addEventListener('click', () => {
      window.location.assign(buildLoginUrl());
    }, { once: true });
  }

  function syncShellOffset(shell) {
    const applyOffset = () => {
      const height = Math.ceil(shell.getBoundingClientRect().height || 0);
      document.documentElement.style.setProperty('--employee-shell-offset', `${height}px`);
    };

    applyOffset();

    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(applyOffset);
      observer.observe(shell);
    } else {
      window.addEventListener('resize', applyOffset);
    }
  }

  async function loadAuthStatus() {
    if (window.authGuard?.getAuthStatus) {
      return window.authGuard.getAuthStatus();
    }

    const response = await fetch('/api/auth/status', {
      credentials: 'same-origin',
      cache: 'no-store',
    });

    if (response.status === 401) {
      window.location.replace(buildLoginUrl());
      return { authenticated: false };
    }

    if (!response.ok) return { authenticated: false, unavailable: true };
    return response.json();
  }

  function init() {
    if (!document.body || document.querySelector('.employee-shell')) return;

    document.body.classList.add('employee-shell-enabled');

    const shell = document.createElement('div');
    shell.className = 'employee-shell';

    const brand = document.createElement('a');
    brand.className = 'employee-shell-brand';
    brand.href = '/pick_list.html';
    brand.textContent = 'AIRTAC';

    const nav = createNav();
    const menuButton = createMenuButton(shell);
    const accountParts = createAccount();

    shell.append(brand, menuButton, nav, accountParts.account);
    document.body.insertBefore(shell, document.body.firstChild);
    syncShellOffset(shell);

    loadAuthStatus().then((status) => {
      updateAccount(accountParts, status);
    }).catch(() => {
      updateAccount(accountParts, { authenticated: false, unavailable: true });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}());
