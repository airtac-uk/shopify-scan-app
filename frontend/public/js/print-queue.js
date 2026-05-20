const PRINT_QUEUE_POLL_MS = 30000;
const PRINT_CATALOG_RESULT_LIMIT = 80;
const PRINT_CATALOG_FEEDBACK_MS = 3500;

let printQueueStages = [
  { key: 'needs_printed', label: 'Needs Printed' },
  { key: 'in_build', label: 'In Build' },
  { key: 'pre_dye', label: 'Pre Dye' },
  { key: 'post_dye', label: 'Post Dye' },
  { key: 'complete', label: 'Complete' },
];
let printQueueItems = [];
let printCatalogItems = [];
let printCatalogAddedFeedback = new Map();
let printQueueLoading = false;
let printQueuePollId = null;
let draggedPrintItemId = '';

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

function formatTimestamp(value) {
  if (!value) return '-';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';

  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function setStatus(message, type = 'info') {
  const el = document.getElementById('printQueueStatus');
  if (!el) return;
  el.textContent = message || '';
  el.dataset.type = type;
}

function setLoading(isLoading) {
  printQueueLoading = Boolean(isLoading);
  const spinner = document.getElementById('printQueueSpinner');
  const refreshBtn = document.getElementById('printQueueRefreshBtn');
  const buildBtn = document.getElementById('printQueueBuildBtn');

  if (spinner) spinner.style.display = printQueueLoading ? 'inline-block' : 'none';
  if (refreshBtn) refreshBtn.disabled = printQueueLoading;
  if (buildBtn) buildBtn.disabled = printQueueLoading;
}

function updateLastUpdatedLabel() {
  const el = document.getElementById('printQueueLastUpdated');
  if (!el) return;
  el.textContent = `Last refreshed ${formatTimestamp(new Date().toISOString())}`;
}

function getStageLabel(stageKey) {
  return printQueueStages.find((stage) => stage.key === stageKey)?.label || stageKey;
}

function getItemLabel(item) {
  const sku = String(item?.sku || '').trim();
  return sku || String(item?.title || '').trim() || `Print item ${item?.id || ''}`;
}

function getPrintItemTotalQuantity(item) {
  const ownQuantity = Math.max(1, Number(item?.quantity) || 1);
  const childQuantity = (Array.isArray(item?.childItems) ? item.childItems : [])
    .reduce((sum, childItem) => sum + Math.max(1, Number(childItem?.quantity) || 1), 0);
  return ownQuantity + childQuantity;
}

function getPrintItemPartCount(item) {
  return 1 + (Array.isArray(item?.childItems) ? item.childItems.length : 0);
}

function formatPartQuantity(count) {
  const quantity = Math.max(0, Number(count) || 0);
  return `${quantity} ${quantity === 1 ? 'part' : 'parts'}`;
}

function formatJobQuantity(count) {
  const quantity = Math.max(0, Number(count) || 0);
  return `${quantity} ${quantity === 1 ? 'job' : 'jobs'}`;
}

function getCatalogLocationForSku(sku) {
  const normalizedSku = normalizeSearchText(sku);
  if (!normalizedSku) return '';

  const catalogItem = printCatalogItems.find((item) => normalizeSearchText(item?.sku) === normalizedSku);
  return String(catalogItem?.location || '').trim();
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

    const hasMatch = trimmedToken.match(/^has:(children|child|note|notes|rsq|queued)$/i);
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
        if (target === 'queued') {
          return getQueuedCatalogCount(item.sku) > 0;
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
    type: [item.typeRaw],
    pick: [item.pickType],
    location: [item.location],
    note: [item.note],
    title: [item.title],
  };

  if (field && fieldMap[field]) {
    return fieldMap[field];
  }

  return [
    item.sku,
    item.title,
    item.typeRaw,
    item.pickType,
    item.location,
    item.note,
    item.rsq ? `RSQ ${item.rsq}` : '',
    Number(item.eligibleComponentCount ?? item.componentCount ?? 0) > 0
      ? `CHILDREN ${item.eligibleComponentCount ?? item.componentCount}`
      : '',
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

function getQueuedCatalogCount(sku) {
  const normalizedSku = normalizeSearchText(sku);
  if (!normalizedSku) return 0;

  return printQueueItems.reduce((count, item) => {
    const ownMatch = normalizeSearchText(item?.sku) === normalizedSku ? 1 : 0;
    const childMatch = (Array.isArray(item?.childItems) ? item.childItems : [])
      .some((childItem) => normalizeSearchText(childItem?.sku) === normalizedSku)
      ? 1
      : 0;
    return count + ownMatch + childMatch;
  }, 0);
}

function getCatalogAddedFeedback(sku) {
  const normalizedSku = normalizeSearchText(sku);
  const feedback = printCatalogAddedFeedback.get(normalizedSku);
  if (!feedback) return null;

  if (Date.now() > Number(feedback.expiresAt || 0)) {
    printCatalogAddedFeedback.delete(normalizedSku);
    return null;
  }

  return feedback;
}

function setCatalogAddedFeedback(sku, { createdCount = 0, createdPartCount = 0 } = {}) {
  const normalizedSku = normalizeSearchText(sku);
  if (!normalizedSku) return;

  printCatalogAddedFeedback.set(normalizedSku, {
    createdCount: Math.max(0, Number(createdCount) || 0),
    createdPartCount: Math.max(0, Number(createdPartCount) || 0),
    expiresAt: Date.now() + PRINT_CATALOG_FEEDBACK_MS,
  });

  window.setTimeout(() => {
    const feedback = printCatalogAddedFeedback.get(normalizedSku);
    if (feedback && Date.now() >= Number(feedback.expiresAt || 0)) {
      printCatalogAddedFeedback.delete(normalizedSku);
      renderCatalog();
    }
  }, PRINT_CATALOG_FEEDBACK_MS + 50);
}

async function readJsonResponse(response, fallbackMessage) {
  let data = null;
  try {
    data = await response.json();
  } catch (err) {
    data = null;
  }

  if (!response.ok || !data?.success) {
    throw new Error(data?.error || fallbackMessage);
  }

  return data;
}

function renderOverview() {
  const container = document.getElementById('printQueueOverview');
  if (!container) return;

  const activeItems = printQueueItems.filter((item) => item.stageKey !== 'complete');
  const needsPrintedItems = printQueueItems.filter((item) => item.stageKey === 'needs_printed');
  const inBuildItems = printQueueItems.filter((item) => item.stageKey === 'in_build');
  const completeItems = printQueueItems.filter((item) => item.stageKey === 'complete');
  const sumQty = (items) => items.reduce((sum, item) => sum + getPrintItemTotalQuantity(item), 0);

  const stats = [
    {
      label: 'Needs Printed',
      value: formatPartQuantity(sumQty(needsPrintedItems)),
    },
    {
      label: 'In Build',
      value: formatPartQuantity(sumQty(inBuildItems)),
    },
    {
      label: 'Active Qty',
      value: formatPartQuantity(sumQty(activeItems)),
    },
    {
      label: 'Complete Shown',
      value: completeItems.length,
    },
  ];

  container.innerHTML = stats.map((stat) => `
    <article class="print-queue-stat">
      <p>${escapeHtml(stat.label)}</p>
      <strong>${escapeHtml(stat.value)}</strong>
    </article>
  `).join('');
}

function renderCatalog() {
  const container = document.getElementById('printCatalogList');
  if (!container) return;

  const searchInput = document.getElementById('printCatalogSearch');
  const search = String(searchInput?.value || '').trim();

  if (printCatalogItems.length === 0) {
    container.innerHTML = '<p class="pick-list-empty">No SLS or adapter SKUs found in the sheet.</p>';
    return;
  }

  if (!search) {
    container.innerHTML = `
      <div class="print-catalog-search-empty">
        <strong>${escapeHtml(printCatalogItems.length)} printable SKUs loaded</strong>
        <span>Search by SKU, type, title, location, note, RSQ, children, or queued state.</span>
      </div>
    `;
    return;
  }

  const parsedQuery = parseCatalogSearchQuery(search);
  const scoredItems = printCatalogItems
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
  const limitedItems = scoredItems.slice(0, PRINT_CATALOG_RESULT_LIMIT);
  const hiddenCount = Math.max(0, scoredItems.length - limitedItems.length);

  if (scoredItems.length === 0) {
    container.innerHTML = `
      <div class="print-catalog-search-empty">
        <strong>No matching printable SKUs</strong>
        <span>${escapeHtml(search)}</span>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="print-catalog-results-head">
      <strong>${escapeHtml(scoredItems.length)} matches</strong>
      ${hiddenCount > 0 ? `<span>Showing top ${escapeHtml(PRINT_CATALOG_RESULT_LIMIT)}</span>` : ''}
    </div>
    <div class="print-catalog-results">
      ${limitedItems.map(({ item }) => {
        const childCount = Number(item.eligibleComponentCount ?? item.componentCount ?? 0);
        const queuedCount = getQueuedCatalogCount(item.sku);
        const addedFeedback = getCatalogAddedFeedback(item.sku);
        const isRecentlyAdded = Boolean(addedFeedback);
        const addLabel = isRecentlyAdded ? '✓ Added' : 'Add';
        const addedCount = Number(addedFeedback?.createdPartCount || addedFeedback?.createdCount || 0);
        const addTitle = isRecentlyAdded
          ? `${addedCount} build parts added`
          : `Add ${item.sku} to print queue`;

        return `
          <article class="print-catalog-result${isRecentlyAdded ? ' is-added' : ''}">
            <div class="print-catalog-result__main">
              <div class="print-catalog-result__head">
                <div>
                  <h3>${escapeHtml(item.sku)}</h3>
                  ${item.title ? `<p>${escapeHtml(item.title)}</p>` : ''}
                </div>
                <button
                  type="button"
                  class="print-catalog-add-btn${isRecentlyAdded ? ' is-added' : ''}"
                  data-print-add-sku="${escapeHtmlAttribute(item.sku)}"
                  title="${escapeHtmlAttribute(addTitle)}"
                  ${isRecentlyAdded || printQueueLoading ? 'disabled' : ''}
                >
                  ${escapeHtml(addLabel)}
                </button>
              </div>
              <div class="print-catalog-result__meta">
                <span>${escapeHtml(item.typeRaw || 'UNKNOWN')}</span>
                ${item.rsq ? `<span>RSQ ${escapeHtml(item.rsq)}</span>` : ''}
                ${childCount > 0 ? `<span>${escapeHtml(childCount)} child${childCount === 1 ? '' : 'ren'}</span>` : ''}
                ${item.location ? `<span>${escapeHtml(item.location)}</span>` : ''}
                ${queuedCount > 0 ? `<span class="print-catalog-result__queued">In queue ${escapeHtml(queuedCount)}</span>` : ''}
                ${isRecentlyAdded ? `<span class="print-catalog-result__added">${escapeHtml(addedCount)} added</span>` : ''}
              </div>
            </div>
          </article>
        `;
      }).join('')}
    </div>
  `;
}

function renderQueueCard(item) {
  const isCustom = item.sourceType === 'custom';
  const isComplete = item.stageKey === 'complete';
  const rootSku = String(item.rootSku || '').trim();
  const sku = String(item.sku || '').trim();
  const childItems = Array.isArray(item.childItems) ? item.childItems : [];
  const locationLabel = String(item.location || getCatalogLocationForSku(item.sku)).trim();
  const quantityBadgeLabel = isComplete
    ? (locationLabel || 'No location')
    : `x${item.quantity}`;
  const quantityBadgeClass = isComplete
    ? 'print-queue-card__qty print-queue-card__qty--location'
    : 'print-queue-card__qty';
  const rootMeta = rootSku && rootSku !== sku
    ? `<span>Root ${escapeHtml(rootSku)}</span>`
    : '';
  const parentMeta = item.parentSku
    ? `<span>Parent ${escapeHtml(item.parentSku)}</span>`
    : '';
  const typeLabel = isCustom ? 'CUSTOM' : (item.typeRaw || 'UNKNOWN');
  const fileLink = isCustom && item.customFileUrl
    ? `<a class="print-queue-file-link" href="${escapeHtmlAttribute(item.customFileUrl)}" target="_blank" rel="noopener">Open File</a>`
    : '';
  const putAwayButton = isComplete
    ? `
        <button
          type="button"
          class="print-queue-put-away-btn"
          data-print-put-away-id="${escapeHtmlAttribute(item.id)}"
        >
          Put Away
        </button>
      `
    : '';
  const childRows = childItems.length > 0
    ? `
        <div class="print-queue-card__children">
          <div class="print-queue-card__children-head">
            <span>Build Parts</span>
            <strong>${escapeHtml(childItems.length + 1)}</strong>
          </div>
          <div class="print-queue-card__child-list">
            ${childItems.map((childItem) => {
              const childLocation = String(childItem.location || getCatalogLocationForSku(childItem.sku)).trim();
              const childRightLabel = isComplete
                ? (childLocation || '-')
                : `x${childItem.quantity}`;
              const childRightClass = isComplete
                ? 'print-queue-card__child-location'
                : 'print-queue-card__child-qty';
              return `
                <div class="print-queue-card__child">
                  <span class="print-queue-card__child-sku">${escapeHtml(childItem.sku)}</span>
                  <span class="print-queue-card__child-type">${escapeHtml(childItem.typeRaw || 'UNKNOWN')}</span>
                  <span class="${childRightClass}" title="${escapeHtmlAttribute(childRightLabel)}">${escapeHtml(childRightLabel)}</span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `
    : '';

  return `
    <article
      class="print-queue-card"
      draggable="true"
      data-print-item-id="${escapeHtmlAttribute(item.id)}"
      data-print-item-stage="${escapeHtmlAttribute(item.stageKey)}"
    >
      <div class="print-queue-card__head">
        <div>
          <h3>${escapeHtml(getItemLabel(item))}</h3>
          ${isCustom && item.customFileName ? `<p>${escapeHtml(item.customFileName)}</p>` : ''}
        </div>
        <span class="${quantityBadgeClass}" title="${escapeHtmlAttribute(quantityBadgeLabel)}">${escapeHtml(quantityBadgeLabel)}</span>
      </div>
      <div class="print-queue-card__meta">
        <span>${escapeHtml(typeLabel)}</span>
        ${item.rsq ? `<span>RSQ ${escapeHtml(item.rsq)}</span>` : ''}
        ${childItems.length > 0 ? `<span>${escapeHtml(childItems.length + 1)} parts</span>` : ''}
        ${rootMeta}
        ${parentMeta}
      </div>
      ${childRows}
      ${item.notes ? `<p class="print-queue-card__notes">${escapeHtml(item.notes)}</p>` : ''}
      <div class="print-queue-card__foot">
        <span>${escapeHtml(formatTimestamp(item.updatedAt || item.createdAt))}</span>
        ${fileLink}
        ${putAwayButton}
      </div>
    </article>
  `;
}

function renderBoard() {
  const container = document.getElementById('printQueueBoard');
  if (!container) return;

  const grouped = new Map(printQueueStages.map((stage) => [stage.key, []]));
  printQueueItems.forEach((item) => {
    const stageKey = grouped.has(item.stageKey) ? item.stageKey : 'needs_printed';
    grouped.get(stageKey).push(item);
  });

  container.innerHTML = printQueueStages.map((stage) => {
    const items = grouped.get(stage.key) || [];
    const quantity = items.reduce((sum, item) => sum + getPrintItemTotalQuantity(item), 0);
    const quantityLabel = formatPartQuantity(quantity);
    const jobLabel = formatJobQuantity(items.length);
    return `
      <section class="print-queue-column" data-print-drop-stage="${escapeHtmlAttribute(stage.key)}">
        <header class="print-queue-column__head">
          <h2>${escapeHtml(stage.label)}</h2>
          <span title="${escapeHtmlAttribute(jobLabel)}">${escapeHtml(quantityLabel)}</span>
        </header>
        <div class="print-queue-column__body">
          ${items.length
            ? items.map(renderQueueCard).join('')
            : '<p class="print-queue-empty">No jobs.</p>'}
        </div>
      </section>
    `;
  }).join('');
}

async function fetchPrintCatalog() {
  const response = await fetch('/api/print-catalog', {
    headers: { Accept: 'application/json' },
  });
  const data = await readJsonResponse(response, 'Failed to load print catalog');
  printCatalogItems = Array.isArray(data.items) ? data.items : [];

  const sheetStatus = document.getElementById('printCatalogSheetStatus');
  if (sheetStatus) {
    const fetchedAt = data.sheetFetchedAt ? formatTimestamp(data.sheetFetchedAt) : '-';
    sheetStatus.textContent = `Sheet rows: ${data.sheetSkuCount ?? '-'} / ${fetchedAt}`;
  }

  renderCatalog();
}

async function fetchPrintQueue({ silent = false, includeCatalog = false } = {}) {
  if (printQueueLoading) return;

  setLoading(true);
  if (!silent) setStatus('Loading print queue...', 'info');

  try {
    const queueResponse = await fetch('/api/print-queue', {
      headers: { Accept: 'application/json' },
    });
    const queueData = await readJsonResponse(queueResponse, 'Failed to load print queue');
    printQueueStages = Array.isArray(queueData.stages) && queueData.stages.length
      ? queueData.stages
      : printQueueStages;
    printQueueItems = Array.isArray(queueData.items) ? queueData.items : [];

    if (includeCatalog) {
      await fetchPrintCatalog();
    }

    renderOverview();
    renderBoard();
    renderCatalog();
    updateLastUpdatedLabel();
    setStatus(`Loaded ${printQueueItems.length} print jobs.`, 'success');
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    renderOverview();
    renderBoard();
  } finally {
    setLoading(false);
  }
}

async function addCatalogSkuToQueue(sku) {
  const normalizedSku = String(sku || '').trim().toUpperCase();
  if (!normalizedSku || printQueueLoading) return;

  setLoading(true);
  setStatus(`Adding ${normalizedSku}...`, 'info');

  try {
    const response = await fetch('/api/print-queue/catalog', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ sku: normalizedSku }),
    });
    const data = await readJsonResponse(response, 'Failed to add SKU to print queue');

    setCatalogAddedFeedback(normalizedSku, {
      createdCount: data.createdCount || 0,
      createdPartCount: data.createdPartCount || 0,
    });
    setLoading(false);
    renderCatalog();
    await fetchPrintQueue({ silent: true, includeCatalog: false });
    renderCatalog();
    const addedPartCount = Number(data.createdPartCount || data.createdCount || 0);
    setStatus(
      `Added ${data.createdCount || 0} build card with ${addedPartCount} ${addedPartCount === 1 ? 'part' : 'parts'} for ${normalizedSku}.`,
      'success'
    );
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    setLoading(false);
  }
}

async function addCustomPrintJob(event) {
  event.preventDefault();
  if (printQueueLoading) return;

  const titleInput = document.getElementById('printCustomTitle');
  const quantityInput = document.getElementById('printCustomQuantity');
  const fileUrlInput = document.getElementById('printCustomFileUrl');
  const notesInput = document.getElementById('printCustomNotes');
  const title = String(titleInput?.value || '').trim();
  const quantity = Math.max(1, Math.floor(Number(quantityInput?.value) || 1));
  const customFileUrl = String(fileUrlInput?.value || '').trim();
  const notes = String(notesInput?.value || '').trim();

  if (!title) {
    setStatus('Enter a custom file or job name.', 'error');
    return;
  }

  setLoading(true);
  setStatus(`Adding ${title}...`, 'info');

  try {
    const response = await fetch('/api/print-queue/custom', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        title,
        quantity,
        customFileName: title,
        customFileUrl,
        notes,
      }),
    });
    await readJsonResponse(response, 'Failed to add custom print job');

    if (titleInput) titleInput.value = '';
    if (quantityInput) quantityInput.value = '1';
    if (fileUrlInput) fileUrlInput.value = '';
    if (notesInput) notesInput.value = '';

    setLoading(false);
    await fetchPrintQueue({ silent: true, includeCatalog: false });
    setStatus(`Added custom job ${title}.`, 'success');
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    setLoading(false);
  }
}

async function movePrintItem(itemId, stageKey) {
  const normalizedId = Number(itemId);
  const normalizedStageKey = String(stageKey || '').trim();
  if (!Number.isInteger(normalizedId) || normalizedId <= 0 || !normalizedStageKey || printQueueLoading) {
    return;
  }

  setLoading(true);
  setStatus(`Moving job to ${getStageLabel(normalizedStageKey)}...`, 'info');

  try {
    const response = await fetch(`/api/print-queue/${encodeURIComponent(normalizedId)}/stage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ stageKey: normalizedStageKey }),
    });
    await readJsonResponse(response, 'Failed to move print job');

    setLoading(false);
    await fetchPrintQueue({ silent: true, includeCatalog: false });
    setStatus(`Moved job to ${getStageLabel(normalizedStageKey)}.`, 'success');
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    setLoading(false);
  }
}

