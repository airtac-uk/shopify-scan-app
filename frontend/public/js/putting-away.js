let loading = false;
let hidBuffer = '';
let hidLastKeyAt = 0;
let hidBufferTimeoutId = null;
let scannedItems = new Map();

function normalizeSku(value) {
  return String(value || '').trim().toUpperCase();
}

function focusSkuInput({ selectAll = false } = {}) {
  const input = document.getElementById('putAwaySkuInput');
  if (!input) return;
  input.focus();
  if (selectAll) {
    input.select();
  }
}

function setLoading(isLoading) {
  loading = isLoading;
  const spinner = document.getElementById('putAwaySpinner');
  const lookupButton = document.getElementById('putAwayLookupBtn');
  const clearButton = document.getElementById('putAwayClearBtn');

  if (spinner) spinner.style.display = loading ? 'inline-block' : 'none';
  if (lookupButton) lookupButton.disabled = loading;
  if (clearButton) clearButton.disabled = loading || scannedItems.size === 0;
}

function setStatus(message, type = 'info') {
  const status = document.getElementById('putAwayStatus');
  if (!status) return;
  status.textContent = message;
  status.dataset.type = type;
}

function updateSummary({ sheetFetchedAt = '', sheetSkuCount = null } = {}) {
  const summary = document.getElementById('putAwaySummary');
  const sheetStatus = document.getElementById('putAwaySheetStatus');
  if (!summary || !sheetStatus) return;

  const totalScans = Array.from(scannedItems.values())
    .reduce((sum, entry) => sum + (Number(entry.count) || 0), 0);
  const skuCount = scannedItems.size;

  summary.textContent = totalScans > 0
    ? `${totalScans} scanned / ${skuCount} SKUs`
    : 'Putting Away';

  if (sheetFetchedAt) {
    const fetchedDate = new Date(sheetFetchedAt);
    const fetchedLabel = Number.isNaN(fetchedDate.getTime())
      ? sheetFetchedAt
      : fetchedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    sheetStatus.textContent = `Sheet rows: ${sheetSkuCount ?? '-'} / ${fetchedLabel}`;
  } else {
    sheetStatus.textContent = skuCount > 0 ? `${skuCount} SKUs on list` : 'No SKUs scanned';
  }
}

function parsePickLocation(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return {
      raw: '',
      bay: '',
      tray: '',
      trayAlpha: '',
      trayNumber: '',
    };
  }

  const [bayPart, ...trayParts] = raw.split('-').map((part) => part.trim());
  const tray = trayParts.filter(Boolean).join('-');
  const [trayAlpha = '', trayNumber = ''] = tray.split('-');

  return {
    raw,
    bay: bayPart || raw,
    tray,
    trayAlpha,
    trayNumber,
  };
}

function createLocationPart(value, modifier) {
  const part = document.createElement('span');
  part.className = `pick-location-part pick-location-part--${modifier}`;

  const valueEl = document.createElement('span');
  valueEl.className = 'pick-location-value';
  valueEl.textContent = value;

  part.appendChild(valueEl);
  return part;
}

function renderLocation(rowLocation) {
  const location = document.createElement('div');
  location.className = 'pick-list-item-location put-away-location';

  const parsedLocation = parsePickLocation(rowLocation);
  if (!parsedLocation.raw) {
    location.textContent = '-';
    return location;
  }

  location.title = parsedLocation.raw;
  location.setAttribute('aria-label', parsedLocation.tray
    ? `Bay ${parsedLocation.bay}, tray ${parsedLocation.tray}`
    : `Location ${parsedLocation.raw}`);

  if (parsedLocation.bay && parsedLocation.tray) {
    location.appendChild(createLocationPart(parsedLocation.bay, 'bay'));
    location.appendChild(createLocationPart(parsedLocation.tray, 'tray'));
  } else {
    location.appendChild(createLocationPart(parsedLocation.raw, 'full'));
  }

  return location;
}

