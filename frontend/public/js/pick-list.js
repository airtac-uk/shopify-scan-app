let loading = false;
let hidBuffer = '';
let hidLastKeyAt = 0;
let hidBufferTimeoutId = null;
let pickerModeEnabled = false;
let verifyModeEnabled = false;
let wholesaleModeEnabled = false;
let lastRenderedLineItems = [];
let lastOrderItems = [];
let lastWholesaleProgressByItemKey = {};
let hasRenderedPickList = false;
let currentOrderBarcode = '';
let currentOrderNumber = '';
let currentOrderNote = '';
let currentWorkflowBlock = null;
let currentTrackerUrl = '';
let currentAwaitingPartsSkuMap = new Map();
let lastActionTag = '';
let lastActionBarcode = '';
let actionButtons = [];
let actionButtonsUnlocked = false;
let verifyItems = [];
let verifyCodeIndex = new Map();
let verifyAudioContext = null;
let wholesaleSaveTimeoutId = null;
let wholesaleSaveInFlight = false;
let wholesaleSaveQueued = false;

const PICKER_MODE_COOKIE = 'pick_list_picker_mode';
const VERIFY_MODE_COOKIE = 'pick_list_verify_mode';
const WHOLESALE_MODE_COOKIE = 'pick_list_wholesale_mode';
const NON_DEDUPE_ACTION_TAGS = new Set(['awaiting_parts', 'qc_fail', 'wholesale_adapter_built']);

function getCookieValue(name) {
  const prefix = `${name}=`;
  const cookie = document.cookie
    .split('; ')
    .find((part) => part.startsWith(prefix));
  if (!cookie) return '';
  return decodeURIComponent(cookie.slice(prefix.length));
}