async function putAwayPrintItem(itemId) {
  const normalizedId = Number(itemId);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0 || printQueueLoading) {
    return;
  }

  setLoading(true);
  setStatus('Putting print job away...', 'info');

  try {
    const response = await fetch(`/api/print-queue/${encodeURIComponent(normalizedId)}/put-away`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    await readJsonResponse(response, 'Failed to put away print job');

    setLoading(false);
    await fetchPrintQueue({ silent: true, includeCatalog: false });
    setStatus('Print job put away.', 'success');
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    setLoading(false);
  }
}

function formatPreformBuildSummary(data) {
  const manifest = data?.manifest || {};
  const preform = data?.preform || null;
  const missingFiles = Array.isArray(manifest.missingFiles) ? manifest.missingFiles : [];
  const skippedCustomItems = Array.isArray(manifest.skippedCustomItems) ? manifest.skippedCustomItems : [];
  const movedCount = Array.isArray(data?.movedItemIds) ? data.movedItemIds.length : 0;
  const issueCount = missingFiles.length + skippedCustomItems.length;
  const resolvedPartCount = Number(manifest.resolvedPartCount || 0);
  const modelInstanceCount = Number(manifest.modelInstanceCount || 0);

  if (preform?.formFilePath) {
    return [
      `Created PreForm build with ${modelInstanceCount} model ${modelInstanceCount === 1 ? 'instance' : 'instances'}.`,
      `File: ${preform.formFilePath}.`,
      movedCount > 0 ? `Moved ${movedCount} queue ${movedCount === 1 ? 'card' : 'cards'} to In Build.` : '',
    ].filter(Boolean).join(' ');
  }

  if (issueCount > 0) {
    const missingLabel = missingFiles.length > 0
      ? `Missing ${missingFiles.length} STL/3MF ${missingFiles.length === 1 ? 'file' : 'files'}`
      : '';
    const customLabel = skippedCustomItems.length > 0
      ? `${skippedCustomItems.length} custom ${skippedCustomItems.length === 1 ? 'job needs' : 'jobs need'} a Drive file link`
      : '';
    return [
      `Prepared a manifest with ${resolvedPartCount} resolved ${resolvedPartCount === 1 ? 'part' : 'parts'}.`,
      [missingLabel, customLabel].filter(Boolean).join('; '),
      `Manifest: ${data.manifestPath || manifest.buildDir || '-'}.`,
    ].filter(Boolean).join(' ');
  }

  return [
    `Prepared a build manifest with ${modelInstanceCount} model ${modelInstanceCount === 1 ? 'instance' : 'instances'}.`,
    data.manifestPath ? `Manifest: ${data.manifestPath}.` : '',
    'PreFormServer is not configured, so no .form file was created.',
  ].filter(Boolean).join(' ');
}

