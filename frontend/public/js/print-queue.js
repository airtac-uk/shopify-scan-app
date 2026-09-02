const PRINT_QUEUE_POLL_MS = 30000;
const PRINT_CATALOG_RESULT_LIMIT = 80;
const PRINT_CATALOG_FEEDBACK_MS = 3500;
const STL_PREVIEW_CACHE_LIMIT = 24;
const PREFORM_DOWNLOAD_ACTIONS_STORAGE_KEY = 'printQueue.latestPreformDownloadActions';
const PRINT_QUEUE_CONFIGS = {
  sls: {
    key: 'sls',
    label: 'Print Queue',
    shortLabel: 'SLS / Adapter',
    emptyCatalogLabel: 'No SLS or adapter SKUs found in the sheet.',
    supportsPreformBuild: true,
  },
  fdm: {
    key: 'fdm',
    label: 'FDM Print Queue',
    shortLabel: 'FDM',
    emptyCatalogLabel: 'No FDM SKUs found in the sheet.',
    supportsPreformBuild: false,
  },
};

const PRINT_QUEUE_KEY = (() => {
  const raw = String(document.body?.dataset?.printQueueKey || 'sls').trim().toLowerCase();
  return raw === 'fdm' ? 'fdm' : 'sls';
})();
const PRINT_QUEUE_CONFIG = PRINT_QUEUE_CONFIGS[PRINT_QUEUE_KEY] || PRINT_QUEUE_CONFIGS.sls;

const PRINT_QUEUE_STAGE_CONFIGS = {
  sls: [
    { key: 'needs_printed', label: 'Needs Printed' },
    { key: 'in_build', label: 'In Build' },
    { key: 'pre_dye', label: 'Pre Dye' },
    { key: 'post_dye', label: 'Post Dye' },
    { key: 'complete', label: 'Complete' },
  ],
  fdm: [
    { key: 'needs_printed', label: 'Needs Printed' },
    { key: 'in_build', label: 'Printing' },
    { key: 'complete', label: 'Complete' },
  ],
};

