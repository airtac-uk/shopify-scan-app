(() => {
  const THEME_STORAGE_KEY = 'airtac_theme_mode';
  const LIGHT = 'light';
  const DARK = 'dark';
  const HOTSPOT_SIZE_PX = 84;
  const TAP_WINDOW_MS = 2200;
  const TAP_TARGET_COUNT = 5;

  let tapCount = 0;
  let firstTapAt = 0;
  let toastTimeoutId = null;

  function loadTheme() {
    try {
      return localStorage.getItem(THEME_STORAGE_KEY) === LIGHT ? LIGHT : DARK;
    } catch (err) {
      return DARK;
    }
  }

  function saveTheme(theme) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (err) {
      // Ignore storage failures (private mode / blocked storage).
    }
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    root.classList.toggle('theme-light', theme === LIGHT);
    root.dataset.themeMode = theme;
  }

  function showToast(message) {
    const id = 'themeSecretToast';
    let toast = document.getElementById(id);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = id;
      toast.className = 'theme-secret-toast';
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.classList.add('is-visible');

    if (toastTimeoutId) {
      clearTimeout(toastTimeoutId);
    }
    toastTimeoutId = setTimeout(() => {
      toast.classList.remove('is-visible');
    }, 1600);
  }

  function toggleTheme() {
    const current = loadTheme();
    const next = current === LIGHT ? DARK : LIGHT;
    saveTheme(next);
    applyTheme(next);
    showToast(next === LIGHT ? 'Light Mode Enabled' : 'Dark Mode Enabled');
  }

  function resetTapState() {
    tapCount = 0;
    firstTapAt = 0;
  }

  function onSecretTap(x, y) {
    if (x > HOTSPOT_SIZE_PX || y > HOTSPOT_SIZE_PX) {
      resetTapState();
      return;
    }

    const now = Date.now();
    if (!firstTapAt || now - firstTapAt > TAP_WINDOW_MS) {
      firstTapAt = now;
      tapCount = 1;
      return;
    }

    tapCount += 1;
    if (tapCount >= TAP_TARGET_COUNT) {
      resetTapState();
      toggleTheme();
    }
  }

  function installGesture() {
    document.addEventListener('pointerdown', (event) => {
      onSecretTap(event.clientX, event.clientY);
    }, { passive: true });
  }

  applyTheme(loadTheme());

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installGesture);
  } else {
    installGesture();
  }
})();