async function preparePreformBuild() {
  if (printQueueLoading) return;

  setLoading(true);
  setStatus('Preparing SLS build from Needs Printed...', 'info');

  try {
    const response = await fetch('/api/print-queue/preform-build', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ moveToInBuild: true }),
    });
    const data = await readJsonResponse(response, 'Failed to prepare SLS build');

    setLoading(false);
    await fetchPrintQueue({ silent: true, includeCatalog: false });
    const issueCount = Number(data?.manifest?.missingFiles?.length || 0)
      + Number(data?.manifest?.skippedCustomItems?.length || 0);
    setStatus(formatPreformBuildSummary(data), issueCount > 0 ? 'error' : 'success');
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    setLoading(false);
  }
}

function bindBoardEvents(board) {
  board.addEventListener('click', (event) => {
    const button = event.target instanceof Element
      ? event.target.closest('[data-print-put-away-id]')
      : null;
    if (!button) return;

    event.preventDefault();
    putAwayPrintItem(button.getAttribute('data-print-put-away-id'));
  });

  board.addEventListener('dragstart', (event) => {
    const card = event.target instanceof Element
      ? event.target.closest('.print-queue-card')
      : null;
    if (!card) return;

    draggedPrintItemId = String(card.getAttribute('data-print-item-id') || '');
    card.classList.add('is-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedPrintItemId);
    }
  });

  board.addEventListener('dragend', () => {
    draggedPrintItemId = '';
    board.querySelectorAll('.is-dragging, .is-drop-target').forEach((el) => {
      el.classList.remove('is-dragging', 'is-drop-target');
    });
  });

  board.addEventListener('dragover', (event) => {
    const column = event.target instanceof Element
      ? event.target.closest('[data-print-drop-stage]')
      : null;
    if (!column) return;

    event.preventDefault();
    column.classList.add('is-drop-target');
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  });

  board.addEventListener('dragleave', (event) => {
    const column = event.target instanceof Element
      ? event.target.closest('[data-print-drop-stage]')
      : null;
    if (
      !column
      || (event.relatedTarget instanceof Node && column.contains(event.relatedTarget))
    ) {
      return;
    }
    column.classList.remove('is-drop-target');
  });

  board.addEventListener('drop', (event) => {
    const column = event.target instanceof Element
      ? event.target.closest('[data-print-drop-stage]')
      : null;
    if (!column) return;

    event.preventDefault();
    column.classList.remove('is-drop-target');

    const itemId = event.dataTransfer?.getData('text/plain') || draggedPrintItemId;
    const stageKey = column.getAttribute('data-print-drop-stage');
    const item = printQueueItems.find((queueItem) => String(queueItem.id) === String(itemId));
    if (!item || item.stageKey === stageKey) return;

    movePrintItem(itemId, stageKey);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const refreshBtn = document.getElementById('printQueueRefreshBtn');
  const buildBtn = document.getElementById('printQueueBuildBtn');
  const catalogSearch = document.getElementById('printCatalogSearch');
  const catalogList = document.getElementById('printCatalogList');
  const customForm = document.getElementById('printCustomForm');
  const board = document.getElementById('printQueueBoard');

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      fetchPrintQueue({ includeCatalog: true });
    });
  }

  if (buildBtn) {
    buildBtn.addEventListener('click', preparePreformBuild);
  }

  if (catalogSearch) {
    catalogSearch.addEventListener('input', renderCatalog);
  }

  if (catalogList) {
    catalogList.addEventListener('click', (event) => {
      const button = event.target instanceof Element
        ? event.target.closest('[data-print-add-sku]')
        : null;
      if (!button) return;

      event.preventDefault();
      addCatalogSkuToQueue(button.getAttribute('data-print-add-sku'));
    });
  }

  if (customForm) {
    customForm.addEventListener('submit', addCustomPrintJob);
  }

  if (board) {
    bindBoardEvents(board);
  }

  fetchPrintQueue({ includeCatalog: true });

  if (printQueuePollId) {
    clearInterval(printQueuePollId);
  }

  printQueuePollId = setInterval(() => {
    fetchPrintQueue({ silent: true, includeCatalog: false });
  }, PRINT_QUEUE_POLL_MS);
});