let printQueueStages = PRINT_QUEUE_STAGE_CONFIGS[PRINT_QUEUE_KEY] || [
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
let pendingPrintDeleteItemId = '';
let expandedPrintChildItemIds = new Set();
let activePutAwayItemId = '';
let printQueueDiscoEnabled = false;
let printQueueDiscoPressTimerId = null;
let printQueueDiscoPressPointerId = null;
let printQueueDiscoPressStart = null;
let stlPreviewModelCache = new Map();
let activeStlPreviewRenderers = [];
let stlPreviewLibraryPromise = null;
let stlPreviewRenderSession = 0;
let latestPreformBuildDownloadActions = loadLatestPreformBuildDownloadActions();

function withQueueParam(pathname) {
  const url = new URL(pathname, window.location.origin);
  url.searchParams.set('queue', PRINT_QUEUE_KEY);
  return `${url.pathname}${url.search}`;
}

function loadLatestPreformBuildDownloadActions() {
  try {
    const raw = window.localStorage?.getItem(PREFORM_DOWNLOAD_ACTIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function saveLatestPreformBuildDownloadActions(actions) {
  latestPreformBuildDownloadActions = Array.isArray(actions) ? actions : [];
  try {
    window.localStorage?.setItem(
      PREFORM_DOWNLOAD_ACTIONS_STORAGE_KEY,
      JSON.stringify(latestPreformBuildDownloadActions)
    );
  } catch (err) {
    // The links still stay visible for this page session if localStorage is unavailable.
  }
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

function renderStatusAction(action) {
  const href = String(action?.href || '').trim();
  const label = String(action?.label || '').trim();
  if (!href || !label) return '';

  return `
    <a
      class="print-queue-status-action"
      href="${escapeHtmlAttribute(href)}"
      target="_blank"
      rel="noopener"
    >
      ${escapeHtml(label)}
    </a>
  `;
}

function mergeStatusActions(actions = []) {
  const merged = [];
  const seen = new Set();
  [...actions, ...latestPreformBuildDownloadActions].forEach((action) => {
    const href = String(action?.href || '').trim();
    const label = String(action?.label || '').trim();
    if (!href || !label) return;

    const key = `${href}|${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push({ href, label });
  });
  return merged;
}

function setStatus(message, type = 'info', actions = []) {
  const el = document.getElementById('printQueueStatus');
  if (el) {
    el.textContent = message || '';
    el.dataset.type = type;
  }

  const actionsEl = document.getElementById('printQueueStatusActions');
  if (actionsEl) {
    const normalizedActions = mergeStatusActions(Array.isArray(actions) ? actions : []);
    actionsEl.innerHTML = normalizedActions.map(renderStatusAction).filter(Boolean).join('');
  }
}

function patchWebGlPrecisionFormat(context) {
  if (!context || typeof context.getShaderPrecisionFormat !== 'function') return context;

  const originalGetShaderPrecisionFormat = context.getShaderPrecisionFormat.bind(context);
  const patchedGetShaderPrecisionFormat = (shaderType, precisionType) => (
    originalGetShaderPrecisionFormat(shaderType, precisionType) || {
      rangeMin: 127,
      rangeMax: 127,
      precision: 23,
    }
  );
  try {
    context.getShaderPrecisionFormat = patchedGetShaderPrecisionFormat;
    if (!context.getShaderPrecisionFormat(context.VERTEX_SHADER, context.HIGH_FLOAT)) {
      Object.defineProperty(context, 'getShaderPrecisionFormat', {
        value: patchedGetShaderPrecisionFormat,
      });
    }
  } catch (err) {
    return context;
  }

  return context;
}

function createSafeWebGlRenderer(THREE, canvas, options = {}) {
  const contextAttributes = {
    antialias: Boolean(options.antialias),
    alpha: Boolean(options.alpha),
    powerPreference: options.powerPreference || 'high-performance',
  };
  const context = patchWebGlPrecisionFormat(
    canvas.getContext('webgl2', contextAttributes)
      || canvas.getContext('webgl', contextAttributes)
      || canvas.getContext('experimental-webgl', contextAttributes)
  );
  if (!context) {
    throw new Error('WebGL is not available in this browser.');
  }

  return new THREE.WebGLRenderer({
    ...options,
    canvas,
    context,
    precision: options.precision || 'mediump',
  });
}

function setLoading(isLoading) {
  printQueueLoading = Boolean(isLoading);
  const spinner = document.getElementById('printQueueSpinner');
  const refreshBtn = document.getElementById('printQueueRefreshBtn');
  const buildBtn = document.getElementById('printQueueBuildBtn');

  if (spinner) spinner.style.display = printQueueLoading ? 'inline-block' : 'none';
  if (refreshBtn) refreshBtn.disabled = printQueueLoading;
  if (buildBtn) buildBtn.disabled = printQueueLoading || !PRINT_QUEUE_CONFIG.supportsPreformBuild;
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

function getAwaitingPartsQuantity(item, matches = []) {
  const payloadQuantity = Number(item?.awaitingPartsQuantity);
  if (Number.isFinite(payloadQuantity) && payloadQuantity > 0) {
    return Math.max(0, payloadQuantity);
  }

  return (Array.isArray(matches) ? matches : []).reduce((sum, match) => {
    const matchQuantity = Number(match?.totalQuantity);
    if (Number.isFinite(matchQuantity) && matchQuantity > 0) {
      return sum + matchQuantity;
    }

    const orderQuantity = (Array.isArray(match?.orders) ? match.orders : [])
      .reduce((orderSum, order) => {
        const quantity = Number(order?.quantity);
        return orderSum + (Number.isFinite(quantity) && quantity > 0 ? quantity : 1);
      }, 0);
    return sum + orderQuantity;
  }, 0);
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

function renderStlDownloadLink(sku, label = 'STL') {
  const normalizedSku = String(sku || '').trim().toUpperCase();
  if (!normalizedSku) return '';
  const linkLabel = label === 'STL' && PRINT_QUEUE_KEY === 'fdm' ? 'File' : label;

  return `
    <a
      class="print-queue-stl-link"
      href="/api/print-queue/stl/${encodeURIComponent(normalizedSku)}/download"
      target="_blank"
      rel="noopener"
      draggable="false"
      title="Download ${escapeHtmlAttribute(normalizedSku)} STL/3MF from Google Drive"
    >${escapeHtml(linkLabel)}</a>
  `;
}

function renderQcPdfLink(sku, label = 'QC PDF') {
  const normalizedSku = String(sku || '').trim().toUpperCase();
  if (!normalizedSku) return '';

  return `
    <a
      class="print-queue-qc-link"
      href="/api/print-queue/qc/${encodeURIComponent(normalizedSku)}/pdf"
      target="_blank"
      rel="noopener"
      draggable="false"
      title="Open ${escapeHtmlAttribute(normalizedSku)} QC PDF from Google Drive"
    >${escapeHtml(label)}</a>
  `;
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

    const bareType = normalizedToken === 'SLS' || normalizedToken === 'ADAPTER' || normalizedToken === 'FDM';
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

function getCatalogDefaultQuantity(item) {
  const value = Number(item?.defaultQuantity || item?.rsq || 1);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function promptCatalogPrintQuantity(item) {
  const sku = String(item?.sku || '').trim().toUpperCase();
  const defaultQuantity = getCatalogDefaultQuantity(item);
  const rsq = Math.max(0, Math.floor(Number(item?.rsq) || 0));
  const rawValue = window.prompt(
    [`Quantity to add for ${sku}`, rsq > 0 ? `RSQ: ${rsq}` : 'RSQ: not set'].join('\n'),
    String(defaultQuantity)
  );
  if (rawValue === null) return null;

  const quantity = Math.floor(Number(rawValue));
  if (!Number.isFinite(quantity) || quantity <= 0) {
    setStatus('Enter a positive whole-number print quantity.', 'error');
    return null;
  }

  return quantity;
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

function getPrintPartLocation(sku, explicitLocation) {
  return String(explicitLocation || getCatalogLocationForSku(sku)).trim();
}

function getPutAwayPartsForItem(item) {
  const isCustom = item?.sourceType === 'custom';
  const childItems = Array.isArray(item?.childItems) ? item.childItems : [];

  if (isCustom) {
    return [{
      key: `${item.id}:custom`,
      role: 'Custom',
      sku: '',
      title: String(item.customFileName || item.title || 'Custom print file').trim(),
      typeRaw: 'CUSTOM',
      quantity: Math.max(1, Number(item.quantity) || 1),
      location: String(item.location || '').trim(),
      customFileUrl: String(item.customFileUrl || '').trim(),
    }];
  }

  const parts = [];
  const parentSku = String(item?.sku || '').trim();
  if (parentSku) {
    parts.push({
      key: `${item.id}:parent`,
      role: 'Parent',
      sku: parentSku,
      title: String(item.title || parentSku).trim(),
      typeRaw: String(item.typeRaw || 'UNKNOWN').trim().toUpperCase(),
      quantity: Math.max(1, Number(item.quantity) || 1),
      location: getPrintPartLocation(parentSku, item.location),
      customFileUrl: '',
    });
  }

  childItems.forEach((childItem, index) => {
    const childSku = String(childItem?.sku || '').trim();
    if (!childSku) return;
    parts.push({
      key: `${item.id}:child:${index}`,
      role: 'Sub SKU',
      sku: childSku,
      title: String(childItem.title || childSku).trim(),
      typeRaw: String(childItem.typeRaw || 'UNKNOWN').trim().toUpperCase(),
      quantity: Math.max(1, Number(childItem.quantity) || 1),
      location: getPrintPartLocation(childSku, childItem.location),
      customFileUrl: '',
    });
  });

  return parts;
}

function renderPutAwayPart(part, index) {
  const locationLabel = part.location || 'No location';
  const skuLabel = part.sku || part.title;
  const preview = part.sku
    ? `
        <div class="print-stl-preview" data-stl-preview-sku="${escapeHtmlAttribute(part.sku)}">
          <canvas class="print-stl-preview__canvas" aria-label="STL preview for ${escapeHtmlAttribute(part.sku)}"></canvas>
          <p class="print-stl-preview__status">Loading STL preview...</p>
        </div>
      `
    : `
        <div class="print-stl-preview print-stl-preview--empty">
          <p class="print-stl-preview__status">No STL preview for custom files.</p>
        </div>
      `;
  const fileLink = part.customFileUrl
    ? `<a class="print-queue-file-link" href="${escapeHtmlAttribute(part.customFileUrl)}" target="_blank" rel="noopener">Open File</a>`
    : '';
  const stlLink = part.sku ? renderStlDownloadLink(part.sku, PRINT_QUEUE_KEY === 'fdm' ? 'Download File' : 'Download STL') : '';

  return `
    <article class="print-put-away-part">
      <div class="print-put-away-part__body">
        <div class="print-put-away-part__details">
          <p class="print-put-away-part__index">${escapeHtml(index + 1)}</p>
          <div>
            <h4>${escapeHtml(skuLabel)}</h4>
            ${part.title && part.title !== skuLabel ? `<p>${escapeHtml(part.title)}</p>` : ''}
            <div class="print-put-away-part__meta">
              <span>${escapeHtml(part.role)}</span>
              <span>${escapeHtml(part.typeRaw || 'UNKNOWN')}</span>
              <span>x${escapeHtml(part.quantity)}</span>
            </div>
          </div>
        </div>
        <div class="print-put-away-part__location">
          <span>Location</span>
          <strong>${escapeHtml(locationLabel)}</strong>
        </div>
        <div class="print-put-away-part__links">
          ${fileLink}
          ${stlLink}
        </div>
      </div>
      ${preview}
    </article>
  `;
}

function destroyActiveStlPreviewRenderers() {
  stlPreviewRenderSession += 1;
  activeStlPreviewRenderers.forEach((renderer) => {
    if (renderer && typeof renderer.destroy === 'function') {
      renderer.destroy();
    }
  });
  activeStlPreviewRenderers = [];
}

function isZipLikeBuffer(buffer) {
  if (!buffer || buffer.byteLength < 4) return false;
  const view = new Uint8Array(buffer, 0, 4);
  return view[0] === 0x50 && view[1] === 0x4b;
}

function trimStlPreviewModelCache() {
  while (stlPreviewModelCache.size > STL_PREVIEW_CACHE_LIMIT) {
    const oldestKey = stlPreviewModelCache.keys().next().value;
    if (!oldestKey) break;
    Promise.resolve(stlPreviewModelCache.get(oldestKey))
      .then((geometry) => {
        if (geometry && typeof geometry.dispose === 'function') {
          geometry.dispose();
        }
      })
      .catch(() => {});
    stlPreviewModelCache.delete(oldestKey);
  }
}

async function loadStlPreviewLibrary() {
  if (!stlPreviewLibraryPromise) {
    stlPreviewLibraryPromise = Promise.all([
      import('three'),
      import('three/addons/loaders/STLLoader.js'),
      import('three/addons/controls/OrbitControls.js'),
    ]).then(([THREE, loaderModule, controlsModule]) => ({
      THREE,
      STLLoader: loaderModule.STLLoader,
      OrbitControls: controlsModule.OrbitControls,
    })).catch((err) => {
      stlPreviewLibraryPromise = null;
      throw new Error(`STL viewer failed to load: ${err.message || err}`);
    });
  }

  return stlPreviewLibraryPromise;
}

async function loadStlPreviewModel(sku) {
  const normalizedSku = String(sku || '').trim().toUpperCase();
  if (!normalizedSku) {
    throw new Error('Missing SKU');
  }

  if (!stlPreviewModelCache.has(normalizedSku)) {
    const modelPromise = fetch(`/api/print-queue/stl/${encodeURIComponent(normalizedSku)}/download`, {
      headers: { Accept: 'application/octet-stream' },
    })
      .then(async (response) => {
        if (!response.ok) {
          let message = `No STL preview found for ${normalizedSku}`;
          try {
            const errorData = await response.clone().json();
            if (errorData?.error) message = errorData.error;
          } catch (err) {
            message = response.statusText || message;
          }
          throw new Error(message);
        }
        return response.arrayBuffer();
      })
      .then(async (buffer) => {
        if (isZipLikeBuffer(buffer)) {
          throw new Error('Preview unavailable for 3MF files.');
        }
        const { STLLoader } = await loadStlPreviewLibrary();
        const geometry = new STLLoader().parse(buffer);
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        return geometry;
      })
      .catch((err) => {
        stlPreviewModelCache.delete(normalizedSku);
        throw err;
      });
    stlPreviewModelCache.set(normalizedSku, modelPromise);
    trimStlPreviewModelCache();
  }

  return stlPreviewModelCache.get(normalizedSku);
}

async function createStlPreviewRenderer(canvas, sourceGeometry) {
  const { THREE, OrbitControls } = await loadStlPreviewLibrary();
  const renderer = createSafeWebGlRenderer(THREE, canvas, {
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x09111a, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const geometry = sourceGeometry.clone();
  geometry.center();
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    color: 0xd9e6ef,
    roughness: 0.52,
    metalness: 0.04,
    flatShading: false,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x263140, 1.85));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.35);
  keyLight.position.set(3.5, 4.5, 6);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x9fd1ff, 0.92);
  fillLight.position.set(-4, -2, 3);
  scene.add(fillLight);

  const radius = Math.max(geometry.boundingSphere?.radius || 1, 1);
  camera.position.set(radius * 1.2, radius * 0.88, radius * 2.25);
  camera.near = Math.max(radius / 100, 0.01);
  camera.far = radius * 18;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  let animationFrameId = 0;
  const renderFrame = () => {
    animationFrameId = window.requestAnimationFrame(renderFrame);
    controls.update();
    renderer.render(scene, camera);
  };
  renderFrame();

  return {
    destroy() {
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      controls.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

async function initStlPreviewElement(previewEl, sessionId) {
  const sku = String(previewEl?.dataset?.stlPreviewSku || '').trim().toUpperCase();
  const canvas = previewEl?.querySelector('canvas');
  const statusEl = previewEl?.querySelector('.print-stl-preview__status');
  if (!sku || !canvas) return;

  try {
    const model = await loadStlPreviewModel(sku);
    if (!previewEl.isConnected || sessionId !== stlPreviewRenderSession) return;
    canvas.hidden = false;
    const renderer = await createStlPreviewRenderer(canvas, model);
    if (sessionId !== stlPreviewRenderSession) {
      if (renderer && typeof renderer.destroy === 'function') renderer.destroy();
      return;
    }
    if (renderer) activeStlPreviewRenderers.push(renderer);
    if (statusEl) {
      statusEl.textContent = 'Solid STL preview. Drag to rotate, scroll to zoom.';
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err.message || 'Preview unavailable.';
      statusEl.dataset.type = 'error';
    }
    canvas.hidden = true;
  }
}

function initPutAwayStlPreviews() {
  destroyActiveStlPreviewRenderers();
  const sessionId = stlPreviewRenderSession;
  document.querySelectorAll('[data-stl-preview-sku]').forEach((previewEl) => {
    initStlPreviewElement(previewEl, sessionId);
  });
}

function openPutAwayReview(itemId) {
  const normalizedId = Number(itemId);
  const item = printQueueItems.find((queueItem) => Number(queueItem.id) === normalizedId);
  if (!item) {
    setStatus('Print job not found.', 'error');
    return;
  }

  if (item.stageKey !== 'complete') {
    setStatus('Only complete print jobs can be put away.', 'error');
    return;
  }

  const parts = getPutAwayPartsForItem(item);
  const modal = document.getElementById('printPutAwayModal');
  const title = document.getElementById('printPutAwayTitle');
  const summary = document.getElementById('printPutAwaySummary');
  const partList = document.getElementById('printPutAwayParts');
  if (!modal || !title || !summary || !partList) {
    putAwayPrintItem(item.id);
    return;
  }

  activePutAwayItemId = String(item.id);
  title.textContent = `Put away ${getItemLabel(item)}`;
  summary.textContent = `${parts.length} ${parts.length === 1 ? 'part' : 'parts'} to check before clearing this card.`;
  partList.innerHTML = parts.length
    ? parts.map(renderPutAwayPart).join('')
    : '<p class="print-queue-empty">No parts found for this card.</p>';

  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  initPutAwayStlPreviews();
}

function closePutAwayReview() {
  const modal = document.getElementById('printPutAwayModal');
  if (modal) {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
  }
  activePutAwayItemId = '';
  destroyActiveStlPreviewRenderers();
}

function confirmPutAwayReview() {
  const itemId = activePutAwayItemId;
  if (!itemId) return;
  closePutAwayReview();
  putAwayPrintItem(itemId);
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
      label: getStageLabel('in_build'),
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
    container.innerHTML = `<p class="pick-list-empty">${escapeHtml(PRINT_QUEUE_CONFIG.emptyCatalogLabel)}</p>`;
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
                <div class="print-catalog-result__actions">
                  ${renderStlDownloadLink(item.sku)}
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
  const isNeedsPrinted = item.stageKey === 'needs_printed';
  const isPostDye = item.stageKey === 'post_dye';
  const awaitingPartsMatches = Array.isArray(item.awaitingPartsMatches) ? item.awaitingPartsMatches : [];
  const hasAwaitingPartsOrders = awaitingPartsMatches.length > 0;
  const awaitingPartsQuantity = getAwaitingPartsQuantity(item, awaitingPartsMatches);
  const isDeletePending = String(pendingPrintDeleteItemId) === String(item.id);
  const itemId = String(item.id);
  const isChildrenExpanded = expandedPrintChildItemIds.has(itemId);
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
  const awaitingPartsMeta = hasAwaitingPartsOrders
    ? `<span class="print-queue-card__awaiting-parts">Waiting parts ${escapeHtml(awaitingPartsQuantity)}</span>`
    : '';
  const awaitingPartsTitle = hasAwaitingPartsOrders
    ? awaitingPartsMatches
        .map((match) => {
          const orderNumbers = (Array.isArray(match.orders) ? match.orders : [])
            .map((order) => String(order.orderNumber || order.orderId || '').trim())
            .filter(Boolean)
            .join(', ');
          return orderNumbers ? `${match.partSku}: ${orderNumbers}` : match.partSku;
        })
        .filter(Boolean)
        .join(' | ')
    : '';
  const typeLabel = isCustom ? 'CUSTOM' : (item.typeRaw || 'UNKNOWN');
  const fileLink = isCustom && item.customFileUrl
    ? `<a class="print-queue-file-link" href="${escapeHtmlAttribute(item.customFileUrl)}" target="_blank" rel="noopener">Open File</a>`
    : '';
  const stlLink = isNeedsPrinted && !isCustom && sku
    ? renderStlDownloadLink(sku, childItems.length > 0 ? 'Parent STL' : 'Download STL')
    : '';
  const qcPdfLink = isPostDye && !isCustom && sku
    ? renderQcPdfLink(sku)
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
  const deleteButton = `
    <button
      type="button"
      class="print-queue-delete-btn"
      data-print-delete-id="${escapeHtmlAttribute(item.id)}"
      draggable="false"
      title="Remove this print card"
      aria-label="Remove ${escapeHtmlAttribute(getItemLabel(item))}"
    >
      &times;
    </button>
  `;
  const deleteConfirm = isDeletePending
    ? `
        <div class="print-queue-card__remove-confirm">
          <button
            type="button"
            class="print-queue-remove-confirm-btn"
            data-print-delete-confirm-id="${escapeHtmlAttribute(item.id)}"
            draggable="false"
          >
            Delete
          </button>
          <button
            type="button"
            class="print-queue-remove-cancel-btn"
            data-print-delete-cancel-id="${escapeHtmlAttribute(item.id)}"
            draggable="false"
          >
            Cancel
          </button>
        </div>
      `
    : '';
  const childRows = childItems.length > 0
    ? `
        <div class="print-queue-card__children${isChildrenExpanded ? ' is-expanded' : ''}">
          <button
            type="button"
            class="print-queue-card__children-toggle"
            data-print-children-toggle-id="${escapeHtmlAttribute(item.id)}"
            aria-expanded="${isChildrenExpanded ? 'true' : 'false'}"
            aria-controls="printQueueChildren-${escapeHtmlAttribute(item.id)}"
            draggable="false"
          >
            <span class="print-queue-card__children-arrow" aria-hidden="true">&gt;</span>
            <span>Sub SKUs</span>
            <strong>${escapeHtml(childItems.length)}</strong>
          </button>
          <div
            id="printQueueChildren-${escapeHtmlAttribute(item.id)}"
            class="print-queue-card__child-list"
            ${isChildrenExpanded ? '' : 'hidden'}
          >
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
                  ${isNeedsPrinted ? renderStlDownloadLink(childItem.sku) : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `
    : '';

  return `
    <article
      class="print-queue-card${hasAwaitingPartsOrders ? ' print-queue-card--awaiting-parts' : ''}"
      draggable="true"
      data-print-item-id="${escapeHtmlAttribute(item.id)}"
      data-print-item-stage="${escapeHtmlAttribute(item.stageKey)}"
      ${awaitingPartsTitle ? `title="${escapeHtmlAttribute(`Orders waiting on these parts: ${awaitingPartsTitle}`)}"` : ''}
    >
      <div class="print-queue-card__head">
        <div>
          <h3>${escapeHtml(getItemLabel(item))}</h3>
          ${isCustom && item.customFileName ? `<p>${escapeHtml(item.customFileName)}</p>` : ''}
        </div>
        <div class="print-queue-card__head-actions">
          <span class="${quantityBadgeClass}" title="${escapeHtmlAttribute(quantityBadgeLabel)}">${escapeHtml(quantityBadgeLabel)}</span>
          ${deleteButton}
        </div>
      </div>
      <div class="print-queue-card__meta">
        <span>${escapeHtml(typeLabel)}</span>
        ${item.rsq ? `<span>RSQ ${escapeHtml(item.rsq)}</span>` : ''}
        ${childItems.length > 0 ? `<span>${escapeHtml(childItems.length + 1)} parts</span>` : ''}
        ${awaitingPartsMeta}
        ${rootMeta}
        ${parentMeta}
      </div>
      ${childRows}
      ${item.notes ? `<p class="print-queue-card__notes">${escapeHtml(item.notes)}</p>` : ''}
      ${deleteConfirm}
      <div class="print-queue-card__foot">
        <span>${escapeHtml(formatTimestamp(item.updatedAt || item.createdAt))}</span>
        ${fileLink}
        ${stlLink}
        ${qcPdfLink}
        ${putAwayButton}
      </div>
    </article>
  `;
}

function renderBoard() {
  const container = document.getElementById('printQueueBoard');
  if (!container) return;
  container.classList.toggle('is-disco-mode', printQueueDiscoEnabled);

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
  const response = await fetch(withQueueParam('/api/print-catalog'), {
    headers: { Accept: 'application/json' },
  });
  const data = await readJsonResponse(response, 'Failed to load print catalog');
  printCatalogItems = Array.isArray(data.items) ? data.items : [];

  const sheetStatus = document.getElementById('printCatalogSheetStatus');
  if (sheetStatus) {
    const fetchedAt = data.sheetFetchedAt ? formatTimestamp(data.sheetFetchedAt) : '-';
    const label = data.queue?.catalogLabel || `${PRINT_QUEUE_CONFIG.shortLabel} rows`;
    sheetStatus.textContent = `${label}: ${data.sheetSkuCount ?? '-'} sheet rows / ${fetchedAt}`;
  }

  renderCatalog();
}

async function fetchPrintQueue({ silent = false, includeCatalog = false } = {}) {
  if (printQueueLoading) return;

  setLoading(true);
  if (!silent) setStatus('Loading print queue...', 'info');

  try {
    const queueResponse = await fetch(withQueueParam('/api/print-queue'), {
      headers: { Accept: 'application/json' },
    });
    const queueData = await readJsonResponse(queueResponse, 'Failed to load print queue');
    printQueueStages = Array.isArray(queueData.stages) && queueData.stages.length
      ? queueData.stages
      : printQueueStages;
    printQueueItems = Array.isArray(queueData.items) ? queueData.items : [];
    const queueItemIdSet = new Set(printQueueItems.map((item) => String(item.id)));
    expandedPrintChildItemIds = new Set(
      Array.from(expandedPrintChildItemIds).filter((itemId) => queueItemIdSet.has(String(itemId)))
    );
    if (
      pendingPrintDeleteItemId
      && !queueItemIdSet.has(String(pendingPrintDeleteItemId))
    ) {
      pendingPrintDeleteItemId = '';
    }
    if (
      activePutAwayItemId
      && !queueItemIdSet.has(String(activePutAwayItemId))
    ) {
      closePutAwayReview();
    }

    if (includeCatalog) {
      await fetchPrintCatalog();
    }

    renderOverview();
    renderBoard();
    renderCatalog();
    updateLastUpdatedLabel();
    if (!silent) {
      setStatus(`Loaded ${printQueueItems.length} ${PRINT_QUEUE_CONFIG.label} jobs.`, 'success');
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    renderOverview();
    renderBoard();
  } finally {
    setLoading(false);
  }
}

async function addCatalogSkuToQueue(sku, quantity = null) {
  const normalizedSku = String(sku || '').trim().toUpperCase();
  if (!normalizedSku || printQueueLoading) return;
  const requestedQuantity = Math.max(1, Math.floor(Number(quantity) || 1));

  setLoading(true);
  setStatus(`Adding ${normalizedSku} x${requestedQuantity}...`, 'info');

  try {
    const response = await fetch(withQueueParam('/api/print-queue/catalog'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ sku: normalizedSku, quantity: requestedQuantity, queueKey: PRINT_QUEUE_KEY }),
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
      `Added ${data.createdCount || 0} ${PRINT_QUEUE_CONFIG.label} card with ${addedPartCount} ${addedPartCount === 1 ? 'part' : 'parts'} for ${normalizedSku} at x${requestedQuantity}.`,
      'success'
    );
  } catch (err) {
    if (err?.data?.code === 'PRINT_ORIENTATION_REQUIRED') {
      const requirements = Array.isArray(err.data.orientationRequired)
        ? err.data.orientationRequired
        : [];
      setStatus(
        formatOrientationRequiredSummary(requirements),
        'error',
        getOrientationRequiredActions(requirements)
      );
      setLoading(false);
      return;
    }

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
    const response = await fetch(withQueueParam('/api/print-queue/custom'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        title,
        quantity,
        queueKey: PRINT_QUEUE_KEY,
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
    const data = await readJsonResponse(response, 'Failed to put away print job');

    setLoading(false);
    await fetchPrintQueue({ silent: true, includeCatalog: false });
    setStatus(formatPutAwayResultMessage(data), data.awaitingPartsChatError ? 'error' : 'success');
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    setLoading(false);
  }
}

async function removePrintItem(itemId) {
  const normalizedId = Number(itemId);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0 || printQueueLoading) {
    return;
  }

  setLoading(true);
  setStatus('Removing print job...', 'info');

  try {
    const response = await fetch(`/api/print-queue/${encodeURIComponent(normalizedId)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    await readJsonResponse(response, 'Failed to remove print job');

    pendingPrintDeleteItemId = '';
    setLoading(false);
    await fetchPrintQueue({ silent: true, includeCatalog: false });
    setStatus('Print job removed from the queue.', 'success');
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    setLoading(false);
  }
}

function formatPutAwayResultMessage(data) {
  const matches = Array.isArray(data?.awaitingPartsMatches) ? data.awaitingPartsMatches : [];
  if (matches.length === 0) {
    const chatStatus = data.awaitingPartsChatSent
      ? 'Team notified in chat.'
      : (data.awaitingPartsChatError ? `Chat not sent: ${data.awaitingPartsChatError}.` : '');
    return ['Print job put away.', 'No waiting orders found for these SKUs.', chatStatus]
      .filter(Boolean)
      .join(' ');
  }

  const orderNumbers = Array.from(new Set(matches.flatMap((match) => (
    Array.isArray(match.orders) ? match.orders : []
  )).map((order) => String(order.orderNumber || order.orderId || '').trim()).filter(Boolean)));
  const skuLabels = matches.map((match) => String(match.partSku || '').trim()).filter(Boolean);
  const orderSummary = orderNumbers.slice(0, 4).join(', ')
    + (orderNumbers.length > 4 ? ` +${orderNumbers.length - 4}` : '');
  const skuSummary = skuLabels.slice(0, 4).join(', ')
    + (skuLabels.length > 4 ? ` +${skuLabels.length - 4}` : '');
  const chatStatus = data.awaitingPartsChatSent
    ? 'Team notified in chat.'
    : (data.awaitingPartsChatError ? `Chat not sent: ${data.awaitingPartsChatError}.` : '');

  return [
    'Print job put away.',
    `${orderNumbers.length} ${orderNumbers.length === 1 ? 'order is' : 'orders are'} waiting on ${skuSummary}: ${orderSummary}.`,
    chatStatus,
  ].filter(Boolean).join(' ');
}

function formatPreformMissingFile(file) {
  const sku = String(file?.sku || '').trim();
  const title = String(file?.title || '').trim();
  const label = sku || title || 'Unnamed part';
  const quantity = Math.max(1, Number(file?.quantity) || 1);
  const fileLabel = `${label}.stl/.3mf`;

  return quantity > 1 ? `${fileLabel} (x${quantity})` : fileLabel;
}

function formatPreformCustomIssue(item) {
  const title = String(item?.title || '').trim() || 'Unnamed custom job';
  const quantity = Math.max(1, Number(item?.quantity) || 1);
  return quantity > 1 ? `${title} (x${quantity})` : title;
}

function formatPreformIssueInstructions(missingFiles, skippedCustomItems) {
  const messages = [];
  const missingList = missingFiles.map(formatPreformMissingFile).filter(Boolean);
  const customList = skippedCustomItems.map(formatPreformCustomIssue).filter(Boolean);

  if (missingList.length > 0) {
    messages.push(`Missing or misnamed model files: ${missingList.join(', ')}. Upload these as STL/3MF files, or correct the filenames in Google Drive.`);
  }
  if (customList.length > 0) {
    messages.push(`Custom jobs missing a Drive file link: ${customList.join(', ')}.`);
  }

  return messages;
}

function formatOrientationRequirement(requirement) {
  const sku = String(requirement?.sku || '').trim();
  const status = String(requirement?.status || '').trim();
  const fileName = String(requirement?.driveFile?.name || '').trim();
  const reason = status === 'stale'
    ? 'Drive file changed'
    : 'not oriented';
  return [sku, fileName ? `(${fileName})` : '', reason].filter(Boolean).join(' ');
}

function formatOrientationRequiredSummary(requirements) {
  const items = Array.isArray(requirements) ? requirements : [];
  const labels = items.map(formatOrientationRequirement).filter(Boolean);
  const labelSummary = labels.join(', ');

  return [
    'Build blocked: every parent and sub SKU STL must be manually oriented first.',
    labelSummary ? `Orient these files: ${labelSummary}.` : '',
    'Start with the first one, click the downward face, save it, then continue through the list.',
  ].filter(Boolean).join(' ');
}

function getOrientationRequiredActions(requirements) {
  const items = Array.isArray(requirements) ? requirements : [];
  const firstSku = String(items[0]?.sku || '').trim();
  const actions = [];

  if (firstSku) {
    actions.push({
      href: `/print_config.html?orient=${encodeURIComponent(firstSku)}`,
      label: `Orient ${firstSku}`,
    });
  }
  actions.push({
    href: '/print_config.html',
    label: 'Open Orientation Library',
  });

  return actions;
}

function getPreformBuildDownloadActions(data) {
  const downloads = data?.downloads && typeof data.downloads === 'object' ? data.downloads : {};
  const actions = [];
  const buildCount = Array.isArray(data?.preform?.builds) ? data.preform.builds.length : 0;

  if (downloads.zip) {
    actions.push({
      href: downloads.zip,
      label: data?.partialBuild
        ? 'Download Partial Build Zip'
        : (buildCount > 1 ? 'Download Builds Zip' : 'Download Build Zip'),
    });
  } else if (downloads.form) {
    actions.push({
      href: downloads.form,
      label: data?.partialBuild ? 'Download Partial Build' : 'Download Build',
    });
  }

  if (downloads.manifest) {
    actions.push({
      href: downloads.manifest,
      label: 'Download Manifest',
    });
  }

  return actions;
}

function formatPreformDensity(value) {
  const density = Number(value);
  return Number.isFinite(density) && density > 0 ? `${Math.round(density * 100)}%` : '-';
}

function formatPreformBuildDensitySummary(preform) {
  const builds = Array.isArray(preform?.builds) ? preform.builds : [];
  if (builds.length <= 1) return '';

  const densityLabels = builds.map((build, index) => {
    const layerCount = Number(build.layerCount || 0);
    const layerLabel = layerCount > 0 ? `, ${layerCount} layers` : '';
    return `Build ${index + 1}: ${formatPreformDensity(build.buildDensity)}${layerLabel}`;
  });
  return `Densities: ${densityLabels.join(', ')}.`;
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
  const issueInstructions = formatPreformIssueInstructions(missingFiles, skippedCustomItems);
  const buildCount = Array.isArray(preform?.builds) ? preform.builds.length : 0;
  const buildLabel = buildCount > 1 ? `${buildCount} PreForm builds` : 'PreForm build';
  const densitySummary = formatPreformBuildDensitySummary(preform);

  if (preform?.formFilePath) {
    if (issueCount > 0) {
      return [
        `Created partial ${buildLabel} with ${modelInstanceCount} model ${modelInstanceCount === 1 ? 'instance' : 'instances'}, but it is missing parts.`,
        densitySummary,
        'Do not treat this as a complete build until the missing files are fixed.',
        ...issueInstructions,
        'Cards were left in Needs Printed.',
      ].filter(Boolean).join(' ');
    }

    return [
      `Created ${buildLabel} with ${modelInstanceCount} model ${modelInstanceCount === 1 ? 'instance' : 'instances'}.`,
      densitySummary,
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
      ...issueInstructions,
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
  if (!PRINT_QUEUE_CONFIG.supportsPreformBuild) {
    setStatus('PreForm build preparation is only available for the SLS / Adapter print queue.', 'error');
    return;
  }

  setLoading(true);
  setStatus('Preparing SLS build from Needs Printed...', 'info');

  try {
    const response = await fetch(withQueueParam('/api/print-queue/preform-build'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ moveToInBuild: true, queueKey: PRINT_QUEUE_KEY }),
    });
    const data = await readJsonResponse(response, 'Failed to prepare SLS build');

    setLoading(false);
    await fetchPrintQueue({ silent: true, includeCatalog: false });
    const issueCount = Number(data?.manifest?.missingFiles?.length || 0)
      + Number(data?.manifest?.skippedCustomItems?.length || 0);
    const downloadActions = getPreformBuildDownloadActions(data);
    if (downloadActions.length > 0) {
      saveLatestPreformBuildDownloadActions(downloadActions);
    }
    setStatus(
      formatPreformBuildSummary(data),
      issueCount > 0 ? 'error' : 'success',
      downloadActions
    );
  } catch (err) {
    if (err?.data?.code === 'PRINT_ORIENTATION_REQUIRED') {
      const requirements = Array.isArray(err.data.orientationRequired)
        ? err.data.orientationRequired
        : [];
      setStatus(
        formatOrientationRequiredSummary(requirements),
        'error',
        getOrientationRequiredActions(requirements)
      );
      setLoading(false);
      return;
    }

    setStatus(`Error: ${err.message}`, 'error');
    setLoading(false);
  }
}

function clearPrintQueueDiscoPressTimer() {
  if (printQueueDiscoPressTimerId) {
    window.clearTimeout(printQueueDiscoPressTimerId);
  }
  printQueueDiscoPressTimerId = null;
  printQueueDiscoPressPointerId = null;
  printQueueDiscoPressStart = null;
}

function togglePrintQueueDiscoMode(board) {
  printQueueDiscoEnabled = !printQueueDiscoEnabled;
  board.classList.toggle('is-disco-mode', printQueueDiscoEnabled);
}

function bindBoardEvents(board) {
  board.addEventListener('pointerdown', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('button, a, input, select, textarea')) return;

    const card = target.closest('.print-queue-card');
    if (!card) return;

    clearPrintQueueDiscoPressTimer();
    printQueueDiscoPressPointerId = event.pointerId;
    printQueueDiscoPressStart = {
      x: event.clientX,
      y: event.clientY,
    };
    printQueueDiscoPressTimerId = window.setTimeout(() => {
      togglePrintQueueDiscoMode(board);
      clearPrintQueueDiscoPressTimer();
    }, 5000);
  });

  board.addEventListener('pointermove', (event) => {
    if (!printQueueDiscoPressTimerId || event.pointerId !== printQueueDiscoPressPointerId) return;
    const start = printQueueDiscoPressStart;
    if (!start) return;
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (distance > 12) {
      clearPrintQueueDiscoPressTimer();
    }
  });

  ['pointerup', 'pointercancel', 'pointerleave'].forEach((eventName) => {
    board.addEventListener(eventName, (event) => {
      if (event.pointerId === printQueueDiscoPressPointerId) {
        clearPrintQueueDiscoPressTimer();
      }
    });
  });

  board.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const childrenToggle = target
      ? target.closest('[data-print-children-toggle-id]')
      : null;
    if (childrenToggle) {
      event.preventDefault();
      event.stopPropagation();
      const itemId = String(childrenToggle.getAttribute('data-print-children-toggle-id') || '');
      if (expandedPrintChildItemIds.has(itemId)) {
        expandedPrintChildItemIds.delete(itemId);
      } else if (itemId) {
        expandedPrintChildItemIds.add(itemId);
      }
      renderBoard();
      return;
    }

    const confirmButton = target
      ? target.closest('[data-print-delete-confirm-id]')
      : null;
    if (confirmButton) {
      event.preventDefault();
      event.stopPropagation();
      removePrintItem(confirmButton.getAttribute('data-print-delete-confirm-id'));
      return;
    }

    const cancelButton = target
      ? target.closest('[data-print-delete-cancel-id]')
      : null;
    if (cancelButton) {
      event.preventDefault();
      event.stopPropagation();
      pendingPrintDeleteItemId = '';
      renderBoard();
      return;
    }

    const deleteButton = target
      ? target.closest('[data-print-delete-id]')
      : null;
    if (deleteButton) {
      event.preventDefault();
      event.stopPropagation();
      pendingPrintDeleteItemId = String(deleteButton.getAttribute('data-print-delete-id') || '');
      renderBoard();
      return;
    }

    const button = target
      ? target.closest('[data-print-put-away-id]')
      : null;
    if (!button) return;

    event.preventDefault();
    openPutAwayReview(button.getAttribute('data-print-put-away-id'));
  });

  board.addEventListener('dragstart', (event) => {
    clearPrintQueueDiscoPressTimer();
    if (event.target instanceof Element && event.target.closest('button, a')) {
      event.preventDefault();
      return;
    }

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
  const putAwayModal = document.getElementById('printPutAwayModal');
  const putAwayCancelBtn = document.getElementById('printPutAwayCancelBtn');
  const putAwayConfirmBtn = document.getElementById('printPutAwayConfirmBtn');

  document.body?.classList.toggle('print-queue-page--fdm', PRINT_QUEUE_KEY === 'fdm');
  if (buildBtn && !PRINT_QUEUE_CONFIG.supportsPreformBuild) {
    buildBtn.hidden = true;
    buildBtn.disabled = true;
  }

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
      const sku = button.getAttribute('data-print-add-sku');
      const item = printCatalogItems.find((catalogItem) => normalizeSearchText(catalogItem?.sku) === normalizeSearchText(sku));
      const quantity = promptCatalogPrintQuantity(item || { sku });
      if (quantity === null) return;
      addCatalogSkuToQueue(sku, quantity);
    });
  }

  if (customForm) {
    customForm.addEventListener('submit', addCustomPrintJob);
  }

  if (board) {
    bindBoardEvents(board);
  }

  if (putAwayCancelBtn) {
    putAwayCancelBtn.addEventListener('click', closePutAwayReview);
  }

  if (putAwayConfirmBtn) {
    putAwayConfirmBtn.addEventListener('click', confirmPutAwayReview);
  }

  if (putAwayModal) {
    putAwayModal.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        closePutAwayReview();
      }
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && putAwayModal?.classList.contains('is-open')) {
      closePutAwayReview();
    }
  });

  fetchPrintQueue({ includeCatalog: true });

  if (printQueuePollId) {
    clearInterval(printQueuePollId);
  }

  printQueuePollId = setInterval(() => {
    fetchPrintQueue({ silent: true, includeCatalog: false });
  }, PRINT_QUEUE_POLL_MS);
});
