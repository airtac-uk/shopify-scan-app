const PART_EXPLORER_RESULT_LIMIT = 80;

let loading = false;
let partExplorerCatalogLoading = false;
let partExplorerCatalogItems = [];
let partExplorerSheetFetchedAt = '';
let partExplorerSheetSkuCount = null;
let hidBuffer = '';
let hidLastKeyAt = 0;
let hidBufferTimeoutId = null;
let scannedItems = new Map();

function normalizeSku(value) {
  return String(value || '').trim().toUpperCase();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value);
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
  renderPartExplorerCatalog();
}

function setStatus(message, type = 'info') {
  const status = document.getElementById('putAwayStatus');
  if (!status) return;
  status.textContent = message;
  status.dataset.type = type;
}

function updateSummary({ sheetFetchedAt, sheetSkuCount } = {}) {
  if (sheetFetchedAt !== undefined) {
    partExplorerSheetFetchedAt = sheetFetchedAt || '';
  }
  if (sheetSkuCount !== undefined) {
    partExplorerSheetSkuCount = sheetSkuCount ?? null;
  }

  const summary = document.getElementById('putAwaySummary');
  const sheetStatus = document.getElementById('putAwaySheetStatus');
  if (!summary || !sheetStatus) return;

  const currentEntry = Array.from(scannedItems.values())[0] || null;
  const currentSku = normalizeSku(currentEntry?.item?.sku);

  summary.textContent = currentSku
    ? `Viewing ${currentSku}`
    : 'Part Explorer';

  if (partExplorerSheetFetchedAt) {
    const fetchedDate = new Date(partExplorerSheetFetchedAt);
    const fetchedLabel = Number.isNaN(fetchedDate.getTime())
      ? partExplorerSheetFetchedAt
      : fetchedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    sheetStatus.textContent = `Sheet rows: ${partExplorerSheetSkuCount ?? '-'} / ${fetchedLabel}`;
  } else if (partExplorerSheetSkuCount !== null) {
    sheetStatus.textContent = `Sheet rows: ${partExplorerSheetSkuCount}`;
  } else {
    sheetStatus.textContent = currentSku ? 'SKU selected' : 'No SKU selected';
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

function normalizeSearchText(value) {
  return String(value || '').trim().toUpperCase();
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(/[^A-Z0-9]/g, '');
}

function splitSearchQuery(value) {
  const tokens = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  let match = pattern.exec(String(value || ''));

  while (match) {
    const token = String(match[1] || match[2] || '').trim();
    if (token) tokens.push(token);
    match = pattern.exec(String(value || ''));
  }

  return tokens;
}

function parseComparatorToken(token, fieldName) {
  const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escapedFieldName}(>=|<=|>|<|=|:)(\\d+)$`, 'i');
  const match = String(token || '').match(regex);
  if (!match) return null;

  return {
    field: fieldName,
    operator: match[1] === ':' ? '=' : match[1],
    value: Number(match[2]),
  };
}

function compareNumber(actualValue, operator, expectedValue) {
  const actual = Number(actualValue) || 0;
  const expected = Number(expectedValue) || 0;

  if (operator === '>') return actual > expected;
  if (operator === '>=') return actual >= expected;
  if (operator === '<') return actual < expected;
  if (operator === '<=') return actual <= expected;
  return actual === expected;
}

function parseCatalogSearchQuery(query) {
  const parsed = {
    terms: [],
    filters: [],
  };

  splitSearchQuery(query).forEach((token) => {
    const trimmedToken = String(token || '').trim();
    const normalizedToken = normalizeSearchText(trimmedToken);
    if (!trimmedToken) return;

    const numericFilter = parseComparatorToken(trimmedToken, 'rsq')
      || parseComparatorToken(trimmedToken, 'children');
    if (numericFilter) {
      parsed.filters.push((item) => {
        const value = numericFilter.field === 'rsq'
          ? item.rsq
          : (item.eligibleComponentCount ?? item.componentCount ?? 0);
        return compareNumber(value, numericFilter.operator, numericFilter.value);
      });
      return;
    }

    const fieldMatch = trimmedToken.match(/^(sku|type|pick|location|loc|note|title):(.+)$/i);
    if (fieldMatch) {
      const rawField = fieldMatch[1].toLowerCase();
      const field = rawField === 'loc' ? 'location' : rawField;
      parsed.terms.push({
        field,
        value: fieldMatch[2],
        compactValue: compactSearchText(fieldMatch[2]),
      });
      return;
    }

    const hasMatch = trimmedToken.match(/^has:(children|child|note|notes|rsq)$/i);
    if (hasMatch) {
      const target = hasMatch[1].toLowerCase();
      parsed.filters.push((item) => {
        if (target === 'children' || target === 'child') {
          return Number(item.eligibleComponentCount ?? item.componentCount ?? 0) > 0;
        }
        if (target === 'note' || target === 'notes') {
          return Boolean(String(item.note || '').trim());
        }
        if (target === 'rsq') {
          return Number(item.rsq || 0) > 0;
        }
        return true;
      });
      return;
    }

    const bareType = normalizedToken === 'SLS' || normalizedToken === 'ADAPTER';
    if (bareType) {
      parsed.filters.push((item) => normalizeSearchText(item.typeRaw).includes(normalizedToken));
      return;
    }

    parsed.terms.push({
      field: '',
      value: trimmedToken,
      compactValue: compactSearchText(trimmedToken),
    });
  });

  return parsed;
}

function isSubsequence(needle, haystack) {
  if (!needle || !haystack || needle.length > haystack.length) return false;

  let needleIndex = 0;
  for (let i = 0; i < haystack.length && needleIndex < needle.length; i += 1) {
    if (haystack[i] === needle[needleIndex]) {
      needleIndex += 1;
    }
  }

  return needleIndex === needle.length;
}

function scoreValueForTerm(rawValue, term) {
  const normalizedValue = normalizeSearchText(rawValue);
  const compactValue = compactSearchText(rawValue);
  const normalizedTerm = normalizeSearchText(term.value);
  const compactTerm = term.compactValue || compactSearchText(term.value);

  if (!normalizedTerm && !compactTerm) return 0;
  if (normalizedValue === normalizedTerm || compactValue === compactTerm) return 240;
  if (normalizedValue.startsWith(normalizedTerm) || compactValue.startsWith(compactTerm)) return 170;
  if (normalizedValue.includes(normalizedTerm) || compactValue.includes(compactTerm)) return 115;

  const wordPrefixMatch = normalizedValue
    .split(/[^A-Z0-9]+/)
    .some((word) => word.startsWith(normalizedTerm));
  if (wordPrefixMatch) return 90;

  if (compactTerm.length >= 3 && isSubsequence(compactTerm, compactValue)) {
    return 42;
  }

  return 0;
}

function getCatalogSearchValues(item, field) {
  const fieldMap = {
    sku: [item.sku],
    type: [item.typeRaw, item.type],
    pick: [item.pickType],
    location: [item.location],
    note: [item.note],
    title: [item.title],
  };

  if (field && fieldMap[field]) {
    return fieldMap[field];
  }

  const children = Number(item.eligibleComponentCount ?? item.componentCount ?? 0);
  return [
    item.sku,
    item.title,
    item.typeRaw,
    item.type,
    item.pickType,
    item.location,
    item.note,
    item.rsq ? `RSQ ${item.rsq}` : '',
    children > 0 ? `CHILDREN ${children}` : '',
  ];
}

function scoreCatalogItem(item, parsedQuery) {
  if (!parsedQuery.filters.every((filter) => filter(item))) return 0;

  let score = 0;
  const rsq = Number(item.rsq || 0);
  const children = Number(item.eligibleComponentCount ?? item.componentCount ?? 0);

  if (parsedQuery.terms.length === 0) {
    return 1 + Math.min(rsq, 20) + Math.min(children * 4, 24);
  }

  for (const term of parsedQuery.terms) {
    const termScore = Math.max(
      ...getCatalogSearchValues(item, term.field).map((value) => scoreValueForTerm(value, term))
    );
    if (termScore <= 0) return 0;
    score += termScore;
  }

  return score + Math.min(rsq, 20) + Math.min(children * 4, 24);
}

function getPartExplorerScoredItems(search) {
  const parsedQuery = parseCatalogSearchQuery(search);

  return partExplorerCatalogItems
    .map((item) => ({
      item,
      score: scoreCatalogItem(item, parsedQuery),
    }))
    .filter((result) => result.score > 0)
    .sort((left, right) => {
      const scoreDiff = right.score - left.score;
      if (scoreDiff !== 0) return scoreDiff;

      const typeDiff = String(left.item.typeRaw || '').localeCompare(String(right.item.typeRaw || ''));
      if (typeDiff !== 0) return typeDiff;

      return String(left.item.sku || '').localeCompare(String(right.item.sku || ''));
    });
}

function resolvePartExplorerLookupSku(rawValue) {
  const search = String(rawValue || '').trim();
  if (!search) return '';

  const normalizedSearch = normalizeSearchText(search);
  const exactCatalogItem = partExplorerCatalogItems.find(
    (item) => normalizeSearchText(item?.sku) === normalizedSearch
  );
  if (exactCatalogItem?.sku) return exactCatalogItem.sku;

  const bestMatch = getPartExplorerScoredItems(search)[0]?.item?.sku;
  return bestMatch || search;
}

function renderPartExplorerCatalog() {
  const container = document.getElementById('partExplorerCatalogList');
  if (!container) return;

  const searchInput = document.getElementById('putAwaySkuInput');
  const search = String(searchInput?.value || '').trim();

  if (!search) {
    container.innerHTML = '';
    return;
  }

  if (partExplorerCatalogLoading && partExplorerCatalogItems.length === 0) {
    container.innerHTML = `
      <div class="print-catalog-search-empty">
        <strong>Loading Part Explorer catalog</strong>
        <span>${escapeHtml(search)}</span>
      </div>
    `;
    return;
  }

  if (partExplorerCatalogItems.length === 0) {
    container.innerHTML = `
      <div class="print-catalog-search-empty">
        <strong>No catalog SKUs loaded</strong>
        <span>${escapeHtml(search)}</span>
      </div>
    `;
    return;
  }

  const scoredItems = getPartExplorerScoredItems(search);
  const limitedItems = scoredItems.slice(0, PART_EXPLORER_RESULT_LIMIT);
  const hiddenCount = Math.max(0, scoredItems.length - limitedItems.length);

  if (scoredItems.length === 0) {
    container.innerHTML = `
      <div class="print-catalog-search-empty">
        <strong>No matching SKUs</strong>
        <span>${escapeHtml(search)}</span>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="print-catalog-results-head">
      <strong>${escapeHtml(scoredItems.length)} matches</strong>
      ${hiddenCount > 0 ? `<span>Showing top ${escapeHtml(PART_EXPLORER_RESULT_LIMIT)}</span>` : ''}
    </div>
    <div class="print-catalog-results">
      ${limitedItems.map(({ item }) => {
        const childCount = Number(item.eligibleComponentCount ?? item.componentCount ?? 0);
        const typeLabel = String(item.typeRaw || item.type || item.pickType || 'UNKNOWN').trim();
        const pickLabel = String(item.pickType || '').trim();
        const showPickLabel = item.hideOwnPickRow ? '<span>Show-pick: No</span>' : '';
        const isSelected = scannedItems.has(normalizeSku(item.sku));

        return `
          <button
            type="button"
            class="print-catalog-result part-explorer-result-btn${isSelected ? ' is-selected' : ''}"
            data-part-explorer-open-sku="${escapeHtmlAttribute(item.sku)}"
            title="Open ${escapeHtmlAttribute(item.sku)}"
            ${loading ? 'disabled' : ''}
          >
            <span class="print-catalog-result__main">
              <span class="print-catalog-result__head">
                <span>
                  <span class="part-explorer-result__sku">${escapeHtml(item.sku)}</span>
                  ${item.title ? `<span class="part-explorer-result__title">${escapeHtml(item.title)}</span>` : ''}
                </span>
              </span>
              <span class="print-catalog-result__meta">
                <span>${escapeHtml(typeLabel)}</span>
                ${pickLabel && pickLabel !== typeLabel ? `<span>${escapeHtml(pickLabel)}</span>` : ''}
                ${item.rsq ? `<span>RSQ ${escapeHtml(item.rsq)}</span>` : ''}
                ${childCount > 0 ? `<span>${escapeHtml(childCount)} child${childCount === 1 ? '' : 'ren'}</span>` : ''}
                ${item.location ? `<span>${escapeHtml(item.location)}</span>` : ''}
                ${showPickLabel}
              </span>
              ${item.note ? `<span class="print-catalog-result__note">${escapeHtml(item.note)}</span>` : ''}
            </span>
          </button>
        `;
      }).join('')}
    </div>
  `;
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
    empty.textContent = 'Search or scan a SKU to show its location and parts.';
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

    header.appendChild(heading);

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

  scannedItems = new Map();
  scannedItems.set(sku, {
    item,
    count: 1,
    firstScannedAt: Date.now(),
    lastScannedAt: Date.now(),
  });
}

async function readJsonResponse(response, fallbackMessage) {
  let data = null;
  try {
    data = await response.json();
  } catch (err) {
    data = null;
  }

  if (!response.ok || !data?.success) {
    const error = new Error(data?.error || fallbackMessage);
    error.data = data;
    throw error;
  }

  return data;
}

async function fetchPartExplorerCatalog() {
  if (partExplorerCatalogLoading) return;

  partExplorerCatalogLoading = true;
  renderPartExplorerCatalog();
  if (!loading) {
    setStatus('Loading Part Explorer catalog...', 'info');
  }

  try {
    const response = await fetch('/api/part-explorer-catalog', {
      headers: { Accept: 'application/json' },
    });
    const data = await readJsonResponse(response, 'Failed to load Part Explorer catalog');
    partExplorerCatalogItems = Array.isArray(data.items) ? data.items : [];
    updateSummary({
      sheetFetchedAt: data.sheetFetchedAt,
      sheetSkuCount: data.sheetSkuCount,
    });
    renderPartExplorerCatalog();
    if (!loading) {
      setStatus(`${partExplorerCatalogItems.length} SKUs loaded.`, 'success');
    }
  } catch (err) {
    if (!loading) {
      setStatus(`Search unavailable: ${err.message}`, 'error');
    }
    renderPartExplorerCatalog();
  } finally {
    partExplorerCatalogLoading = false;
    renderPartExplorerCatalog();
  }
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

    const data = await readJsonResponse(response, 'Failed to look up SKU');

    addScannedItem(data.item);
    renderScannedItems();
    updateSummary({
      sheetFetchedAt: data.sheetFetchedAt,
      sheetSkuCount: data.sheetSkuCount,
    });
    setStatus(`${data.item.sku} loaded in Part Explorer.`, 'success');

    renderPartExplorerCatalog();
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
  const catalogList = document.getElementById('partExplorerCatalogList');

  if (lookupButton) {
    lookupButton.addEventListener('click', () => lookupSku(resolvePartExplorerLookupSku(input?.value || '')));
  }

  if (clearButton) {
    clearButton.addEventListener('click', () => {
      scannedItems = new Map();
      renderScannedItems();
      setStatus('Selection cleared.', 'info');
      focusSkuInput({ selectAll: true });
    });
  }

  if (input) {
    input.addEventListener('focus', () => focusSkuInput({ selectAll: true }));
    input.addEventListener('click', () => focusSkuInput({ selectAll: true }));
    input.addEventListener('input', renderPartExplorerCatalog);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        input.value = '';
        renderPartExplorerCatalog();
        return;
      }

      if (event.key !== 'Enter') return;
      event.preventDefault();
      lookupSku(resolvePartExplorerLookupSku(input.value));
    });
  }

  if (catalogList) {
    catalogList.addEventListener('click', (event) => {
      const target = event.target;
      const button = target instanceof Element
        ? target.closest('[data-part-explorer-open-sku]')
        : null;
      if (!button || loading) return;

      lookupSku(button.getAttribute('data-part-explorer-open-sku') || '');
    });
  }

  renderScannedItems();
  fetchPartExplorerCatalog();
  setupHidScan();

  if (input && window.matchMedia('(min-width: 900px)').matches) {
    setTimeout(() => focusSkuInput({ selectAll: true }), 0);
  }
});