function createMetaPill(text, modifier = '') {
  const pill = document.createElement('span');
  pill.className = `put-away-pill${modifier ? ` put-away-pill--${modifier}` : ''}`;
  pill.textContent = text;
  return pill;
}

function renderComponentList(components) {
  const list = document.createElement('div');
  list.className = 'put-away-components';

  if (!Array.isArray(components) || components.length === 0) {
    return list;
  }

  const title = document.createElement('h3');
  title.textContent = 'Parts';
  list.appendChild(title);

  components.forEach((component) => {
    const item = document.createElement('div');
    item.className = `put-away-component${component.found ? '' : ' put-away-component--missing'}`;

    const sku = document.createElement('span');
    sku.className = 'put-away-component__sku';
    sku.textContent = component.sku || '(No SKU)';

    const locationWrap = document.createElement('div');
    locationWrap.appendChild(renderLocation(component.location));

    const meta = document.createElement('div');
    meta.className = 'put-away-component__meta';
    if (component.pickType) {
      meta.appendChild(createMetaPill(component.pickType));
    }
    if (component.note) {
      meta.appendChild(createMetaPill(component.note, 'note'));
    }
    if (!component.found) {
      meta.appendChild(createMetaPill('Not found', 'warn'));
    }

    item.appendChild(sku);
    item.appendChild(locationWrap);
    item.appendChild(meta);
    list.appendChild(item);
  });

  return list;
}

function renderScannedItems() {
  const container = document.getElementById('putAwayResults');
  if (!container) return;

  container.innerHTML = '';

  const entries = Array.from(scannedItems.values())
    .sort((left, right) => right.lastScannedAt - left.lastScannedAt);

  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'pick-list-empty put-away-empty';
    empty.textContent = 'Scan a SKU to show its put-away location.';
    container.appendChild(empty);
    updateSummary();
    setLoading(false);
    return;
  }

  entries.forEach((entry) => {
    const item = entry.item;
    const card = document.createElement('article');
    card.className = 'put-away-card';

    const header = document.createElement('header');
    header.className = 'put-away-card__header';

    const heading = document.createElement('div');
    heading.className = 'put-away-card__heading';

    const sku = document.createElement('h2');
    sku.textContent = item.sku;
    heading.appendChild(sku);

    const meta = document.createElement('div');
    meta.className = 'put-away-card__meta';
    if (item.pickType) {
      meta.appendChild(createMetaPill(item.pickType));
    }
    if (item.type) {
      meta.appendChild(createMetaPill(item.type));
    }
    if (item.hideOwnPickRow) {
      meta.appendChild(createMetaPill('Show-pick: No', 'warn'));
    }
    heading.appendChild(meta);

    const count = document.createElement('span');
    count.className = 'put-away-count';
    count.textContent = `x${entry.count}`;

    header.appendChild(heading);
    header.appendChild(count);

    const body = document.createElement('div');
    body.className = 'put-away-card__body';

    const locationPanel = document.createElement('section');
    locationPanel.className = 'put-away-panel';
    const locationTitle = document.createElement('p');
    locationTitle.className = 'put-away-panel__label';
    locationTitle.textContent = 'Location';
    locationPanel.appendChild(locationTitle);
    locationPanel.appendChild(renderLocation(item.location));

    const notePanel = document.createElement('section');
    notePanel.className = 'put-away-panel put-away-panel--note';
    const noteTitle = document.createElement('p');
    noteTitle.className = 'put-away-panel__label';
    noteTitle.textContent = 'Note';
    const note = document.createElement('p');
    note.className = 'put-away-note';
    note.textContent = item.note || '-';
    notePanel.appendChild(noteTitle);
    notePanel.appendChild(note);

    body.appendChild(locationPanel);
    body.appendChild(notePanel);

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(renderComponentList(item.components));
    container.appendChild(card);
  });

  updateSummary();
  setLoading(false);
}