function setCookieValue(name, value, maxAgeDays = 365) {
  const maxAgeSeconds = Math.max(1, Math.floor(maxAgeDays * 24 * 60 * 60));
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; samesite=lax`;
}

function focusBarcodeInput({ selectAll = false } = {}) {
  const input = document.getElementById('pickListBarcode');
  if (!input) return;
  input.focus();
  if (selectAll) {
    input.select();
  }
}

function getInitialOrderLookupValue() {
  const params = new URLSearchParams(window.location.search);
  return String(params.get('order') || params.get('barcode') || '').trim().toUpperCase();
}

function normalizeDisplaySku(value) {
  return String(value || '').trim().toUpperCase();
}

function isAwaitingPartsSku(value) {
  return currentAwaitingPartsSkuMap.has(normalizeDisplaySku(value));
}

function getAwaitingPartsQty(value) {
  return currentAwaitingPartsSkuMap.get(normalizeDisplaySku(value)) || 0;
}

function setCurrentAwaitingPartsItems(items) {
  currentAwaitingPartsSkuMap = new Map();

  (items || []).forEach((item) => {
    const sku = normalizeDisplaySku(item?.sku || item?.partSku);
    if (!sku) return;
    currentAwaitingPartsSkuMap.set(sku, Math.max(1, Number(item?.quantity) || 1));
  });
}

function setStatus(message, type = 'info') {
  const el = document.getElementById('pickListStatus');
  if (!el) return;
  el.textContent = message;
  el.dataset.type = type;
}

function renderTrackerLink() {
  const container = document.getElementById('pickListTrackerLink');
  const anchor = document.getElementById('pickListTrackerAnchor');
  if (!container || !anchor) return;

  if (!currentTrackerUrl) {
    container.hidden = true;
    anchor.href = '#';
    return;
  }

  anchor.href = currentTrackerUrl;
  container.hidden = false;
}

function formatWorkflowStatusLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  return raw
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function renderWorkflowAlert() {
  const alert = document.getElementById('pickListWorkflowAlert');
  const title = document.getElementById('pickListWorkflowAlertTitle');
  const badge = document.getElementById('pickListWorkflowAlertBadge');
  const message = document.getElementById('pickListWorkflowAlertMessage');
  if (!alert || !title || !badge || !message) return;

  alert.classList.remove(
    'pick-list-workflow-alert--cancelled',
    'pick-list-workflow-alert--fulfilled',
    'pick-list-workflow-alert--partiallyfulfilled',
    'pick-list-workflow-alert--restocked'
  );

  if (!isCurrentOrderWorkflowBlocked()) {
    alert.hidden = true;
    title.textContent = 'Order blocked';
    badge.textContent = '';
    message.textContent = '';
    return;
  }

  const workflowStatus = String(currentWorkflowBlock?.status || '').trim();
  const workflowCode = String(currentWorkflowBlock?.code || '').trim().toLowerCase();
  const normalizedClassKey = workflowStatus.toLowerCase().replace(/[^a-z0-9]/g, '');
  const statusLabel = formatWorkflowStatusLabel(workflowStatus || workflowCode);

  if (normalizedClassKey) {
    alert.classList.add(`pick-list-workflow-alert--${normalizedClassKey}`);
  }

  title.textContent = statusLabel
    ? `${statusLabel} Order`
    : 'Order blocked';
  badge.textContent = statusLabel || 'Blocked';
  message.textContent = currentWorkflowBlock?.message || 'This order cannot be picked or built.';
  alert.hidden = false;
}

function isCurrentOrderWorkflowBlocked() {
  return Boolean(currentWorkflowBlock && currentWorkflowBlock.blocked);
}

function clearLoadedOrderState() {
  lastRenderedLineItems = [];
  lastOrderItems = [];
  lastWholesaleProgressByItemKey = {};
  hasRenderedPickList = false;
  currentOrderBarcode = '';
  currentOrderNumber = '';
  currentOrderNote = '';
  currentWorkflowBlock = null;
  currentTrackerUrl = '';
  currentAwaitingPartsSkuMap = new Map();
  verifyItems = [];
  verifyCodeIndex = new Map();

  const orderMeta = document.getElementById('pickListOrderMeta');
  const lineItems = document.getElementById('pickListLineItems');
  const timelineSection = document.getElementById('pickListTimelineSection');
  const timelineCard = document.getElementById('pickListTimelineCard');

  if (orderMeta) orderMeta.textContent = '';
  if (lineItems) lineItems.innerHTML = '';
  if (timelineSection) timelineSection.hidden = true;
  if (timelineCard) timelineCard.innerHTML = '';

  renderWorkflowAlert();
  renderTrackerLink();
  setActionButtonsEnabled(false);
}

function isVerificationStyleModeEnabled() {
  return verifyModeEnabled || wholesaleModeEnabled;
}

function isPackagedActionLocked() {
  if (!isVerificationStyleModeEnabled()) return false;
  if (!hasRenderedPickList) return true;
  return !getVerifyTotals().isComplete;
}

function setActionButtonsEnabled(enabled) {
  actionButtonsUnlocked = Boolean(enabled);
  actionButtons.forEach((button) => {
    const tag = button.dataset.orderAction || '';
    const packagedLocked = tag === 'packaged' && isPackagedActionLocked();
    button.disabled = loading || !actionButtonsUnlocked || packagedLocked || isCurrentOrderWorkflowBlocked();
  });
}

function syncVerifyButtonDisabledState() {
  const verifyButtons = document.querySelectorAll('.pick-verify-item-btn');
  verifyButtons.forEach((button) => {
    if (isCurrentOrderWorkflowBlocked()) {
      button.disabled = true;
      return;
    }

    const role = button.dataset.role || 'increment';
    if (role === 'undo') {
      const canUndo = button.dataset.canUndo === '1';
      button.disabled = loading || !canUndo;
      return;
    }

    const isComplete = button.dataset.complete === '1';
    button.disabled = loading || isComplete;
  });
}

function syncActionVisibilityForModes() {
  actionButtons.forEach((button) => {
    const tag = button.dataset.orderAction || '';
    const isPickerVisible = button.dataset.pickerVisible === 'true';
    const isVerifyVisible = button.dataset.verifyVisible === 'true';

    if (wholesaleModeEnabled) {
      button.hidden = !isVerifyVisible;
      return;
    }

    if (verifyModeEnabled) {
      button.hidden = !isVerifyVisible;
      return;
    }

    if (pickerModeEnabled) {
      button.hidden = !isPickerVisible;
      return;
    }

    button.hidden = tag === 'racked_up' || tag === 'packaged';
  });
}

function parseTimelineEvents(orderNoteText) {
  const text = String(orderNoteText || '').trim();
  if (!text) return [];

  const segments = text.includes('~')
    ? text.split('~').map((segment) => segment.trim()).filter(Boolean)
    : [text];

  return segments.map((segment, index) => {
    const lines = segment
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const headline = lines[0] || '';
    let title = headline || 'Order Note';
    let timestamp = '';

    const splitHeadline = headline.match(/^(.*?)(?:\s+[—-]\s+)(.+)$/);
    if (splitHeadline) {
      title = splitHeadline[1].trim() || title;
      timestamp = splitHeadline[2].trim();
    }

    return {
      id: `${index}-${title}-${timestamp}`,
      title,
      timestamp,
      details: lines.slice(1),
    };
  });
}

function renderOrderTimeline() {
  const section = document.getElementById('pickListTimelineSection');
  const container = document.getElementById('pickListTimelineCard');
  if (!section || !container) return;

  if (!hasRenderedPickList || pickerModeEnabled || verifyModeEnabled || wholesaleModeEnabled) {
    section.hidden = true;
    container.innerHTML = '';
    return;
  }

  section.hidden = false;
  container.innerHTML = '';

  const events = parseTimelineEvents(currentOrderNote);
  if (!events.length) {
    const empty = document.createElement('p');
    empty.className = 'pick-list-empty';
    empty.textContent = 'No order note events found.';
    container.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'pick-list-timeline-list';

  events.forEach((event) => {
    const item = document.createElement('article');
    item.className = 'pick-list-timeline-item';

    const head = document.createElement('div');
    head.className = 'pick-list-timeline-head';

    const title = document.createElement('h3');
    title.textContent = event.title;
    head.appendChild(title);

    if (event.timestamp) {
      const time = document.createElement('p');
      time.className = 'pick-list-timeline-time';
      time.textContent = event.timestamp;
      head.appendChild(time);
    }

    item.appendChild(head);

    if (Array.isArray(event.details) && event.details.length > 0) {
      const details = document.createElement('ul');
      details.className = 'pick-list-timeline-details';

      event.details.forEach((line) => {
        const detail = document.createElement('li');
        detail.textContent = line;
        details.appendChild(detail);
      });

      item.appendChild(details);
    }

    list.appendChild(item);
  });

  container.appendChild(list);
}

function setLoading(isLoading) {
  loading = isLoading;
  const spinner = document.getElementById('pickListSpinner');
  const fetchButton = document.getElementById('pickListFetchBtn');

  if (spinner) spinner.style.display = isLoading ? 'inline-block' : 'none';
  if (fetchButton) fetchButton.disabled = isLoading;
  setActionButtonsEnabled(actionButtonsUnlocked);
  syncVerifyButtonDisabledState();
}

function normalizeTypeKey(type) {
  return String(type || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function getLineTypeClass(type) {
  const key = normalizeTypeKey(type);
  if (key === 'DROPIN') return 'pick-list-card--drop-in';
  if (key === 'DESKITEM') return 'pick-list-card--desk-item';
  if (key === '3RDPARTY') return 'pick-list-card--third-party';
  if (!key || key === 'UNKNOWN') return 'pick-list-card--no-type';
  return '';
}

function formatActionLabel(tag) {
  switch (tag) {
    case 'racked_up':
      return 'Racked';
    case 'awaiting_parts':
      return 'Awaiting Parts';
    case 'waiting_qc':
      return 'Waiting QC';
    case 'wholesale_adapter_built':
      return 'Wholesale Adapter';
    case 'qc_passed':
      return 'QC Passed';
    case 'qc_fail':
      return 'QC Fail';
    case 'packaged':
      return 'Packaged';
    case 'on_hold':
      return 'On Hold';
    default:
      return tag;
  }
}

function isAnyDialogOpen() {
  const awaitingPartsModal = document.getElementById('awaitingPartsModal');
  const qcFailModal = document.getElementById('qcFailModal');

  return Boolean(
    awaitingPartsModal?.classList.contains('is-open') ||
    qcFailModal?.classList.contains('is-open')
  );
}

function renderRows(container, rows, emptyText) {
  container.innerHTML = '';

  if (!rows || rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'pick-list-empty';
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'pick-list-items';

  const headerItem = document.createElement('li');
  headerItem.className = 'pick-list-item pick-list-item-header';

  const skuHeader = document.createElement('div');
  skuHeader.className = 'pick-list-cell pick-list-col-sku';
  skuHeader.textContent = 'SKU';

  const locationHeader = document.createElement('div');
  locationHeader.className = 'pick-list-cell pick-list-col-location';
  locationHeader.textContent = 'Location';

  const noteHeader = document.createElement('div');
  noteHeader.className = 'pick-list-cell pick-list-col-note';
  noteHeader.textContent = 'Note';

  headerItem.appendChild(skuHeader);
  headerItem.appendChild(locationHeader);
  headerItem.appendChild(noteHeader);
  list.appendChild(headerItem);

  rows.forEach((row) => {
    const item = document.createElement('li');
    item.className = 'pick-list-item';
    const isAwaitingParts = isAwaitingPartsSku(row.sku);
    const awaitingPartsQty = getAwaitingPartsQty(row.sku);
    if (isAwaitingParts) {
      item.classList.add('pick-list-item--awaiting-parts');
    }

    const main = document.createElement('div');
    main.className = 'pick-list-cell pick-list-col-sku pick-list-item-main';
    main.textContent = `${row.sku}`;
    if (isAwaitingParts) {
      const badge = document.createElement('span');
      badge.className = 'pick-list-awaiting-parts-badge';
      badge.textContent = awaitingPartsQty > 1 ? `Awaiting Parts x${awaitingPartsQty}` : 'Awaiting Parts';
      main.appendChild(badge);
    }

    const location = document.createElement('div');
    location.className = 'pick-list-cell pick-list-col-location pick-list-item-location';
    location.textContent = row.location ? row.location : '-';

    const note = document.createElement('div');
    note.className = 'pick-list-cell pick-list-col-note pick-list-item-note';
    note.textContent = String(row.note || '').trim();

    item.appendChild(main);
    item.appendChild(location);
    item.appendChild(note);

    list.appendChild(item);
  });

  container.appendChild(list);
}

function createSection(title, rows, emptyText) {
  const section = document.createElement('section');
  section.className = 'pick-list-section';

  const heading = document.createElement('h4');
  heading.textContent = title;
  section.appendChild(heading);

  const content = document.createElement('div');
  section.appendChild(content);

  renderRows(content, rows, emptyText);
  return section;
}

function renderLineCards(lineItems) {
  const container = document.getElementById('pickListLineItems');
  container.innerHTML = '';

  if (!lineItems || lineItems.length === 0) {
    container.innerHTML = '<p class="pick-list-empty">No SKU line items found on this order.</p>';
    return;
  }

  let previousBundleGroupId = '';

  lineItems.forEach((line, index) => {
    const bundleGroupId = String(line.bundleGroupId || '').trim();
    const bundleGroupTitle = String(line.bundleGroupTitle || '').trim();
    const bundleGroupQty = Number(line.bundleGroupQuantity) || null;
    const hasFollowingItem = index < lineItems.length - 1;
    const nextBundleGroupId = String(lineItems[index + 1]?.bundleGroupId || '').trim();

    if (bundleGroupId && bundleGroupId !== previousBundleGroupId) {
      const bundleMarker = document.createElement('div');
      bundleMarker.className = 'pick-list-bundle-marker';
      const bundleLabel = bundleGroupTitle ? `Bundle: ${bundleGroupTitle}` : 'Bundle';
      bundleMarker.textContent = bundleGroupQty ? `${bundleLabel} x${bundleGroupQty}` : bundleLabel;
      container.appendChild(bundleMarker);
    }

    const card = document.createElement('article');
    card.className = 'pick-list-card';
    const typeClassName = getLineTypeClass(line.lineType);
    if (typeClassName) {
      card.classList.add(typeClassName);
    }
    if (bundleGroupId) {
      card.classList.add('pick-list-card--bundled');
    }
    const awaitingPartsQty = getAwaitingPartsQty(line.sku);
    if (awaitingPartsQty > 0) {
      card.classList.add('pick-list-card--awaiting-parts');
    }

    const header = document.createElement('header');
    header.className = 'pick-list-card-header';
    const title = document.createElement('h3');
    title.textContent = `${line.sku} x${line.quantity}`;
    const subtitle = document.createElement('p');
    subtitle.textContent = `${line.title || ''}${line.variantTitle ? ` - ${line.variantTitle}` : ''}`;
    header.appendChild(title);
    header.appendChild(subtitle);
    if (bundleGroupId) {
      const bundleMeta = document.createElement('p');
      bundleMeta.className = 'pick-list-card-bundle-meta';
      bundleMeta.textContent = bundleGroupQty
        ? `Bundle item (${bundleGroupQty} item bundle)`
        : 'Bundle item';
      header.appendChild(bundleMeta);
    }
    if (awaitingPartsQty > 0) {
      const awaitingPartsMeta = document.createElement('p');
      awaitingPartsMeta.className = 'pick-list-card-awaiting-meta';
      awaitingPartsMeta.textContent = awaitingPartsQty > 1
        ? `Marked as awaiting parts x${awaitingPartsQty}`
        : 'Marked as awaiting parts';
      header.appendChild(awaitingPartsMeta);
    }

    card.appendChild(header);
    if (Array.isArray(line.mustPick) && line.mustPick.length > 0) {
      card.appendChild(createSection('Must Pick', line.mustPick, 'No pick-required SKUs.'));
    }
    if (!pickerModeEnabled && Array.isArray(line.deskItems) && line.deskItems.length > 0) {
      card.appendChild(createSection('Desk Items (List Only)', line.deskItems, 'No desk items.'));
    }
    if (Array.isArray(line.reviewItems) && line.reviewItems.length > 0) {
      card.appendChild(createSection('Needs Review', line.reviewItems, 'No review items.'));
    }

    container.appendChild(card);

    if (bundleGroupId && bundleGroupId !== nextBundleGroupId && hasFollowingItem) {
      const bundleEndDivider = document.createElement('div');
      bundleEndDivider.className = 'pick-list-bundle-end-divider';
      bundleEndDivider.textContent = 'End Bundle';
      container.appendChild(bundleEndDivider);
    }

    previousBundleGroupId = bundleGroupId;
    if (!bundleGroupId) {
      previousBundleGroupId = '';
    }
  });
}

function normalizeVerifyCode(value) {
  return String(value || '').trim().toUpperCase();
}

function expandVerifyCodeVariants(value) {
  const raw = normalizeVerifyCode(value);
  if (!raw) return [];

  const variants = new Set([raw]);
  const noSpaces = raw.replace(/\s+/g, '');
  if (noSpaces) variants.add(noSpaces);

  const alnum = noSpaces.replace(/[^A-Z0-9]/g, '');
  if (alnum) {
    variants.add(alnum);
    const alnumNoLeadingZeros = alnum.replace(/^0+/, '');
    if (alnumNoLeadingZeros) variants.add(alnumNoLeadingZeros);
  }

  const digits = raw.replace(/\D/g, '');
  if (digits) {
    variants.add(digits);
    const digitsNoLeadingZeros = digits.replace(/^0+/, '');
    if (digitsNoLeadingZeros) variants.add(digitsNoLeadingZeros);
  }

  return Array.from(variants).filter(Boolean);
}

function getVerifyAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;

  if (!verifyAudioContext) {
    verifyAudioContext = new AudioCtx();
  }

  if (verifyAudioContext.state === 'suspended') {
    verifyAudioContext.resume().catch(() => {});
  }

  return verifyAudioContext;
}

function playVerifyTone(ctx, options = {}) {
  const {
    startOffset = 0,
    frequency = 650,
    endFrequency = 850,
    duration = 0.1,
    gain = 0.03,
    type = 'sine',
  } = options;

  const oscillator = ctx.createOscillator();
  const volume = ctx.createGain();
  const startAt = ctx.currentTime + startOffset;
  const endAt = startAt + duration;

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(Math.max(1, frequency), startAt);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), endAt);

  volume.gain.setValueAtTime(Math.max(0.0001, gain), startAt);
  volume.gain.exponentialRampToValueAtTime(0.0001, endAt);

  oscillator.connect(volume).connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(endAt);
}

function playVerifyScanSound() {
  const ctx = getVerifyAudioContext();
  if (!ctx) return;

  playVerifyTone(ctx, {
    frequency: 620,
    endFrequency: 900,
    duration: 0.09,
    gain: 0.028,
    type: 'sine',
  });
}

function playVerifyCompleteSound() {
  const ctx = getVerifyAudioContext();
  if (!ctx) return;

  playVerifyTone(ctx, {
    startOffset: 0,
    frequency: 620,
    endFrequency: 760,
    duration: 0.11,
    gain: 0.032,
    type: 'triangle',
  });
  playVerifyTone(ctx, {
    startOffset: 0.12,
    frequency: 760,
    endFrequency: 980,
    duration: 0.11,
    gain: 0.032,
    type: 'triangle',
  });
  playVerifyTone(ctx, {
    startOffset: 0.24,
    frequency: 980,
    endFrequency: 1240,
    duration: 0.15,
    gain: 0.036,
    type: 'triangle',
  });
}

function playVerifyErrorSound() {
  const ctx = getVerifyAudioContext();
  if (!ctx) return;

  playVerifyTone(ctx, {
    startOffset: 0,
    frequency: 380,
    endFrequency: 220,
    duration: 0.12,
    gain: 0.034,
    type: 'sawtooth',
  });
  playVerifyTone(ctx, {
    startOffset: 0.14,
    frequency: 250,
    endFrequency: 140,
    duration: 0.16,
    gain: 0.03,
    type: 'sawtooth',
  });
}

function showWorkflowBlockedWarning(message = '') {
  playVerifyErrorSound();
  setStatus(message || 'This order cannot be picked or built.', 'error');
}

function buildVerifyState(orderItems, initialProgressByItemKey = null) {
  const grouped = new Map();
  const bundleOrder = new Map();

  (orderItems || []).forEach((item, index) => {
    const sku = String(item?.sku || '').trim();
    const upc = String(item?.upc || '').trim();
    const rawQty = Number(item?.quantity);
    const qty = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 1;
    const bundleGroupId = String(item?.bundleGroup?.id || '').trim();
    const bundleGroupTitle = String(item?.bundleGroup?.title || '').trim();
    const bundleGroupQuantity = Number(item?.bundleGroup?.quantity) || null;

    const nameBase = String(item?.title || '').trim();
    const variantTitle = String(item?.variantTitle || '').trim();
    const productName = variantTitle ? `${nameBase} - ${variantTitle}` : nameBase;

    const normalizedSku = normalizeVerifyCode(sku);
    const normalizedUpc = normalizeVerifyCode(upc);
    const lineStableId = String(item?.id || '').trim() || `ORDER_ITEM_${index + 1}`;
    // Keep no-SKU rows separate even if UPC matches, so duplicate UPC items
    // are verified one item at a time.
    const rowBaseKey = normalizedSku ? `SKU:${normalizedSku}` : `LINE:${lineStableId}`;
    const key = `${bundleGroupId ? `bundle:${bundleGroupId}` : 'ungrouped'}::${rowBaseKey}`;

    if (bundleGroupId && !bundleOrder.has(bundleGroupId)) {
      bundleOrder.set(bundleGroupId, index);
    }

    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        sku: sku || '(No SKU)',
        upc,
        productName: productName || sku || upc || `Item ${index + 1}`,
        bundleGroupId,
        bundleGroupTitle,
        bundleGroupQuantity,
        sortIndex: index,
        requiredQty: 0,
        scannedQty: 0,
        codes: new Set(),
      });
    }

    const row = grouped.get(key);
    row.sortIndex = Math.min(row.sortIndex, index);
    row.requiredQty += qty;
    expandVerifyCodeVariants(normalizedSku).forEach((code) => row.codes.add(code));
    expandVerifyCodeVariants(normalizedUpc).forEach((code) => row.codes.add(code));
  });

  verifyItems = Array.from(grouped.values()).sort((a, b) => {
    const aGroupSort = a.bundleGroupId ? (bundleOrder.get(a.bundleGroupId) ?? a.sortIndex) : a.sortIndex;
    const bGroupSort = b.bundleGroupId ? (bundleOrder.get(b.bundleGroupId) ?? b.sortIndex) : b.sortIndex;

    if (aGroupSort !== bGroupSort) {
      return aGroupSort - bGroupSort;
    }

    if (a.bundleGroupId !== b.bundleGroupId) {
      if (a.bundleGroupId && !b.bundleGroupId) return -1;
      if (!a.bundleGroupId && b.bundleGroupId) return 1;
    }

    const skuDiff = a.sku.localeCompare(b.sku);
    if (skuDiff !== 0) return skuDiff;

    const nameDiff = a.productName.localeCompare(b.productName);
    if (nameDiff !== 0) return nameDiff;

    return a.sortIndex - b.sortIndex;
  });
  verifyCodeIndex = new Map();

  verifyItems.forEach((row) => {
    row.codes.forEach((code) => {
      if (!verifyCodeIndex.has(code)) {
        verifyCodeIndex.set(code, []);
      }
      verifyCodeIndex.get(code).push(row);
    });
  });

  if (initialProgressByItemKey && typeof initialProgressByItemKey === 'object') {
    verifyItems.forEach((row) => {
      const persisted = Number(initialProgressByItemKey[row.key]);
      if (!Number.isFinite(persisted)) return;
      row.scannedQty = Math.max(0, Math.min(row.requiredQty, Math.floor(persisted)));
    });
  }
}

function getVerifyTotals() {
  const totals = verifyItems.reduce((acc, row) => {
    acc.required += row.requiredQty;
    acc.scanned += row.scannedQty;
    return acc;
  }, { required: 0, scanned: 0 });

  totals.isComplete = totals.required > 0 && totals.scanned >= totals.required;
  return totals;
}

function getVerificationModeTitle() {
  return wholesaleModeEnabled ? 'Wholesale Build' : 'Verify Order';
}

function getVerificationVerb() {
  return wholesaleModeEnabled ? 'Built' : 'Scanned';
}

function getManualVerificationVerb() {
  return wholesaleModeEnabled ? 'Manual build' : 'Manual scan';
}

function getVerificationIncrementLabel(row, complete) {
  if (complete) {
    return wholesaleModeEnabled ? 'Built' : 'Complete';
  }
  if (!row?.codes || row.codes.size <= 0) {
    return 'Mark +1';
  }
  return wholesaleModeEnabled ? 'Build +1' : 'Scan +1';
}

function renderVerifyOrderCards() {
  const container = document.getElementById('pickListLineItems');
  if (!container) return;
  container.innerHTML = '';

  if (!verifyItems.length) {
    container.innerHTML = '<p class="pick-list-empty">No order line items found for verification.</p>';
    return;
  }

  const totals = getVerifyTotals();

  const summaryCard = document.createElement('article');
  summaryCard.className = `pick-list-card pick-verify-summary${totals.isComplete ? ' is-complete' : ''}`;
  summaryCard.innerHTML = `
    <header class="pick-list-card-header">
      <h3>${getVerificationModeTitle()}</h3>
      <p>${getVerificationVerb()} ${totals.scanned} of ${totals.required}${totals.isComplete ? ' - complete' : ''}</p>
    </header>
  `;
  container.appendChild(summaryCard);

  const listCard = document.createElement('article');
  listCard.className = 'pick-list-card';

  const list = document.createElement('div');
  list.className = 'pick-verify-list';

  let previousBundleGroupId = '';
  verifyItems.forEach((row, index) => {
    const bundleGroupId = String(row.bundleGroupId || '').trim();
    const bundleGroupTitle = String(row.bundleGroupTitle || '').trim();
    const bundleGroupQty = Number(row.bundleGroupQuantity) || null;
    const hasFollowingItem = index < verifyItems.length - 1;
    const nextBundleGroupId = String(verifyItems[index + 1]?.bundleGroupId || '').trim();
    if (bundleGroupId && bundleGroupId !== previousBundleGroupId) {
      const bundleMarker = document.createElement('div');
      bundleMarker.className = 'pick-verify-bundle-marker';
      const bundleLabel = bundleGroupTitle ? `Bundle: ${bundleGroupTitle}` : 'Bundle';
      bundleMarker.textContent = bundleGroupQty ? `${bundleLabel} x${bundleGroupQty}` : bundleLabel;
      list.appendChild(bundleMarker);
    }

    const complete = row.scannedQty >= row.requiredQty;
    const item = document.createElement('div');
    item.className = `pick-verify-item${complete ? ' is-complete' : ''}`;
    item.dataset.verifyKey = row.key;

    const info = document.createElement('div');
    info.className = 'pick-verify-item-info';

    const title = document.createElement('h3');
    title.textContent = row.productName;

    const meta = document.createElement('p');
    if (row.codes.size > 0) {
      const labels = [];
      if (row.sku && row.sku !== '(No SKU)') labels.push(`SKU: ${row.sku}`);
      if (row.upc) labels.push(`UPC: ${row.upc}`);
      meta.textContent = labels.join(' | ');
    } else {
      meta.textContent = wholesaleModeEnabled
        ? 'Manual build only (no SKU/UPC barcode)'
        : 'Manual verify only (no SKU/UPC barcode)';
    }

    info.appendChild(title);
    info.appendChild(meta);

    const progress = document.createElement('p');
    progress.className = 'pick-verify-item-progress';
    progress.textContent = `${row.scannedQty} / ${row.requiredQty}`;

    const actions = document.createElement('div');
    actions.className = 'pick-verify-item-actions';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pick-verify-item-btn';
    button.textContent = getVerificationIncrementLabel(row, complete);
    button.dataset.role = 'increment';
    button.dataset.complete = complete ? '1' : '0';
    button.disabled = loading || complete;
    button.addEventListener('click', () => {
      processVerifyManual(row.key);
    });

    const undoButton = document.createElement('button');
    undoButton.type = 'button';
    undoButton.className = 'pick-verify-item-btn pick-verify-item-btn--undo';
    undoButton.textContent = '-1';
    undoButton.dataset.role = 'undo';
    undoButton.dataset.canUndo = row.scannedQty > 0 ? '1' : '0';
    undoButton.disabled = loading || row.scannedQty <= 0;
    undoButton.addEventListener('click', () => {
      processVerifyUndo(row.key);
    });

    actions.appendChild(button);
    actions.appendChild(undoButton);

    item.appendChild(info);
    item.appendChild(progress);
    item.appendChild(actions);
    list.appendChild(item);

    if (bundleGroupId && bundleGroupId !== nextBundleGroupId && hasFollowingItem) {
      const bundleEndDivider = document.createElement('div');
      bundleEndDivider.className = 'pick-verify-bundle-end-divider';
      bundleEndDivider.textContent = 'End Bundle';
      list.appendChild(bundleEndDivider);
    }

    previousBundleGroupId = bundleGroupId;
    if (!bundleGroupId) {
      previousBundleGroupId = '';
    }
  });

  listCard.appendChild(list);
  container.appendChild(listCard);
  setActionButtonsEnabled(actionButtonsUnlocked);
}

function renderCurrentOrderSection() {
  if (isVerificationStyleModeEnabled()) {
    renderVerifyOrderCards();
    return;
  }
  renderLineCards(lastRenderedLineItems);
}

function getWholesaleProgressSnapshot() {
  const progressByItemKey = {};
  verifyItems.forEach((row) => {
    const qty = Math.max(0, Math.floor(Number(row.scannedQty) || 0));
    if (qty <= 0) return;
    progressByItemKey[row.key] = qty;
  });
  return progressByItemKey;
}

function updateWholesaleProgressCacheFromState() {
  lastWholesaleProgressByItemKey = getWholesaleProgressSnapshot();
}

async function flushWholesaleProgressSave(force = false) {
  if ((!wholesaleModeEnabled && !force) || !hasRenderedPickList || !currentOrderBarcode) return;

  if (wholesaleSaveInFlight) {
    wholesaleSaveQueued = true;
    return;
  }

  wholesaleSaveInFlight = true;
  wholesaleSaveQueued = false;

  try {
    const response = await fetch('/api/wholesale-progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        barcode: currentOrderBarcode,
        progressByItemKey: getWholesaleProgressSnapshot(),
      }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to save wholesale progress');
    }
  } catch (err) {
    console.error('Error saving wholesale progress:', err);
  } finally {
    wholesaleSaveInFlight = false;
    if (wholesaleSaveQueued) {
      wholesaleSaveQueued = false;
      flushWholesaleProgressSave();
    }
  }
}

function scheduleWholesaleProgressSave() {
  if (!wholesaleModeEnabled) return;

  updateWholesaleProgressCacheFromState();

  if (wholesaleSaveTimeoutId) {
    clearTimeout(wholesaleSaveTimeoutId);
  }

  wholesaleSaveTimeoutId = setTimeout(() => {
    wholesaleSaveTimeoutId = null;
    flushWholesaleProgressSave(false);
  }, 200);
}

function incrementVerifyRow(row) {
  if (!row) return { success: false, reason: 'missing_row' };
  if (row.scannedQty >= row.requiredQty) {
    return { success: false, reason: 'already_complete' };
  }
  row.scannedQty += 1;
  return { success: true, row };
}

function decrementVerifyRow(row) {
  if (!row) return { success: false, reason: 'missing_row' };
  if (row.scannedQty <= 0) {
    return { success: false, reason: 'already_zero' };
  }
  row.scannedQty -= 1;
  return { success: true, row };
}

function getVerifyDisplayLabel(row) {
  if (!row) return 'Item';
  if (row.sku && row.sku !== '(No SKU)') return row.sku;
  return row.productName || 'Item';
}

function processVerifyManual(key) {
  if (!isVerificationStyleModeEnabled()) return;
  if (isCurrentOrderWorkflowBlocked()) {
    showWorkflowBlockedWarning(currentWorkflowBlock?.message);
    return;
  }

  const row = verifyItems.find((item) => item.key === key);
  if (!row) {
    setStatus('Error: Verification item not found.', 'error');
    return;
  }

  const result = incrementVerifyRow(row);
  if (!result.success) {
    setStatus(`${getVerifyDisplayLabel(row)} is already fully scanned.`, 'info');
    return;
  }

  renderVerifyOrderCards();
  scheduleWholesaleProgressSave();
  const totals = getVerifyTotals();
  if (totals.isComplete) {
    playVerifyCompleteSound();
    if (wholesaleModeEnabled) {
      setStatus(`Wholesale build complete for ${currentOrderNumber} (${totals.scanned}/${totals.required}).`, 'success');
    } else {
      setStatus(`Order ${currentOrderNumber} fully verified (${totals.scanned}/${totals.required}).`, 'success');
    }
  } else {
    playVerifyScanSound();
    setStatus(`${getManualVerificationVerb()}: ${getVerifyDisplayLabel(row)} (${row.scannedQty}/${row.requiredQty}).`, 'success');
  }
}

function processVerifyUndo(key) {
  if (!isVerificationStyleModeEnabled()) return;
  if (isCurrentOrderWorkflowBlocked()) {
    showWorkflowBlockedWarning(currentWorkflowBlock?.message);
    return;
  }

  const row = verifyItems.find((item) => item.key === key);
  if (!row) {
    setStatus('Error: Verification item not found.', 'error');
    return;
  }

  const result = decrementVerifyRow(row);
  if (!result.success) {
    setStatus(`${getVerifyDisplayLabel(row)} is already at 0.`, 'info');
    return;
  }

  renderVerifyOrderCards();
  scheduleWholesaleProgressSave();
  const totals = getVerifyTotals();
  setStatus(`Undo: ${getVerifyDisplayLabel(row)} (${row.scannedQty}/${row.requiredQty}).`, totals.isComplete ? 'success' : 'info');
}

function processVerifyScan(scannedCode) {
  if (!isVerificationStyleModeEnabled()) return false;
  if (isCurrentOrderWorkflowBlocked()) {
    showWorkflowBlockedWarning(currentWorkflowBlock?.message);
    return true;
  }

  const codeVariants = expandVerifyCodeVariants(scannedCode);
  const normalizedCode = codeVariants[0] || '';
  if (!normalizedCode) {
    setStatus('Error: Empty scan received.', 'error');
    return true;
  }

  const rowKeySeen = new Set();
  const candidates = [];
  codeVariants.forEach((variant) => {
    const variantCandidates = verifyCodeIndex.get(variant) || [];
    variantCandidates.forEach((row) => {
      if (rowKeySeen.has(row.key)) return;
      rowKeySeen.add(row.key);
      candidates.push(row);
    });
  });

  if (!candidates.length) {
    setStatus(`Error: ${normalizedCode} is not on this order.`, 'error');
    return true;
  }

  const target = candidates.find((row) => row.scannedQty < row.requiredQty) || candidates[0];
  const result = incrementVerifyRow(target);

  if (!result.success) {
    setStatus(`${getVerifyDisplayLabel(target)} is already fully scanned.`, 'info');
    return true;
  }

  renderVerifyOrderCards();
  scheduleWholesaleProgressSave();
  const totals = getVerifyTotals();

  if (totals.isComplete) {
    playVerifyCompleteSound();
    if (wholesaleModeEnabled) {
      setStatus(`Wholesale build complete for ${currentOrderNumber} (${totals.scanned}/${totals.required}).`, 'success');
    } else {
      setStatus(`Order ${currentOrderNumber} fully verified (${totals.scanned}/${totals.required}).`, 'success');
    }
  } else {
    playVerifyScanSound();
    setStatus(`${getVerificationVerb()} ${getVerifyDisplayLabel(target)} (${target.scannedQty}/${target.requiredQty}).`, 'success');
  }

  return true;
}

function openAwaitingPartsDialog(orderId, lineItems) {
  const modal = document.getElementById('awaitingPartsModal');
  const form = document.getElementById('awaitingPartsForm');
  if (!modal || !form) return;

  form.innerHTML = '';

  const uniqueSkuItems = [];
  const seenSkus = new Set();

  (lineItems || []).forEach((item) => {
    if (!item || !item.sku) return;
    if (seenSkus.has(item.sku)) return;
    seenSkus.add(item.sku);
    uniqueSkuItems.push(item);
  });

  uniqueSkuItems.forEach((item) => {
    const label = document.createElement('label');
    label.className = 'pick-modal-item';
    const currentQty = getAwaitingPartsQty(item.sku);
    const lineQty = Math.max(1, Number(item.quantity) || 1);
    const maxQty = Math.max(lineQty, currentQty || 0, 1);
    const defaultQty = currentQty > 0 ? currentQty : lineQty;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = item.sku;
    checkbox.checked = currentQty > 0;

    const body = document.createElement('div');
    body.className = 'pick-modal-item__body';

    const text = document.createElement('span');
    text.textContent = `${item.sku} — ${item.title || ''}`;

    const qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.className = 'pick-modal-qty';
    qtyInput.min = '1';
    qtyInput.step = '1';
    qtyInput.max = String(maxQty);
    qtyInput.value = String(defaultQty);
    qtyInput.dataset.sku = item.sku;
    qtyInput.disabled = !checkbox.checked;

    checkbox.addEventListener('change', () => {
      qtyInput.disabled = !checkbox.checked;
    });

    body.appendChild(text);
    body.appendChild(qtyInput);
    label.appendChild(checkbox);
    label.appendChild(body);
    form.appendChild(label);
  });

  form.dataset.orderId = orderId;
  modal.classList.add('is-open');
}

function closeAwaitingPartsDialog() {
  const modal = document.getElementById('awaitingPartsModal');
  const form = document.getElementById('awaitingPartsForm');

  if (modal) modal.classList.remove('is-open');
  if (form) {
    form.innerHTML = '';
    form.dataset.orderId = '';
  }
}

async function submitAwaitingParts() {
  const form = document.getElementById('awaitingPartsForm');
  if (!form) return;

  const orderId = form.dataset.orderId;
  const items = Array.from(form.querySelectorAll('input[type="checkbox"]:checked')).map((input) => {
    const sku = input.value;
    const qtyInput = form.querySelector(`.pick-modal-qty[data-sku="${CSS.escape(sku)}"]`);
    return {
      sku,
      quantity: Math.max(1, Number(qtyInput?.value) || 1),
    };
  });

  if (!orderId) {
    setStatus('Error: Missing order id for awaiting parts.', 'error');
    return;
  }

  if (!items.length) {
    setStatus('Select at least one SKU for awaiting parts.', 'error');
    return;
  }

  if (loading) return;

  setLoading(true);
  try {
    const response = await fetch('/api/awaiting-parts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, items }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to save awaiting parts');
    }

    setCurrentAwaitingPartsItems(Array.isArray(data.awaitingPartsSelection) ? data.awaitingPartsSelection : items);
    if (hasRenderedPickList) {
      renderCurrentOrderSection();
    }
    setStatus(`Awaiting parts saved for ${data.orderNumber || currentOrderNumber}.`, 'success');
    closeAwaitingPartsDialog();
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

function openQcFailDialog(orderId, lineItems) {
  const modal = document.getElementById('qcFailModal');
  const skuSelect = document.getElementById('qcFailSku');
  const reasonInput = document.getElementById('qcFailReason');
  if (!modal || !skuSelect || !reasonInput) return;

  skuSelect.innerHTML = '';

  const uniqueSkuItems = [];
  const seenSkus = new Set();

  (lineItems || []).forEach((item) => {
    if (!item || !item.sku) return;
    if (seenSkus.has(item.sku)) return;
    seenSkus.add(item.sku);
    uniqueSkuItems.push(item);
  });

  uniqueSkuItems.forEach((item) => {
    const option = document.createElement('option');
    option.value = item.sku;
    option.textContent = `${item.sku} — ${item.title || ''}`;
    skuSelect.appendChild(option);
  });

  if (!uniqueSkuItems.length) {
    setStatus('Error: No SKU found on this order to mark as QC fail.', 'error');
    return;
  }

  skuSelect.dataset.orderId = orderId;
  reasonInput.value = '';
  modal.classList.add('is-open');
}

function closeQcFailDialog() {
  const modal = document.getElementById('qcFailModal');
  const skuSelect = document.getElementById('qcFailSku');
  const reasonInput = document.getElementById('qcFailReason');

  if (modal) modal.classList.remove('is-open');
  if (skuSelect) {
    skuSelect.innerHTML = '';
    skuSelect.dataset.orderId = '';
  }
  if (reasonInput) reasonInput.value = '';
}

async function submitQcFail() {
  const skuSelect = document.getElementById('qcFailSku');
  const reasonInput = document.getElementById('qcFailReason');
  if (!skuSelect || !reasonInput) return;

  const orderId = skuSelect.dataset.orderId;
  const sku = skuSelect.value;
  const reason = reasonInput.value.trim();

  if (!orderId) {
    setStatus('Error: Missing order id for QC fail.', 'error');
    return;
  }

  if (!sku) {
    setStatus('Select a SKU for QC fail.', 'error');
    return;
  }

  if (!reason) {
    setStatus('Enter a reason for QC fail.', 'error');
    return;
  }

  if (loading) return;

  setLoading(true);
  try {
    const response = await fetch('/api/qc-fail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, sku, reason }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to save QC fail');
    }

    setStatus(
      `QC fail saved for ${sku}: ${reason}. Last waiting_qc by: ${data.latestWaitingQcStaff || 'No waiting_qc record found'}`,
      'success'
    );
    closeQcFailDialog();
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

async function runOrderAction(tag) {
  const normalizedBarcode = String(currentOrderBarcode || '').trim().toUpperCase();
  if (!normalizedBarcode) {
    setStatus('Scan an order first to enable actions.', 'error');
    focusBarcodeInput({ selectAll: true });
    return;
  }

  if (isCurrentOrderWorkflowBlocked()) {
    showWorkflowBlockedWarning(currentWorkflowBlock?.message);
    return;
  }

  if (tag === 'packaged' && isPackagedActionLocked()) {
    setStatus('Complete Verify Order before marking this order as Packaged.', 'error');
    return;
  }

  if (loading || isAnyDialogOpen()) return;

  const isDuplicate =
    lastActionTag === tag &&
    lastActionBarcode === normalizedBarcode &&
    !NON_DEDUPE_ACTION_TAGS.has(tag);

  if (isDuplicate) {
    setStatus(`Skipped duplicate action: ${formatActionLabel(tag)}.`, 'info');
    return;
  }

  setLoading(true);
  setStatus(`Applying ${formatActionLabel(tag)}...`, 'info');

  try {
    const response = await fetch('/api/tag-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barcode: normalizedBarcode, tag }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to apply action');
    }

    lastActionTag = tag;
    lastActionBarcode = normalizedBarcode;

    if (tag === 'wholesale_adapter_built') {
      setStatus(
        `Order ${data.orderNumber} adapter built by ${data.staff}. Total scans: ${data.wholesaleAdapterBuiltCount ?? 1}`,
        'success'
      );
    } else {
      setStatus(`Order ${data.orderNumber} tagged ${tag} successfully by ${data.staff}`, 'success');
    }

    if (tag === 'awaiting_parts') {
      openAwaitingPartsDialog(normalizedBarcode, data.lineItems || []);
    } else if (tag === 'qc_fail') {
      openQcFailDialog(normalizedBarcode, data.lineItems || []);
    } else if (hasRenderedPickList) {
      setCurrentAwaitingPartsItems([]);
      renderCurrentOrderSection();
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

async function fetchPickList(barcodeInput) {
  const barcode = String(barcodeInput || '').trim().toUpperCase();
  if (!barcode) {
    setStatus('Enter or scan an order barcode.', 'error');
    return;
  }

  if (!barcode.startsWith('AT') && !barcode.startsWith('#')) {
    setStatus('Invalid code. Scan an AT barcode or open by Shopify order number.', 'error');
    return;
  }

  if (loading || isAnyDialogOpen()) return;

  setLoading(true);
  setStatus('Loading order and building pick list...', 'info');

  try {
    const response = await fetch('/api/pick-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barcode }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      if (data.workflowBlocked) {
        clearLoadedOrderState();
        playVerifyErrorSound();
        setStatus(data.error || 'This order cannot be picked or built.', 'error');
        return;
      }

      if (response.status === 404) {
        clearLoadedOrderState();
      }

      throw new Error(data.error || 'Failed to load pick list');
    }

    currentOrderBarcode = data.barcode;
    currentOrderNumber = data.orderNumber;
    currentOrderNote = data.orderNote || '';
    currentTrackerUrl = String(data.trackerUrl || '').trim();
    setCurrentAwaitingPartsItems(Array.isArray(data.awaitingPartsItems) ? data.awaitingPartsItems : []);
    currentWorkflowBlock = data.workflowBlocked
      ? {
          blocked: true,
          code: data.workflowBlockCode || '',
          status: data.workflowStatus || '',
          message: data.workflowWarning || data.error || 'This order cannot be picked or built.',
        }
      : null;
    setActionButtonsEnabled(true);

    const orderMeta = document.getElementById('pickListOrderMeta');
    orderMeta.textContent = `${data.orderNumber} (${data.barcode})`;
    renderWorkflowAlert();
    renderTrackerLink();

    lastRenderedLineItems = Array.isArray(data.lineItems) ? data.lineItems : [];
    lastOrderItems = Array.isArray(data.orderItems) ? data.orderItems : [];
    lastWholesaleProgressByItemKey =
      data.wholesaleProgressByItemKey && typeof data.wholesaleProgressByItemKey === 'object'
        ? data.wholesaleProgressByItemKey
        : {};
    buildVerifyState(lastOrderItems, wholesaleModeEnabled ? lastWholesaleProgressByItemKey : null);
    hasRenderedPickList = true;
    renderCurrentOrderSection();
    renderOrderTimeline();

    const barcodeInputEl = document.getElementById('pickListBarcode');
    if (barcodeInputEl) {
      barcodeInputEl.value = '';
    }
    focusBarcodeInput();

    if (currentWorkflowBlock) {
      showWorkflowBlockedWarning(currentWorkflowBlock.message);
      return;
    }

    const noteState = data.notesEnabled
      ? (data.notesLoaded ? ' Notes loaded.' : ' Notes unavailable for this refresh.')
      : '';
    const bundleState = data.bundleMetadataSupported === false
      ? ' Bundle grouping unavailable from Shopify API for this shop version.'
      : '';
    setStatus(`Pick list ready. Sheet rows loaded: ${data.sheetSkuCount}.${noteState}${bundleState}`, 'success');
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
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
  const MIN_SCAN_LENGTH = 3;

  document.addEventListener('keydown', (event) => {
    if (loading || isAnyDialogOpen()) return;

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
        const input = document.getElementById('pickListBarcode');
        const normalized = normalizeVerifyCode(scannedCode);
        const isOrderCode = normalized.startsWith('AT');

        if (isVerificationStyleModeEnabled() && hasRenderedPickList && !isOrderCode) {
          processVerifyScan(scannedCode);
          return;
        }

        if (input) {
          input.value = scannedCode;
        }
        fetchPickList(scannedCode);
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

function registerModalHandlers() {
  const awaitingPartsModal = document.getElementById('awaitingPartsModal');
  const qcFailModal = document.getElementById('qcFailModal');

  const awaitingCancel = document.getElementById('awaitingPartsCancelBtn');
  const awaitingConfirm = document.getElementById('awaitingPartsConfirmBtn');
  const qcCancel = document.getElementById('qcFailCancelBtn');
  const qcConfirm = document.getElementById('qcFailConfirmBtn');

  if (awaitingCancel) awaitingCancel.addEventListener('click', closeAwaitingPartsDialog);
  if (awaitingConfirm) awaitingConfirm.addEventListener('click', submitAwaitingParts);
  if (qcCancel) qcCancel.addEventListener('click', closeQcFailDialog);
  if (qcConfirm) qcConfirm.addEventListener('click', submitQcFail);

  if (awaitingPartsModal) {
    awaitingPartsModal.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        closeAwaitingPartsDialog();
      }
    });
  }

  if (qcFailModal) {
    qcFailModal.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        closeQcFailDialog();
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const shopCookie = document.cookie.split('; ').find((c) => c.startsWith('shop='));
  if (!shopCookie) {
    window.location.href = '/';
    return;
  }

  const input = document.getElementById('pickListBarcode');
  const button = document.getElementById('pickListFetchBtn');
  const pickerModeToggle = document.getElementById('pickerModeToggle');
  const verifyModeToggle = document.getElementById('verifyModeToggle');
  const wholesaleModeToggle = document.getElementById('wholesaleModeToggle');
  const trackerCopyButton = document.getElementById('pickListTrackerCopyBtn');

  actionButtons = Array.from(document.querySelectorAll('.pick-list-action-btn'));
  setActionButtonsEnabled(false);
  syncActionVisibilityForModes();

  actionButtons.forEach((actionButton) => {
    actionButton.addEventListener('click', () => {
      const tag = actionButton.dataset.orderAction;
      if (!tag) return;
      runOrderAction(tag);
    });
  });

  if (button) {
    button.addEventListener('click', () => fetchPickList(input?.value || ''));
  }

  if (trackerCopyButton) {
    trackerCopyButton.addEventListener('click', async () => {
      if (!currentTrackerUrl) return;

      try {
        await navigator.clipboard.writeText(currentTrackerUrl);
        setStatus('Customer tracker link copied.', 'success');
      } catch (err) {
        setStatus('Could not copy the tracker link.', 'error');
      }
    });
  }

  if (input) {
    input.addEventListener('focus', () => focusBarcodeInput({ selectAll: true }));
    input.addEventListener('click', () => focusBarcodeInput({ selectAll: true }));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const rawValue = input.value;
        const normalized = normalizeVerifyCode(rawValue);
        const isOrderCode = normalized.startsWith('AT');

        if (isVerificationStyleModeEnabled() && hasRenderedPickList && !isOrderCode) {
          processVerifyScan(rawValue);
          input.value = '';
          focusBarcodeInput();
          return;
        }

        fetchPickList(rawValue);
      }
    });
  }

  pickerModeEnabled = getCookieValue(PICKER_MODE_COOKIE) === '1';
  verifyModeEnabled = getCookieValue(VERIFY_MODE_COOKIE) === '1';
  wholesaleModeEnabled = getCookieValue(WHOLESALE_MODE_COOKIE) === '1';

  if (wholesaleModeEnabled) {
    pickerModeEnabled = false;
    verifyModeEnabled = false;
  } else if (pickerModeEnabled && verifyModeEnabled) {
    verifyModeEnabled = false;
    setCookieValue(VERIFY_MODE_COOKIE, '0');
  }

  const syncVerificationStateForMode = () => {
    if (!hasRenderedPickList || !isVerificationStyleModeEnabled()) return;
    buildVerifyState(lastOrderItems, wholesaleModeEnabled ? lastWholesaleProgressByItemKey : null);
  };

  const applyModeState = () => {
    if (!wholesaleModeEnabled && wholesaleSaveTimeoutId) {
      clearTimeout(wholesaleSaveTimeoutId);
      wholesaleSaveTimeoutId = null;
      flushWholesaleProgressSave(true);
    }

    if (pickerModeToggle) pickerModeToggle.checked = pickerModeEnabled;
    if (verifyModeToggle) verifyModeToggle.checked = verifyModeEnabled;
    if (wholesaleModeToggle) wholesaleModeToggle.checked = wholesaleModeEnabled;

    setCookieValue(PICKER_MODE_COOKIE, pickerModeEnabled ? '1' : '0');
    setCookieValue(VERIFY_MODE_COOKIE, verifyModeEnabled ? '1' : '0');
    setCookieValue(WHOLESALE_MODE_COOKIE, wholesaleModeEnabled ? '1' : '0');

    syncActionVisibilityForModes();
    setActionButtonsEnabled(actionButtonsUnlocked);
    syncVerificationStateForMode();
    if (hasRenderedPickList) {
      renderCurrentOrderSection();
      renderOrderTimeline();
    }
  };

  if (verifyModeToggle) {
    verifyModeToggle.checked = verifyModeEnabled;
    verifyModeToggle.addEventListener('change', () => {
      verifyModeEnabled = Boolean(verifyModeToggle.checked);
      if (verifyModeEnabled) {
        pickerModeEnabled = false;
        wholesaleModeEnabled = false;
      }
      applyModeState();
    });
  }

  if (wholesaleModeToggle) {
    wholesaleModeToggle.checked = wholesaleModeEnabled;
    wholesaleModeToggle.addEventListener('change', () => {
      wholesaleModeEnabled = Boolean(wholesaleModeToggle.checked);
      if (wholesaleModeEnabled) {
        pickerModeEnabled = false;
        verifyModeEnabled = false;
      }
      applyModeState();
    });
  }

  if (pickerModeToggle) {
    pickerModeToggle.checked = pickerModeEnabled;
    pickerModeToggle.addEventListener('change', () => {
      pickerModeEnabled = Boolean(pickerModeToggle.checked);
      if (pickerModeEnabled) {
        verifyModeEnabled = false;
        wholesaleModeEnabled = false;
      }
      applyModeState();
    });
  } else {
    applyModeState();
  }

  if (pickerModeToggle) {
    applyModeState();
  }

  registerModalHandlers();
  setupHidScan();

  const initialOrderLookup = getInitialOrderLookupValue();
  if (initialOrderLookup && input) {
    input.value = initialOrderLookup;
    fetchPickList(initialOrderLookup);
    return;
  }

  if (input && window.matchMedia('(min-width: 900px)').matches) {
    setTimeout(() => focusBarcodeInput({ selectAll: true }), 0);
  }
});