function addScannedItem(item) {
  const sku = normalizeSku(item?.sku);
  if (!sku) return;

  const existing = scannedItems.get(sku);
  scannedItems.set(sku, {
    item,
    count: existing ? existing.count + 1 : 1,
    firstScannedAt: existing ? existing.firstScannedAt : Date.now(),
    lastScannedAt: Date.now(),
  });
}

async function lookupSku(rawSku) {
  const sku = normalizeSku(rawSku);
  if (!sku) {
    setStatus('Scan or enter a SKU.', 'error');
    focusSkuInput({ selectAll: true });
    return;
  }

  if (loading) return;

  setLoading(true);
  setStatus(`Looking up ${sku}...`, 'info');

  try {
    const response = await fetch('/api/put-away-sku', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to look up SKU');
    }

    addScannedItem(data.item);
    renderScannedItems();
    updateSummary({
      sheetFetchedAt: data.sheetFetchedAt,
      sheetSkuCount: data.sheetSkuCount,
    });
    setStatus(`${data.item.sku} ready to put away.`, 'success');

    const input = document.getElementById('putAwaySkuInput');
    if (input) input.value = '';
    focusSkuInput();
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    focusSkuInput({ selectAll: true });
  } finally {
    setLoading(false);
  }
}

function resetHidBuffer() {
  hidBuffer = '';
  hidLastKeyAt = 0;
  if (hidBufferTimeoutId) {
    clearTimeout(hidBufferTimeoutId);
    hidBufferTimeoutId = null;
  }
}

function setupHidScan() {
  const body = document.body;
  const hidEnabled = body?.dataset?.enableHidScan === 'true';
  if (!hidEnabled) return;

  const INTER_KEY_TIMEOUT_MS = 80;
  const BUFFER_RESET_MS = 200;
  const MIN_SCAN_LENGTH = 2;

  document.addEventListener('keydown', (event) => {
    if (loading) return;

    const target = event.target;
    const tagName = target?.tagName?.toLowerCase();
    if (tagName === 'input' || tagName === 'textarea' || target?.isContentEditable) {
      return;
    }

    const now = Date.now();
    if (hidLastKeyAt && now - hidLastKeyAt > INTER_KEY_TIMEOUT_MS) {
      resetHidBuffer();
    }
    hidLastKeyAt = now;

    if (event.key === 'Enter') {
      const scannedCode = hidBuffer.trim();
      resetHidBuffer();

      if (scannedCode.length >= MIN_SCAN_LENGTH) {
        lookupSku(scannedCode);
      }
      return;
    }

    if (event.key.length === 1) {
      hidBuffer += event.key;
    }

    if (hidBufferTimeoutId) {
      clearTimeout(hidBufferTimeoutId);
    }
    hidBufferTimeoutId = setTimeout(resetHidBuffer, BUFFER_RESET_MS);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const shopCookie = document.cookie.split('; ').find((c) => c.startsWith('shop='));
  if (!shopCookie) {
    window.location.href = '/';
    return;
  }

  const input = document.getElementById('putAwaySkuInput');
  const lookupButton = document.getElementById('putAwayLookupBtn');
  const clearButton = document.getElementById('putAwayClearBtn');

  if (lookupButton) {
    lookupButton.addEventListener('click', () => lookupSku(input?.value || ''));
  }

  if (clearButton) {
    clearButton.addEventListener('click', () => {
      scannedItems = new Map();
      renderScannedItems();
      setStatus('List cleared.', 'info');
      focusSkuInput({ selectAll: true });
    });
  }

  if (input) {
    input.addEventListener('focus', () => focusSkuInput({ selectAll: true }));
    input.addEventListener('click', () => focusSkuInput({ selectAll: true }));
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      lookupSku(input.value);
    });
  }

  renderScannedItems();
  setupHidScan();

  if (input && window.matchMedia('(min-width: 900px)').matches) {
    setTimeout(() => focusSkuInput({ selectAll: true }), 0);
  }
});
