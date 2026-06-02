let loading = false;
let hidBuffer = '';
let hidLastKeyAt = 0;
let hidBufferTimeoutId = null;
let pickerModeEnabled = false;
let verifyModeEnabled = false;
let wholesaleModeEnabled = false;
let qcModeEnabled = false;
let lastRenderedLineItems = [];
let lastOrderItems = [];
let lastWholesaleProgressByItemKey = {};
let lastVerifyProgressByItemKey = {};
let hasRenderedPickList = false;
let currentOrderBarcode = '';
let currentOrderNumber = '';
let currentOrderNote = '';
let currentOrderTimeline = [];
let currentWorkflowBlock = null;
let currentOrderTags = [];
let currentOrderStatus = '';
let currentOrderFinancialStatus = '';
let currentOrderStageKey = '';
let currentOrderStageLabel = '';
let currentQcBuilderStaff = '';
let currentHpaTankShippingWarning = null;
let currentWholesaleOrderWarning = null;
let hpaTankRegRemovalAlertedKeys = new Set();
let currentAwaitingPartsSkuMap = new Map();
let currentAwaitingPartsCatalog = new Map();
let currentPickedRowCounts = new Map();
let lastActionTag = '';
let lastActionBarcode = '';
let pendingActionReminderTarget = null;
let suppressNextActionReminderUnload = false;
let actionButtons = [];
let actionButtonsUnlocked = false;
let verifyItems = [];
let verifyCodeIndex = new Map();
let verifyAudioContext = null;
let wholesaleSaveTimeoutId = null;
let wholesaleSaveInFlight = false;
let wholesaleSaveQueued = false;
let verifySaveTimeoutId = null;
let verifySaveInFlight = false;
let verifySaveQueued = false;
let pickedRowsSaveTimeoutId = null;
let pickedRowsSaveInFlight = false;
let pickedRowsSaveQueued = false;
let shippingPanelState = createShippingPanelInitialState();
let shippingLookupInFlight = false;
let shippingRequestToken = 0;
let verifyShippingPreloadTimeoutId = null;
let verifyShippingAutoRateTimeoutId = null;
let activeShippingWeightPackageIndex = null;
let suppressShippingWeightBlurRefresh = false;
let bagLabelRows = [];
let bagLabelActionLoading = '';

const PICKER_MODE_COOKIE = 'pick_list_picker_mode';
const VERIFY_MODE_COOKIE = 'pick_list_verify_mode';
const WHOLESALE_MODE_COOKIE = 'pick_list_wholesale_mode';
const QC_MODE_COOKIE = 'pick_list_qc_mode';
const NON_DEDUPE_ACTION_TAGS = new Set(['awaiting_parts', 'qc_fail', 'wholesale_adapter_built', 'on_hold']);
const HPA_TANK_REG_REMOVAL_SKUS = new Set(['T1P_TANK-1', 'T1P_TANK-2']);
const SHIPPING_PACKAGE_DIMENSION_UNIT = 'centimeter';
const SHIPPING_PACKAGE_PRESETS = [
  { key: 'small', label: 'Small', length: 23, width: 16, height: 17 },
  { key: 'medium', label: 'Medium', length: 30, width: 20, height: 20 },
  { key: 'wholesale', label: 'Wholesale', length: 51, width: 31, height: 31 },
  { key: 'tank_box', label: 'Tank Box', length: 50, width: 75, height: 75 },
  { key: 'custom', label: 'Custom', custom: true },
];

function appendOrderNoteWarning(message, data) {
  const warning = String(data?.orderNoteWarning || '').trim();
  return warning ? `${message} Note was not updated: ${warning}` : message;
}

function appendGeckoboardWarning(message, data) {
  const warning = String(data?.geckoboardEventWarning || '').trim();
  return warning ? `${message} Geckoboard event was not sent: ${warning}` : message;
}

function appendActionWarnings(message, data) {
  return appendGeckoboardWarning(appendOrderNoteWarning(message, data), data);
}

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

function focusBarcodeInput({ selectAll = false, preventScroll = false } = {}) {
  const input = document.getElementById('pickListBarcode');
  if (!input) return;
  try {
    input.focus({ preventScroll });
  } catch (_err) {
    input.focus();
  }
  if (selectAll) {
    input.select();
  }
}

function refocusBarcodeInputForScanner() {
  window.setTimeout(() => focusBarcodeInput({ preventScroll: true }), 0);
}

function scrollPickListToTop() {
  window.scrollTo({
    top: 0,
    left: 0,
    behavior: 'smooth',
  });
}

function getInitialOrderLookupValue() {
  const params = new URLSearchParams(window.location.search);
  return String(params.get('order') || params.get('barcode') || '').trim().toUpperCase();
}

function setOrderLookupInUrl(value) {
  const url = new URL(window.location.href);
  const normalizedValue = String(value || '').trim().toUpperCase();

  if (normalizedValue) {
    url.searchParams.set('order', normalizedValue);
  } else {
    url.searchParams.delete('order');
  }
  url.searchParams.delete('barcode');

  const nextSearch = url.searchParams.toString();
  const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash}`;
  window.history.replaceState({}, '', nextUrl);
}

function normalizeDisplaySku(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeHpaTankWarning(warning) {
  if (!warning || typeof warning !== 'object' || warning.active === false) return null;
  const skus = Array.isArray(warning.skus)
    ? Array.from(new Set(warning.skus.map(normalizeDisplaySku).filter(Boolean)))
    : [];
  const items = Array.isArray(warning.items) ? warning.items : [];
  if (!skus.length && !items.length) return null;
  return {
    active: true,
    countryCode: normalizeDisplaySku(warning.countryCode),
    countryName: String(warning.countryName || '').trim(),
    message: String(warning.message || 'Take to a team member to get reg removed').trim(),
    skus,
    items,
  };
}

function setHpaTankShippingWarning(warning) {
  currentHpaTankShippingWarning = normalizeHpaTankWarning(warning);
  hpaTankRegRemovalAlertedKeys = new Set();
}

function normalizeWholesaleOrderWarning(warning) {
  if (!warning || typeof warning !== 'object' || warning.active === false) return null;
  return {
    active: true,
    source: String(warning.source || '').trim(),
    companyName: String(warning.companyName || '').trim(),
    locationName: String(warning.locationName || '').trim(),
    title: String(warning.title || 'Wholesale order').trim(),
    message: String(
      warning.message || 'Print bag topper labels before dispatch. A team member can help you apply them.'
    ).trim(),
  };
}

function setWholesaleOrderWarning(warning) {
  currentWholesaleOrderWarning = normalizeWholesaleOrderWarning(warning);
}

function hasHpaTankShippingWarning() {
  return Boolean(currentHpaTankShippingWarning?.active);
}

function isHpaTankWarningSku(sku) {
  const normalizedSku = normalizeDisplaySku(sku);
  if (!normalizedSku) return false;
  return HPA_TANK_REG_REMOVAL_SKUS.has(normalizedSku)
    && hasHpaTankShippingWarning()
    && currentHpaTankShippingWarning.skus.includes(normalizedSku);
}

function isHpaTankPickRow(row) {
  if (!hasHpaTankShippingWarning() || !row) return false;
  return isHpaTankWarningSku(row.sku);
}

function isAwaitingPartsSku(value) {
  return currentAwaitingPartsSkuMap.has(normalizeDisplaySku(value));
}

function getAwaitingPartsQty(value) {
  return currentAwaitingPartsSkuMap.get(normalizeDisplaySku(value)) || 0;
}

function getAwaitingPartsTargetQty(value) {
  return currentAwaitingPartsCatalog.get(normalizeDisplaySku(value))?.quantity || 0;
}

function getCurrentAwaitingPartsSelection() {
  return Array.from(currentAwaitingPartsSkuMap.entries())
    .map(([sku, quantity]) => ({
      sku,
      quantity: Math.max(1, Number(quantity) || 1),
    }))
    .sort((left, right) => left.sku.localeCompare(right.sku));
}

function setCurrentAwaitingPartsItems(items) {
  currentAwaitingPartsSkuMap = new Map();

  (items || []).forEach((item) => {
    const sku = normalizeDisplaySku(item?.sku || item?.partSku);
    if (!sku) return;
    const quantity = Math.max(1, Number(item?.quantity) || 1);
    currentAwaitingPartsSkuMap.set(sku, (currentAwaitingPartsSkuMap.get(sku) || 0) + quantity);
  });
}

function buildAwaitingPartsCatalog(lineItems) {
  const catalog = new Map();

  const addRowToCatalog = (row, contextLabel) => {
    const sku = normalizeDisplaySku(row?.sku);
    const quantity = Math.max(1, Number(row?.quantity) || 1);
    if (!sku) return;

    if (!catalog.has(sku)) {
      catalog.set(sku, {
        sku,
        quantity: 0,
        contexts: [],
        location: String(row?.location || '').trim(),
        note: String(row?.note || '').trim(),
        type: String(row?.type || '').trim(),
      });
    }

    const existing = catalog.get(sku);
    existing.quantity += quantity;

    if (contextLabel && !existing.contexts.includes(contextLabel)) {
      existing.contexts.push(contextLabel);
    }
    if (!existing.location) {
      existing.location = String(row?.location || '').trim();
    }
    if (!existing.note) {
      existing.note = String(row?.note || '').trim();
    }
    if (!existing.type) {
      existing.type = String(row?.type || '').trim();
    }
  };

  (lineItems || []).forEach((line) => {
    const lineSku = normalizeDisplaySku(line?.sku);
    const lineQty = Math.max(1, Number(line?.quantity) || 1);
    const lineTitleParts = [
      lineSku ? `${lineSku}${lineQty > 1 ? ` x${lineQty}` : ''}` : '',
      String(line?.title || '').trim(),
      String(line?.variantTitle || '').trim(),
    ].filter(Boolean);
    const lineLabel = lineTitleParts.join(' — ');

    [
      ['Must Pick', line?.mustPick],
      ['Desk Items', line?.deskItems],
      ['Needs Review', line?.reviewItems],
    ].forEach(([sectionLabel, rows]) => {
      (rows || []).forEach((row) => {
        addRowToCatalog(row, [sectionLabel, lineLabel].filter(Boolean).join(' • '));
      });
    });
  });

  return catalog;
}

function refreshAwaitingPartsCatalog(lineItems = lastRenderedLineItems) {
  currentAwaitingPartsCatalog = buildAwaitingPartsCatalog(lineItems);
}

function syncAwaitingToggleDisabledState() {
  const disabled = loading || isCurrentOrderWorkflowBlocked();
  document.querySelectorAll('.pick-list-awaiting-toggle').forEach((button) => {
    button.disabled = disabled;
  });
  document.querySelectorAll('.pick-list-getting-low-btn').forEach((button) => {
    button.disabled = disabled;
  });
}

function setStatus(message, type = 'info') {
  const el = document.getElementById('pickListStatus');
  if (!el) return;
  el.textContent = message;
  el.dataset.type = type;
}

function createShippingPanelInitialState(barcode = currentOrderBarcode) {
  return {
    barcode: String(barcode || '').trim().toUpperCase(),
    status: 'idle',
    actionLoading: '',
    error: '',
    orderNumber: '',
    payment: null,
    shipment: null,
    selectedAttemptLabel: '',
    attemptedIdentifiers: [],
    attemptedQueries: [],
    rates: [],
    selectedQuoteId: '',
    expiresAt: '',
    noRateReason: '',
    rateInputSignature: '',
    rateDiagnostics: null,
    label: null,
    reusedExistingLabel: false,
    weightGrams: '',
    packagePresetKey: '',
    packageDimensions: {
      length: '',
      width: '',
      height: '',
      unit: 'centimeter',
    },
    packages: [],
  };
}

function resetShippingPanelState(barcode = currentOrderBarcode) {
  shippingPanelState = createShippingPanelInitialState(barcode);
  shippingLookupInFlight = false;
  activeShippingWeightPackageIndex = null;
  shippingRequestToken += 1;
  if (verifyShippingPreloadTimeoutId) {
    window.clearTimeout(verifyShippingPreloadTimeoutId);
    verifyShippingPreloadTimeoutId = null;
  }
  if (verifyShippingAutoRateTimeoutId) {
    window.clearTimeout(verifyShippingAutoRateTimeoutId);
    verifyShippingAutoRateTimeoutId = null;
  }
}

function setShippingPanelState(patch = {}) {
  shippingPanelState = {
    ...shippingPanelState,
    ...patch,
    barcode: String(patch.barcode || shippingPanelState.barcode || currentOrderBarcode || '').trim().toUpperCase(),
  };
}

function getCurrentOrderStageKey() {
  return String(currentOrderStageKey || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function canBuyShippingLabelForCurrentOrder() {
  return ['packaged', 'fulfilled', 'partially_fulfilled'].includes(getCurrentOrderStageKey());
}

function getShippingPurchaseLockedMessage() {
  return 'Mark this order as Packaged before buying a shipping label.';
}

function formatShippingMoney(amount, currency) {
  const numericAmount = Number(amount || 0);
  const safeCurrency = String(currency || '').trim().toUpperCase();
  if (!safeCurrency) return numericAmount.toFixed(2);

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: safeCurrency,
    }).format(numericAmount);
  } catch (err) {
    return `${safeCurrency} ${numericAmount.toFixed(2)}`;
  }
}

function formatShippingService(entity) {
  const carrier = String(entity?.carrierName || entity?.carrierFriendlyName || entity?.carrierCode || '').trim();
  const service = String(entity?.serviceName || entity?.serviceType || entity?.serviceCode || '').trim();
  return [carrier, service].filter(Boolean).join(' - ') || 'Selected service';
}

function formatShippingServiceCode(value) {
  return String(value || '').trim().toUpperCase() || 'Not set';
}

function formatRequestedShippingService(shipment) {
  return String(shipment?.requestedShipmentService || shipment?.serviceType || '').trim() || 'Not set';
}

function formatShippingCountryName(countryCode) {
  const code = String(countryCode || '').trim().toUpperCase();
  if (!code) return '';

  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
      const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
      const countryName = regionNames.of(code);
      if (countryName && countryName !== code) {
        return countryName.toUpperCase();
      }
    }
  } catch (err) {
    // Fall through to known country-code labels.
  }

  const fallbackNames = {
    GB: 'UNITED KINGDOM',
    UK: 'UNITED KINGDOM',
    US: 'UNITED STATES',
    IE: 'IRELAND',
    FR: 'FRANCE',
    DE: 'GERMANY',
    ES: 'SPAIN',
    IT: 'ITALY',
    NL: 'NETHERLANDS',
  };
  return fallbackNames[code] || code;
}

function getShippingOrderCountryLabel() {
  return formatShippingCountryName(shippingPanelState.shipment?.shipTo?.countryCode);
}

function getVerifyShippingModalTitle() {
  const orderLabel = shippingPanelState.orderNumber || currentOrderNumber || currentOrderBarcode || 'Shipping';
  const countryLabel = getShippingOrderCountryLabel();
  return countryLabel ? `${orderLabel} - ${countryLabel}` : orderLabel;
}

function formatShippingMetaValue(value) {
  return String(value || '')
    .trim()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getPrimaryShippingPackage(shipment) {
  return Array.isArray(shipment?.packages) && shipment.packages.length
    ? shipment.packages[0]
    : null;
}

function normalizeShippingDimension(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return Number.isInteger(numeric) ? String(numeric) : String(Number(numeric.toFixed(2)));
}

function getPresetDimensions(presetKey) {
  const preset = SHIPPING_PACKAGE_PRESETS.find((item) => item.key === presetKey);
  if (!preset || preset.custom) return null;
  return {
    length: preset.length,
    width: preset.width,
    height: preset.height,
    unit: SHIPPING_PACKAGE_DIMENSION_UNIT,
  };
}

function formatShippingPresetOptionLabel(preset) {
  if (!preset || preset.custom) return preset?.label || 'Custom';
  return `${preset.label} - ${preset.length}x${preset.width}x${preset.height} cm`;
}

function getShipmentPackageDimensions(shipment) {
  const primaryPackage = getPrimaryShippingPackage(shipment);
  const dimensions = primaryPackage?.dimensions || shipment?.raw?.dimensions || null;
  if (!dimensions) return null;
  const length = normalizeShippingDimension(dimensions.length);
  const width = normalizeShippingDimension(dimensions.width);
  const height = normalizeShippingDimension(dimensions.height);
  if (!length || !width || !height) return null;
  return {
    length,
    width,
    height,
    unit: String(dimensions.unit || dimensions.units || SHIPPING_PACKAGE_DIMENSION_UNIT).trim() || SHIPPING_PACKAGE_DIMENSION_UNIT,
  };
}

function convertShippingWeightToGrams(weight) {
  const value = Number(weight?.value || 0);
  const unit = String(weight?.unit || '').trim().toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return '';

  if (unit === 'gram' || unit === 'grams' || unit === 'g') return String(Math.round(value));
  if (unit === 'kilogram' || unit === 'kilograms' || unit === 'kg') return String(Math.round(value * 1000));
  if (unit === 'ounce' || unit === 'ounces' || unit === 'oz') return String(Math.round(value * 28.349523125));
  if (unit === 'pound' || unit === 'pounds' || unit === 'lb' || unit === 'lbs') return String(Math.round(value * 453.59237));
  return String(Math.round(value));
}

function getShipmentPackageWeightGrams(shipment) {
  const primaryPackage = getPrimaryShippingPackage(shipment);
  return convertShippingWeightToGrams(primaryPackage?.weight || shipment?.raw?.weight);
}

function dimensionsMatchPreset(dimensions, preset) {
  if (!dimensions || !preset || preset.custom) return false;
  return Number(dimensions.length) === Number(preset.length)
    && Number(dimensions.width) === Number(preset.width)
    && Number(dimensions.height) === Number(preset.height);
}

function inferShippingPackagePresetKey(shipment, dimensions = getShipmentPackageDimensions(shipment)) {
  const packageText = [
    shipment?.packageCode,
    shipment?.packages?.[0]?.packageCode,
    shipment?.raw?.package_code,
    shipment?.raw?.packages?.[0]?.package_code,
  ].filter(Boolean).join(' ').toLowerCase();
  const matchingPresets = SHIPPING_PACKAGE_PRESETS.filter((preset) => dimensionsMatchPreset(dimensions, preset));
  if (!matchingPresets.length) return 'custom';
  if (matchingPresets.some((preset) => preset.key === 'tank_box') && packageText.includes('tank')) {
    return 'tank_box';
  }
  return matchingPresets[0].key;
}

function getShippingPackageStateFromShipment(shipment) {
  const shipmentPackages = Array.isArray(shipment?.packages) ? shipment.packages : [];
  const defaultItemUnitIds = getShippingAssignableItems().map((item) => item.id);
  const packageRows = shipmentPackages.length
    ? shipmentPackages.map((pkg, index) => {
        const dimensions = pkg?.dimensions
          ? {
              length: normalizeShippingDimension(pkg.dimensions.length),
              width: normalizeShippingDimension(pkg.dimensions.width),
              height: normalizeShippingDimension(pkg.dimensions.height),
              unit: String(pkg.dimensions.unit || pkg.dimensions.units || SHIPPING_PACKAGE_DIMENSION_UNIT).trim() || SHIPPING_PACKAGE_DIMENSION_UNIT,
            }
          : null;
        const packagePresetKey = inferShippingPackagePresetKey({ ...shipment, packages: [pkg] }, dimensions);
        const presetDimensions = getPresetDimensions(packagePresetKey);
        return makeShippingPackageRow({
          weightGrams: convertShippingWeightToGrams(pkg?.weight),
          packagePresetKey,
          packageDimensions: presetDimensions || {
            length: dimensions?.length || '',
            width: dimensions?.width || '',
            height: dimensions?.height || '',
            unit: dimensions?.unit || SHIPPING_PACKAGE_DIMENSION_UNIT,
          },
          itemUnitIds: shipmentPackages.length === 1 && index === 0 ? defaultItemUnitIds : [],
        });
      })
    : [];
  const dimensions = getShipmentPackageDimensions(shipment);
  const weightGrams = packageRows[0]?.weightGrams || getShipmentPackageWeightGrams(shipment);
  const packagePresetKey = inferShippingPackagePresetKey(shipment, dimensions);
  const presetDimensions = getPresetDimensions(packagePresetKey);
  return {
    packagePresetKey,
    ...(shippingPanelState.weightGrams ? {} : { weightGrams }),
    packageDimensions: presetDimensions || {
      length: dimensions?.length || '',
      width: dimensions?.width || '',
      height: dimensions?.height || '',
      unit: dimensions?.unit || SHIPPING_PACKAGE_DIMENSION_UNIT,
    },
    packages: packageRows.length ? packageRows : [makeShippingPackageRow({
      weightGrams,
      packagePresetKey,
      packageDimensions: presetDimensions || {
        length: dimensions?.length || '',
        width: dimensions?.width || '',
        height: dimensions?.height || '',
        unit: dimensions?.unit || SHIPPING_PACKAGE_DIMENSION_UNIT,
      },
      itemUnitIds: defaultItemUnitIds,
    })],
  };
}

function getShippingAssignableItems() {
  return (verifyItems || []).flatMap((row) => {
    const requiredQty = Math.max(0, Math.floor(Number(row?.requiredQty) || 0));
    const valueAmount = Number(row?.unitValueAmount || 0);
    const valueCurrency = String(row?.valueCurrency || row?.priceCurrency || 'GBP').trim().toUpperCase() || 'GBP';
    const baseLabel = row?.productName || getVerifyDisplayLabel(row);
    const skuLabel = row?.sku && row.sku !== '(No SKU)' && row.sku !== 'Bundle'
      ? row.sku
      : '';

    return Array.from({ length: requiredQty }, (_, index) => {
      const unitNumber = index + 1;
      const quantityLabel = requiredQty > 1 ? ` ${unitNumber}/${requiredQty}` : '';
      return {
        id: `${row.key}::unit:${unitNumber}`,
        rowKey: row.key,
        label: `${skuLabel || baseLabel}${quantityLabel}`,
        valueAmount: Number.isFinite(valueAmount) && valueAmount > 0 ? valueAmount : 0,
        valueCurrency,
      };
    });
  });
}

function getShippingAssignableItemMap() {
  return new Map(getShippingAssignableItems().map((item) => [item.id, item]));
}

function normalizeShippingPackageItemUnitIds(itemUnitIds = []) {
  const validIds = new Set(getShippingAssignableItems().map((item) => item.id));
  const seen = new Set();
  return (Array.isArray(itemUnitIds) ? itemUnitIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => {
      if (!id || !validIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

function balanceShippingPackageItemAssignments(rows = []) {
  const assignableItems = getShippingAssignableItems();
  if (!assignableItems.length || !rows.length) return rows;

  const seen = new Set();
  const nextRows = rows.map((row) => {
    const itemUnitIds = normalizeShippingPackageItemUnitIds(row.itemUnitIds)
      .filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    return { ...row, itemUnitIds };
  });

  const missingIds = assignableItems
    .map((item) => item.id)
    .filter((id) => !seen.has(id));
  if (missingIds.length) {
    nextRows[0] = {
      ...nextRows[0],
      itemUnitIds: [
        ...(nextRows[0].itemUnitIds || []),
        ...missingIds,
      ],
    };
  }

  return nextRows;
}

function getShippingPackageInsuranceValue(row) {
  const itemMap = getShippingAssignableItemMap();
  let currency = 'GBP';
  const amount = normalizeShippingPackageItemUnitIds(row?.itemUnitIds)
    .reduce((sum, itemId) => {
      const item = itemMap.get(itemId);
      if (!item) return sum;
      if (item.valueCurrency) currency = item.valueCurrency;
      return sum + (Number(item.valueAmount) || 0);
    }, 0);
  return {
    amount: Number(amount.toFixed(2)),
    currency,
  };
}

function getShippingAllocationRows() {
  return (verifyItems || [])
    .map((row) => {
      const requiredQty = Math.max(0, Math.floor(Number(row?.requiredQty) || 0));
      if (!requiredQty) return null;

      const skuLabel = row?.sku && row.sku !== '(No SKU)' && row.sku !== 'Bundle'
        ? row.sku
        : '';
      const productLabel = row?.productName || getVerifyDisplayLabel(row);
      const valueAmount = Number(row?.unitValueAmount || 0);
      const valueCurrency = String(row?.valueCurrency || row?.priceCurrency || 'GBP').trim().toUpperCase() || 'GBP';

      return {
        rowKey: row.key,
        skuLabel,
        productLabel,
        requiredQty,
        unitValueAmount: Number.isFinite(valueAmount) && valueAmount > 0 ? valueAmount : 0,
        valueCurrency,
        unitIds: Array.from({ length: requiredQty }, (_, index) => `${row.key}::unit:${index + 1}`),
      };
    })
    .filter(Boolean);
}

function getShippingPackageAllocationCounts(allocationRow, packageRows = getShippingPackageRows()) {
  const unitIdSet = new Set(allocationRow?.unitIds || []);
  return (packageRows || []).map((packageRow) => (
    normalizeShippingPackageItemUnitIds(packageRow.itemUnitIds)
      .filter((itemId) => unitIdSet.has(itemId)).length
  ));
}

function balanceShippingAllocationCounts(currentCounts, packageIndex, nextCount, requiredQty) {
  const safeRequiredQty = Math.max(0, Math.floor(Number(requiredQty) || 0));
  const safeIndex = Math.max(0, Math.floor(Number(packageIndex) || 0));
  const counts = (Array.isArray(currentCounts) ? currentCounts : [])
    .map((count) => Math.max(0, Math.floor(Number(count) || 0)));
  if (!counts.length) return counts;

  counts[safeIndex] = Math.min(safeRequiredQty, Math.max(0, Math.floor(Number(nextCount) || 0)));
  const allowedOtherTotal = Math.max(0, safeRequiredQty - counts[safeIndex]);
  const otherIndexes = counts.map((_, index) => index).filter((index) => index !== safeIndex);
  let otherTotal = otherIndexes.reduce((sum, index) => sum + counts[index], 0);

  if (otherTotal > allowedOtherTotal) {
    let overflow = otherTotal - allowedOtherTotal;
    otherIndexes.forEach((index) => {
      if (overflow <= 0) return;
      const reduction = Math.min(counts[index], overflow);
      counts[index] -= reduction;
      overflow -= reduction;
    });
  }

  otherTotal = otherIndexes.reduce((sum, index) => sum + counts[index], 0);
  if (otherTotal < allowedOtherTotal) {
    const fillIndex = safeIndex === 0
      ? (otherIndexes[0] ?? 0)
      : 0;
    counts[fillIndex] += allowedOtherTotal - otherTotal;
  }

  return counts;
}

function setShippingAllocationCount(allocationRow, packageIndex, nextCount) {
  if (!allocationRow?.unitIds?.length) return;
  const packageRows = getShippingPackageRows();
  const counts = getShippingPackageAllocationCounts(allocationRow, packageRows);
  const nextCounts = balanceShippingAllocationCounts(counts, packageIndex, nextCount, allocationRow.requiredQty);
  const allocationUnitIdSet = new Set(allocationRow.unitIds);
  let cursor = 0;
  const nextUnitIdsByPackage = nextCounts.map((count) => {
    const ids = allocationRow.unitIds.slice(cursor, cursor + count);
    cursor += count;
    return ids;
  });

  const nextRows = packageRows.map((packageRow, index) => ({
    ...packageRow,
    itemUnitIds: [
      ...normalizeShippingPackageItemUnitIds(packageRow.itemUnitIds)
        .filter((itemId) => !allocationUnitIdSet.has(itemId)),
      ...(nextUnitIdsByPackage[index] || []),
    ],
  }));

  setShippingPackageRows(nextRows);
}

function makeShippingPackageRow({
  id = '',
  weightGrams = '',
  packagePresetKey = '',
  packageDimensions = null,
  itemUnitIds = [],
} = {}) {
  return {
    id: id || `package-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    weightGrams: String(weightGrams || '').replace(/\D/g, ''),
    packagePresetKey: packagePresetKey || 'custom',
    packageDimensions: {
      length: packageDimensions?.length || '',
      width: packageDimensions?.width || '',
      height: packageDimensions?.height || '',
      unit: packageDimensions?.unit || SHIPPING_PACKAGE_DIMENSION_UNIT,
    },
    itemUnitIds: normalizeShippingPackageItemUnitIds(itemUnitIds),
  };
}

function getShippingPackageRows() {
  if (Array.isArray(shippingPanelState.packages) && shippingPanelState.packages.length > 0) {
    return balanceShippingPackageItemAssignments(
      shippingPanelState.packages.map((row) => makeShippingPackageRow(row))
    );
  }

  return balanceShippingPackageItemAssignments([makeShippingPackageRow({
    weightGrams: shippingPanelState.weightGrams,
    packagePresetKey: shippingPanelState.packagePresetKey || 'custom',
    packageDimensions: shippingPanelState.packageDimensions,
    itemUnitIds: getShippingAssignableItems().map((item) => item.id),
  })]);
}

function getShippingPackageRowDimensions(row) {
  const presetDimensions = getPresetDimensions(row?.packagePresetKey);
  const dimensions = presetDimensions || row?.packageDimensions || {};
  const length = Number(dimensions.length);
  const width = Number(dimensions.width);
  const height = Number(dimensions.height);
  if (![length, width, height].every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }
  return {
    length,
    width,
    height,
    unit: String(dimensions.unit || SHIPPING_PACKAGE_DIMENSION_UNIT).trim() || SHIPPING_PACKAGE_DIMENSION_UNIT,
  };
}

function getSelectedShippingPackageDimensions() {
  return getShippingPackageRowDimensions(getShippingPackageRows()[0]);
}

function getNormalizedShippingPackages() {
  const packageRows = getShippingPackageRows();
  const includePackageInsuranceValues = packageRows.length > 1;
  return packageRows
    .map((row) => {
      const weightGrams = Math.floor(Number(row?.weightGrams || 0));
      const packageDimensions = getShippingPackageRowDimensions(row);
      if (!Number.isInteger(weightGrams) || weightGrams <= 0 || !packageDimensions) return null;
      const insuranceValue = getShippingPackageInsuranceValue(row);
      const normalizedPackage = {
        weightGrams,
        packageDimensions,
      };
      if (includePackageInsuranceValues && insuranceValue.amount > 0) {
        normalizedPackage.insuredValueAmount = insuranceValue.amount;
        normalizedPackage.insuredValueCurrency = insuranceValue.currency;
      }
      return {
        ...normalizedPackage,
      };
    })
    .filter(Boolean);
}

function getLegacyPackageStateFromRows(rows) {
  const firstRow = Array.isArray(rows) && rows.length ? rows[0] : null;
  return {
    weightGrams: firstRow?.weightGrams || '',
    packagePresetKey: firstRow?.packagePresetKey || 'custom',
    packageDimensions: firstRow?.packageDimensions || {
      length: '',
      width: '',
      height: '',
      unit: SHIPPING_PACKAGE_DIMENSION_UNIT,
    },
    itemUnitIds: firstRow?.itemUnitIds || [],
  };
}

function setShippingPackageRows(rows, extraPatch = {}) {
  const nextRows = (Array.isArray(rows) ? rows : [])
    .map((row) => makeShippingPackageRow(row))
    .slice(0, 8);
  const safeRows = balanceShippingPackageItemAssignments(nextRows.length ? nextRows : [makeShippingPackageRow()]);
  setShippingPanelState({
    packages: safeRows,
    ...getLegacyPackageStateFromRows(safeRows),
    status: 'shipment_found',
    rates: [],
    selectedQuoteId: '',
    expiresAt: '',
    noRateReason: '',
    error: '',
    rateInputSignature: '',
    ...extraPatch,
  });
}

function hasRequiredShippingRateInputs() {
  const packageRows = getShippingPackageRows();
  const normalizedPackages = getNormalizedShippingPackages();
  return packageRows.length > 0 && normalizedPackages.length === packageRows.length;
}

function getShippingRateInputSignature() {
  const shipmentId = String(shippingPanelState.shipment?.shipmentId || '').trim();
  const packages = getNormalizedShippingPackages();
  if (!shipmentId || packages.length !== getShippingPackageRows().length) return '';
  return [
    shipmentId,
    ...packages.map((pkg) => [
      pkg.weightGrams,
      pkg.packageDimensions.length,
      pkg.packageDimensions.width,
      pkg.packageDimensions.height,
      pkg.packageDimensions.unit,
      pkg.insuredValueAmount || 0,
      pkg.insuredValueCurrency || '',
    ].join(':')),
  ].join('|');
}

function canAutoRateVerifyShippingShipment(force = false) {
  if (!isVerifyShippingModalOpen()) return false;
  if (loading || shippingLookupInFlight || shippingPanelState.actionLoading) return false;
  if (['payment_blocked', 'no_shipment', 'error', 'purchased'].includes(shippingPanelState.status)) return false;
  const signature = getShippingRateInputSignature();
  if (!signature) return false;
  return force || shippingPanelState.rateInputSignature !== signature || shippingPanelState.status !== 'rates';
}

function queueVerifyShippingRateRefresh({ force = false, delay = 0 } = {}) {
  if (verifyShippingAutoRateTimeoutId) {
    window.clearTimeout(verifyShippingAutoRateTimeoutId);
  }
  verifyShippingAutoRateTimeoutId = window.setTimeout(() => {
    verifyShippingAutoRateTimeoutId = null;
    if (canAutoRateVerifyShippingShipment(force)) {
      rateVerifyShippingShipment({ automatic: true, force });
    }
  }, delay);
}

function formatShippingConfirmation(value) {
  return formatShippingMetaValue(value) || 'None';
}

function formatShippingInsurance(shipment) {
  const primaryPackage = getPrimaryShippingPackage(shipment);
  const provider = formatShippingMetaValue(shipment?.insuranceProvider);
  const insuredValue = primaryPackage?.insuredValue || {};
  const amount = Number(insuredValue.amount || 0);
  const currency = String(insuredValue.currency || '').trim();
  const valueLabel = amount > 0 ? formatShippingMoney(amount, currency) : '';
  return [provider, valueLabel].filter(Boolean).join(' - ') || 'None';
}

function getSelectedShippingRate() {
  const selectedQuoteId = String(shippingPanelState.selectedQuoteId || '').trim();
  return (shippingPanelState.rates || []).find((rate) => rate.quoteId === selectedQuoteId)
    || shippingPanelState.rates?.[0]
    || null;
}

function getShippingLabelDownloadUrl(label = shippingPanelState.label) {
  const labelId = String(label?.labelId || '').trim();
  return labelId ? `/api/pick-list/shipping/labels/${encodeURIComponent(labelId)}/download` : '';
}

function isShippingLabelVoided(label = shippingPanelState.label) {
  return String(label?.status || '').trim().toLowerCase() === 'voided';
}

function canManageShippingForCurrentOrder() {
  if (!isCurrentOrderWorkflowBlocked()) return true;
  const status = String(currentWorkflowBlock?.status || currentWorkflowBlock?.code || '').trim().toUpperCase();
  return status === 'FULFILLED' || status === 'PARTIALLY_FULFILLED';
}

function shouldShowFulfilledShippingPanel() {
  if (!isCurrentOrderWorkflowBlocked()) return false;
  return canManageShippingForCurrentOrder();
}

function shouldShowVerifyShippingPanel(totals = getVerifyTotals()) {
  return Boolean(
    verifyModeEnabled
    && !wholesaleModeEnabled
    && hasRenderedPickList
    && currentOrderBarcode
    && canManageShippingForCurrentOrder()
    && (totals?.isComplete || shouldShowFulfilledShippingPanel())
  );
}

function queueVerifyShippingLookupPreload() {
  if (verifyShippingPreloadTimeoutId || shippingLookupInFlight) return;
  if (!shouldShowVerifyShippingPanel()) return;

  verifyShippingPreloadTimeoutId = window.setTimeout(() => {
    verifyShippingPreloadTimeoutId = null;
    loadVerifyShippingLookup();
  }, 0);
}

function isVerifyShippingModalOpen() {
  return Boolean(document.getElementById('verifyShippingModal')?.classList.contains('is-open'));
}

function renderVerifyShippingModal() {
  const body = document.getElementById('verifyShippingModalBody');
  if (!body) return;
  const title = document.getElementById('verifyShippingModalTitle');
  if (title) {
    title.textContent = getVerifyShippingModalTitle();
  }
  body.className = `pick-shipping-modal__body pick-shipping-panel pick-shipping-panel--${shippingPanelState.status}`;
  renderVerifyShippingPanel(body, { includeHeader: false });
}

function openVerifyShippingModal() {
  if (!shouldShowVerifyShippingPanel()) return;
  if (shippingPanelState.barcode !== currentOrderBarcode) {
    resetShippingPanelState(currentOrderBarcode);
  }

  const modal = document.getElementById('verifyShippingModal');
  if (!modal) return;
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  renderVerifyShippingModal();
  queueVerifyShippingLookupPreload();
  queueVerifyShippingRateRefresh({ force: true, delay: 0 });
}

async function openVerifyShippingModalFromLaunch() {
  if (loading || !shouldShowVerifyShippingPanel()) return;

  if (!canBuyShippingLabelForCurrentOrder()) {
    const packaged = await runOrderAction('packaged');
    if (!packaged || !canBuyShippingLabelForCurrentOrder()) {
      return;
    }
  }

  openVerifyShippingModal();
}

function closeVerifyShippingModal() {
  const modal = document.getElementById('verifyShippingModal');
  if (!modal) return;
  activeShippingWeightPackageIndex = null;
  if (verifyShippingAutoRateTimeoutId) {
    window.clearTimeout(verifyShippingAutoRateTimeoutId);
    verifyShippingAutoRateTimeoutId = null;
  }
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
}

function syncShippingPanelDisabledState() {
  const disabled = loading || Boolean(shippingPanelState.actionLoading);
  if (!disabled) return;
  document.querySelectorAll('.pick-shipping-panel button, .pick-shipping-panel input').forEach((control) => {
    control.disabled = true;
  });
}

function formatSkuSummary(skus, maxVisible = 3) {
  const uniqueSkus = Array.from(new Set((skus || []).map(normalizeDisplaySku).filter(Boolean)));
  if (uniqueSkus.length <= maxVisible) return uniqueSkus.join(', ');
  return `${uniqueSkus.slice(0, maxVisible).join(', ')} +${uniqueSkus.length - maxVisible}`;
}

function formatAwaitingPrintQueueMessage(update) {
  if (!update) return '';

  const parts = [];
  const addedSkus = Array.isArray(update.addedSkus) ? update.addedSkus : [];
  const alreadyQueuedSkus = Array.isArray(update.alreadyQueuedSkus) ? update.alreadyQueuedSkus : [];
  const notPrintableSkus = Array.isArray(update.notPrintableSkus) ? update.notPrintableSkus : [];
  const missingSkus = Array.isArray(update.missingSkus) ? update.missingSkus : [];
  const blockedByQueued = Array.isArray(update.blockedByQueued) ? update.blockedByQueued : [];

  if (addedSkus.length > 0) {
    parts.push(`added ${formatSkuSummary(addedSkus)} to Needs Printed`);
  }
  if (alreadyQueuedSkus.length > 0) {
    parts.push(`${formatSkuSummary(alreadyQueuedSkus)} already in the print queue`);
  }
  if (blockedByQueued.length > 0) {
    const blockedLabels = blockedByQueued.map((entry) => {
      const sku = normalizeDisplaySku(entry?.sku);
      const queuedSkus = formatSkuSummary(entry?.queuedSkus || [], 2);
      return queuedSkus ? `${sku} blocked by ${queuedSkus}` : sku;
    }).filter(Boolean);
    if (blockedLabels.length > 0) {
      parts.push(`${blockedLabels.join(', ')} already represented in the print queue`);
    }
  }
  if (notPrintableSkus.length > 0) {
    parts.push(`${formatSkuSummary(notPrintableSkus)} not SLS/Adapter`);
  }
  if (missingSkus.length > 0) {
    parts.push(`${formatSkuSummary(missingSkus)} not found in the sheet`);
  }
  if (update.error) {
    parts.push(`print queue not updated: ${update.error}`);
  }

  return parts.length > 0 ? `Print queue: ${parts.join('; ')}.` : '';
}

function isPrintablePickListType(type) {
  const normalized = String(type || '').trim().toUpperCase();
  return /(^|[^A-Z0-9])SLS([^A-Z0-9]|$)/.test(normalized)
    || /(^|[^A-Z0-9])ADAPTER([^A-Z0-9]|$)/.test(normalized);
}

function getRowRsq(row) {
  const rsq = Math.floor(Number(row?.rsq) || 0);
  return rsq > 0 ? rsq : 0;
}

function promptGettingLowQuantity(row) {
  const sku = normalizeDisplaySku(row?.sku);
  const rsq = getRowRsq(row);
  const defaultQuantity = rsq > 0 ? rsq : 1;
  const rawValue = window.prompt(
    [`Quantity to print for ${sku}`, rsq > 0 ? `RSQ: ${rsq}` : 'RSQ: not set'].join('\n'),
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

function openAwaitingPrintQueueResultPopup(message, { isError = false } = {}) {
  const modal = document.getElementById('awaitingPrintQueueResultModal');
  const title = document.getElementById('awaitingPrintQueueResultTitle');
  const messageEl = document.getElementById('awaitingPrintQueueResultMessage');
  const safeMessage = String(message || '').trim();

  if (!safeMessage) return;

  if (!modal || !messageEl) {
    window.alert(safeMessage);
    return;
  }

  if (title) {
    title.textContent = isError ? 'Print Queue Issue' : 'Print Queue';
  }
  const displayMessage = safeMessage.replace(/^Print queue:\s*/i, '');
  messageEl.textContent = displayMessage
    ? displayMessage.charAt(0).toUpperCase() + displayMessage.slice(1)
    : safeMessage;
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeAwaitingPrintQueueResultPopup() {
  const modal = document.getElementById('awaitingPrintQueueResultModal');
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
}

function openHpaTankRegRemovalPopup(row = null) {
  const message = currentHpaTankShippingWarning?.message || 'Take to a team member to get reg removed';
  const modal = document.getElementById('hpaTankRegRemovalModal');
  const messageEl = document.getElementById('hpaTankRegRemovalMessage');
  const detailEl = document.getElementById('hpaTankRegRemovalDetail');
  const countryLabel = currentHpaTankShippingWarning?.countryName || currentHpaTankShippingWarning?.countryCode || '';
  const itemLabel = row ? (row.sku || row.productName || row.title || '') : '';

  if (!modal || !messageEl) {
    window.alert(message);
    return;
  }

  messageEl.textContent = message;
  if (detailEl) {
    detailEl.textContent = [
      itemLabel ? `Item: ${itemLabel}` : '',
      countryLabel ? `Destination: ${countryLabel}` : '',
    ].filter(Boolean).join(' | ');
  }
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeHpaTankRegRemovalPopup() {
  const modal = document.getElementById('hpaTankRegRemovalModal');
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
}

function maybeShowHpaTankRegRemovalPopupForPickRow(row, rowKey, previousCount, nextCount) {
  if (!isHpaTankPickRow(row) || nextCount <= previousCount) return;
  const alertKey = rowKey || normalizeDisplaySku(row?.sku || row?.productName || row?.title);
  if (alertKey && hpaTankRegRemovalAlertedKeys.has(alertKey)) return;
  if (alertKey) hpaTankRegRemovalAlertedKeys.add(alertKey);
  openHpaTankRegRemovalPopup(row);
}

function formatWorkflowStatusLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  return raw
    .toLowerCase()
    .split(/[_-]+/)
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

function clearLoadedOrderState({ preserveOrderLookup = false } = {}) {
  lastRenderedLineItems = [];
  lastOrderItems = [];
  lastWholesaleProgressByItemKey = {};
  lastVerifyProgressByItemKey = {};
  hasRenderedPickList = false;
  currentOrderBarcode = '';
  currentOrderNumber = '';
  currentOrderNote = '';
  currentOrderTimeline = [];
  currentWorkflowBlock = null;
  currentOrderTags = [];
  currentOrderStatus = '';
  currentOrderFinancialStatus = '';
  currentOrderStageKey = '';
  currentOrderStageLabel = '';
  currentQcBuilderStaff = '';
  setHpaTankShippingWarning(null);
  setWholesaleOrderWarning(null);
  currentAwaitingPartsSkuMap = new Map();
  currentAwaitingPartsCatalog = new Map();
  currentPickedRowCounts = new Map();
  if (pickedRowsSaveTimeoutId) {
    clearTimeout(pickedRowsSaveTimeoutId);
    pickedRowsSaveTimeoutId = null;
  }
  pickedRowsSaveInFlight = false;
  pickedRowsSaveQueued = false;
  pendingActionReminderTarget = null;
  suppressNextActionReminderUnload = false;
  verifyItems = [];
  verifyCodeIndex = new Map();
  if (verifySaveTimeoutId) {
    clearTimeout(verifySaveTimeoutId);
    verifySaveTimeoutId = null;
  }
  verifySaveInFlight = false;
  verifySaveQueued = false;
  resetShippingPanelState('');

  const lineItems = document.getElementById('pickListLineItems');
  const timelineSection = document.getElementById('pickListTimelineSection');
  const timelineCard = document.getElementById('pickListTimelineCard');

  renderOrderHeaderMeta();
  if (lineItems) lineItems.innerHTML = '';
  if (timelineSection) timelineSection.hidden = true;
  if (timelineCard) timelineCard.innerHTML = '';
  if (!preserveOrderLookup) {
    setOrderLookupInUrl('');
  }

  renderWorkflowAlert();
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
    if (button.id === 'bagLabelsOpenBtn') {
      button.disabled = loading || !actionButtonsUnlocked || !canManageShippingForCurrentOrder();
      return;
    }

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
    const isQcVisible = button.dataset.qcVisible === 'true';

    if (qcModeEnabled) {
      button.hidden = !isQcVisible;
      return;
    }

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

function getTimelineEventTime(event) {
  const raw = String(event?.createdAt || event?.timestamp || '').trim();
  if (!raw) return Number.NaN;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function sortTimelineEventsNewestFirst(events) {
  return (Array.isArray(events) ? events : [])
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftTime = getTimelineEventTime(left.event);
      const rightTime = getTimelineEventTime(right.event);
      const leftHasTime = Number.isFinite(leftTime);
      const rightHasTime = Number.isFinite(rightTime);

      if (leftHasTime && rightHasTime && leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      if (leftHasTime !== rightHasTime) {
        return leftHasTime ? -1 : 1;
      }
      return right.index - left.index;
    })
    .map((entry) => entry.event);
}

function renderOrderTimeline() {
  const section = document.getElementById('pickListTimelineSection');
  const container = document.getElementById('pickListTimelineCard');
  if (!section || !container) return;

  if (!hasRenderedPickList || pickerModeEnabled || verifyModeEnabled || wholesaleModeEnabled || qcModeEnabled) {
    section.hidden = true;
    container.innerHTML = '';
    return;
  }

  section.hidden = false;
  container.innerHTML = '';

  const events = sortTimelineEventsNewestFirst(
    Array.isArray(currentOrderTimeline) && currentOrderTimeline.length > 0
      ? currentOrderTimeline
      : parseTimelineEvents(currentOrderNote)
  );
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
  syncAwaitingToggleDisabledState();
  syncShippingPanelDisabledState();
  syncBagLabelsDialogDisabledState();
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

function normalizeOrderTagsForDisplay(tags) {
  const rawTags = Array.isArray(tags)
    ? tags
    : String(tags || '').split(',');

  return rawTags
    .map((tag) => String(tag || '').trim())
    .filter(Boolean);
}

function formatOrderTagLabel(tag) {
  const raw = String(tag || '').trim();
  if (!raw) return '';

  const actionLabel = formatActionLabel(raw);
  return actionLabel === raw ? formatWorkflowStatusLabel(raw) : actionLabel;
}

function applyOrderHeaderData(data, { fallbackTag = '' } = {}) {
  currentOrderTags = normalizeOrderTagsForDisplay(
    Array.isArray(data?.orderTags) ? data.orderTags : data?.tags
  );
  if (!currentOrderTags.length && fallbackTag) {
    currentOrderTags = [fallbackTag];
  }

  currentOrderStatus = String(data?.orderStatus || data?.workflowStatus || '').trim();
  currentOrderFinancialStatus = String(data?.orderFinancialStatus || currentOrderFinancialStatus || '').trim();
  currentOrderStageKey = String(data?.currentStage?.key || '').trim();
  currentOrderStageLabel = String(data?.currentStage?.label || '').trim();
  if (Object.prototype.hasOwnProperty.call(data || {}, 'qcBuilderStaff')) {
    currentQcBuilderStaff = String(data.qcBuilderStaff || '').trim();
  }
  renderOrderHeaderMeta();
}

function renderOrderHeaderMeta() {
  const orderMeta = document.getElementById('pickListOrderMeta');
  const orderStatus = document.getElementById('pickListOrderStatus');
  if (!orderMeta || !orderStatus) return;

  if (!currentOrderNumber && !currentOrderBarcode) {
    orderMeta.textContent = 'No order loaded';
    orderStatus.textContent = 'Awaiting scan';
    return;
  }

  const orderLabel = currentOrderNumber || currentOrderBarcode;
  const barcodeLabel = currentOrderBarcode && currentOrderBarcode !== orderLabel
    ? ` (${currentOrderBarcode})`
    : '';
  const primaryTag = currentOrderTags[0] || '';
  const tagLabel = formatOrderTagLabel(primaryTag);
  const statusLabel = currentOrderStageLabel || formatWorkflowStatusLabel(currentOrderStatus);
  const statusParts = [
    tagLabel ? `Tag: ${tagLabel}` : '',
    statusLabel ? `Status: ${statusLabel}` : '',
  ].filter(Boolean);

  orderMeta.textContent = `${orderLabel}${barcodeLabel}`;
  orderStatus.textContent = statusParts.length ? statusParts.join(' / ') : 'No tag or status';
}

function isCurrentOrderLookup(value) {
  const normalizedValue = normalizeDisplaySku(value);
  if (!normalizedValue) return false;

  return [currentOrderBarcode, currentOrderNumber]
    .map((item) => normalizeDisplaySku(item))
    .filter(Boolean)
    .includes(normalizedValue);
}

function hasActionForCurrentOrder() {
  const orderId = normalizeDisplaySku(currentOrderBarcode);
  return Boolean(
    orderId &&
    lastActionTag &&
    normalizeDisplaySku(lastActionBarcode) === orderId
  );
}

function hasPickerPickProgress() {
  if (!pickerModeEnabled) return false;
  return Array.from(currentPickedRowCounts.values()).some((count) => Number(count) > 0);
}

function hasVerifyPickProgress() {
  if (!verifyModeEnabled) return false;
  return verifyItems.some((row) => Number(row?.scannedQty) > 0);
}

function shouldShowOrderActionReminder({ nextLookup = '' } = {}) {
  if (!hasRenderedPickList || !currentOrderBarcode || isCurrentOrderWorkflowBlocked()) {
    return false;
  }
  if (!pickerModeEnabled && !verifyModeEnabled) {
    return false;
  }
  if (nextLookup && isCurrentOrderLookup(nextLookup)) {
    return false;
  }
  if (hasActionForCurrentOrder()) {
    return false;
  }

  return hasPickerPickProgress() || hasVerifyPickProgress();
}

function getOrderActionReminderSummary() {
  if (pickerModeEnabled) {
    const pickedRows = Array.from(currentPickedRowCounts.values())
      .filter((count) => Number(count) > 0);
    const pickedCount = pickedRows.reduce((sum, count) => sum + Number(count), 0);
    const rowLabel = pickedRows.length === 1 ? 'row' : 'rows';
    const tapLabel = pickedCount === 1 ? 'tap' : 'taps';
    return `${pickedRows.length} picked ${rowLabel}, ${pickedCount} ${tapLabel} recorded`;
  }

  if (verifyModeEnabled) {
    const totals = getVerifyTotals();
    return `${totals.scanned}/${totals.required} verified`;
  }

  return 'pick progress recorded';
}

function isActionRelevantForCurrentMode(button) {
  if (!button) return false;

  const tag = button.dataset.orderAction || '';
  if (!tag) return false;

  if (qcModeEnabled) {
    return button.dataset.qcVisible === 'true';
  }

  if (wholesaleModeEnabled || verifyModeEnabled) {
    return button.dataset.verifyVisible === 'true';
  }

  if (pickerModeEnabled) {
    return button.dataset.pickerVisible === 'true';
  }

  return false;
}

function getOrderActionReminderOptions() {
  return actionButtons
    .filter(isActionRelevantForCurrentMode)
    .map((button) => {
      const tag = button.dataset.orderAction || '';
      const disabled = tag === 'packaged' && isPackagedActionLocked();
      return {
        tag,
        label: formatActionLabel(tag),
        className: button.className,
        disabled,
        title: disabled ? 'Complete Verify Order before marking this order as Packaged.' : '',
      };
    });
}

function closeOrderActionReminderDialog({ clearPending = true } = {}) {
  const modal = document.getElementById('orderActionReminderModal');
  const actions = document.getElementById('orderActionReminderActions');

  if (modal) modal.classList.remove('is-open');
  if (actions) actions.innerHTML = '';
  if (clearPending) {
    pendingActionReminderTarget = null;
  }
}

function continueActionReminderTarget(target = pendingActionReminderTarget) {
  if (!target) return;

  pendingActionReminderTarget = null;
  if (target.lookup) {
    fetchPickList(target.lookup, { skipActionReminder: true });
    return;
  }

  if (target.href) {
    suppressNextActionReminderUnload = true;
    window.location.href = target.href;
  }
}

async function runOrderActionFromReminder(tag) {
  const pendingTarget = pendingActionReminderTarget;
  closeOrderActionReminderDialog({ clearPending: false });

  const result = await runOrderAction(tag);
  if (result === true && pendingTarget && hasActionForCurrentOrder()) {
    continueActionReminderTarget(pendingTarget);
    return;
  }

  if (result === 'dialog') {
    pendingActionReminderTarget = pendingTarget;
    return;
  }

  pendingActionReminderTarget = null;
}

function openOrderActionReminderDialog(target = {}) {
  const modal = document.getElementById('orderActionReminderModal');
  const message = document.getElementById('orderActionReminderMessage');
  const actions = document.getElementById('orderActionReminderActions');
  if (!modal || !message || !actions) return false;

  pendingActionReminderTarget = {
    lookup: String(target.lookup || '').trim(),
    href: String(target.href || '').trim(),
  };

  const orderLabel = currentOrderNumber || currentOrderBarcode;
  message.textContent = `${orderLabel} has ${getOrderActionReminderSummary()}, but no order action has been applied. Choose an action before continuing.`;
  actions.innerHTML = '';

  getOrderActionReminderOptions().forEach((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${option.className} pick-action-reminder__action`;
    button.textContent = option.label;
    button.disabled = option.disabled;
    if (option.title) {
      button.title = option.title;
    }
    button.addEventListener('click', () => {
      runOrderActionFromReminder(option.tag);
    });
    actions.appendChild(button);
  });

  modal.classList.add('is-open');
  return true;
}

function isOrderActionReminderDialogOpen() {
  const modal = document.getElementById('orderActionReminderModal');
  return Boolean(modal?.classList.contains('is-open'));
}

function isOrderLookupCode(value) {
  const normalized = normalizeVerifyCode(value);
  return normalized.startsWith('AT') || normalized.startsWith('#');
}

function handleOrderActionReminderScan(scannedCode) {
  const normalized = String(scannedCode || '').trim().toUpperCase();
  if (!normalized || !isOrderLookupCode(normalized)) {
    return false;
  }

  closeOrderActionReminderDialog({ clearPending: false });
  pendingActionReminderTarget = null;
  fetchPickList(normalized, { skipActionReminder: true });
  return true;
}

function makeBagLabelRow(text = '', quantity = 1) {
  const id = window.crypto?.randomUUID
    ? window.crypto.randomUUID()
    : `bag-label-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    text: cleanBagLabelText(text),
    quantity: Math.max(1, Math.floor(Number(quantity) || 1)),
  };
}

function cleanBagLabelText(value) {
  return String(value || '')
    .replace(/\s*[\([{][^\])}]*[\])}]\s*/g, ' ')
    .replace(/(?:[-\u2013\u2014]\s*)?2026\s+edition(?:\s*[-\u2013\u2014])?/gi, ' ')
    .replace(/\bair\s*[- ]?\s*tac\b/gi, ' ')
    .replace(/\bplug\s*(?:and|&|\+)?\s*play\b/gi, ' ')
    .replace(/\binjection\s*[- ]?\s*mou?lded\b/gi, ' ')
    .replace(/(?:^\s*-\s*)|(?:\s*-\s*$)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function getBagLabelTextForOrderItem(item) {
  return cleanBagLabelText(item?.title || item?.sku || '');
}

function buildSuggestedBagLabels(orderItems = lastOrderItems) {
  const rows = [];
  const bundleRows = new Map();
  const productRows = new Map();

  (orderItems || []).forEach((item) => {
    const quantity = Math.max(1, Math.floor(Number(item?.quantity) || 1));
    const bundleGroupId = String(item?.bundleGroup?.id || '').trim();

    if (bundleGroupId) {
      const bundleText = cleanBagLabelText(item?.bundleGroup?.title || item?.title || item?.sku || '');
      if (!bundleText) return;
      const bundleQuantity = Math.max(1, Math.floor(Number(item?.bundleGroup?.quantity) || quantity));
      if (!bundleRows.has(bundleGroupId)) {
        const row = makeBagLabelRow(bundleText, bundleQuantity);
        bundleRows.set(bundleGroupId, row);
        rows.push(row);
      } else {
        const row = bundleRows.get(bundleGroupId);
        row.quantity = Math.max(row.quantity, bundleQuantity);
      }
      return;
    }

    const text = getBagLabelTextForOrderItem(item);
    if (!text) return;
    const key = text.toUpperCase();
    if (productRows.has(key)) {
      productRows.get(key).quantity += quantity;
      return;
    }
    const row = makeBagLabelRow(text, quantity);
    productRows.set(key, row);
    rows.push(row);
  });

  return rows;
}

function closeBagLabelsDialog() {
  const modal = document.getElementById('bagLabelsModal');
  if (modal) modal.classList.remove('is-open');
}

function syncBagLabelsDialogDisabledState() {
  const modal = document.getElementById('bagLabelsModal');
  if (!modal?.classList.contains('is-open')) return;

  const validRows = bagLabelRows.filter((row) => String(row.text || '').trim() && Number(row.quantity) > 0);
  modal.querySelectorAll('input, button').forEach((control) => {
    if (control.id === 'bagLabelsCancelBtn') {
      control.disabled = false;
      return;
    }
    control.disabled = loading;
  });

  const printButton = document.getElementById('bagLabelsPrintBtn');
  if (printButton) {
    printButton.disabled = loading || validRows.length === 0;
    printButton.textContent = bagLabelActionLoading === 'print' ? 'Printing...' : 'Print Labels';
  }

  const previewButton = document.getElementById('bagLabelsPreviewBtn');
  if (previewButton) {
    previewButton.disabled = loading || validRows.length === 0;
    previewButton.textContent = bagLabelActionLoading === 'preview' ? 'Preparing...' : 'Preview PDF';
  }
}

function getBagLabelsForSubmission() {
  return bagLabelRows
    .map((row) => ({
      text: String(row.text || '').trim(),
      quantity: Math.max(1, Math.floor(Number(row.quantity) || 1)),
    }))
    .filter((row) => row.text && row.quantity > 0);
}

function renderBagLabelsDialog() {
  const list = document.getElementById('bagLabelsList');
  if (!list) return;
  list.innerHTML = '';

  if (!bagLabelRows.length) {
    const empty = document.createElement('p');
    empty.className = 'pick-bag-labels-empty';
    empty.textContent = 'No labels selected. Add a label before printing.';
    list.appendChild(empty);
    syncBagLabelsDialogDisabledState();
    return;
  }

  bagLabelRows.forEach((row, index) => {
    const item = document.createElement('div');
    item.className = 'pick-bag-label-row';

    const textLabel = document.createElement('label');
    textLabel.textContent = 'Label text';
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = row.text;
    textInput.addEventListener('input', () => {
      row.text = textInput.value;
      syncBagLabelsDialogDisabledState();
    });
    textLabel.appendChild(textInput);

    const qtyLabel = document.createElement('label');
    qtyLabel.textContent = 'Qty';
    const qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.min = '1';
    qtyInput.max = '200';
    qtyInput.step = '1';
    qtyInput.inputMode = 'numeric';
    qtyInput.value = String(row.quantity || 1);
    qtyInput.addEventListener('input', () => {
      row.quantity = Math.max(1, Math.floor(Number(qtyInput.value) || 1));
      syncBagLabelsDialogDisabledState();
    });
    qtyLabel.appendChild(qtyInput);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'pick-bag-label-row__remove';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      bagLabelRows.splice(index, 1);
      renderBagLabelsDialog();
    });

    item.appendChild(textLabel);
    item.appendChild(qtyLabel);
    item.appendChild(remove);
    list.appendChild(item);
  });

  syncBagLabelsDialogDisabledState();
}

function openBagLabelsDialog() {
  if (!hasRenderedPickList || !lastOrderItems.length) {
    setStatus('Load an order before printing bag labels.', 'error');
    return;
  }

  bagLabelRows = buildSuggestedBagLabels(lastOrderItems);
  const modal = document.getElementById('bagLabelsModal');
  if (!modal) return;
  renderBagLabelsDialog();
  modal.classList.add('is-open');
}

function addBagLabelRow() {
  bagLabelRows.push(makeBagLabelRow('', 1));
  renderBagLabelsDialog();
  const inputs = document.querySelectorAll('#bagLabelsList .pick-bag-label-row input[type="text"]');
  const lastInput = inputs[inputs.length - 1];
  if (lastInput) lastInput.focus();
}

async function submitBagLabels() {
  const labels = getBagLabelsForSubmission();

  if (!labels.length) {
    setStatus('Add at least one bag label before printing.', 'error');
    return;
  }

  bagLabelActionLoading = 'print';
  setLoading(true);
  syncBagLabelsDialogDisabledState();
  try {
    const data = await fetchShippingJson('/api/pick-list/bag-labels/print', {
      method: 'POST',
      body: JSON.stringify({
        barcode: currentOrderBarcode,
        orderNumber: currentOrderNumber,
        labels,
      }),
    });
    closeBagLabelsDialog();
    const count = Number(data.labelCount) || labels.reduce((sum, row) => sum + row.quantity, 0);
    setStatus(`Sent ${count} bag label${count === 1 ? '' : 's'} to PrintNode.`, 'success');
  } catch (err) {
    setStatus(`Bag label print failed: ${err.message || 'PrintNode error'}`, 'error');
  } finally {
    bagLabelActionLoading = '';
    setLoading(false);
    syncBagLabelsDialogDisabledState();
  }
}

async function previewBagLabelsPdf() {
  const labels = getBagLabelsForSubmission();

  if (!labels.length) {
    setStatus('Add at least one bag label before previewing.', 'error');
    return;
  }

  const previewWindow = window.open('', '_blank');
  bagLabelActionLoading = 'preview';
  setLoading(true);
  syncBagLabelsDialogDisabledState();

  try {
    const response = await fetch('/api/pick-list/bag-labels/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        barcode: currentOrderBarcode,
        orderNumber: currentOrderNumber,
        labels,
      }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to build bag label PDF');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    if (previewWindow) {
      previewWindow.location.href = url;
    } else {
      window.open(url, '_blank');
    }
    setStatus('Bag label PDF preview ready.', 'success');
  } catch (err) {
    if (previewWindow) previewWindow.close();
    setStatus(`Bag label preview failed: ${err.message || 'PDF error'}`, 'error');
  } finally {
    bagLabelActionLoading = '';
    setLoading(false);
    syncBagLabelsDialogDisabledState();
  }
}

function isAnyDialogOpen() {
  const awaitingPartsModal = document.getElementById('awaitingPartsModal');
  const printQueueResultModal = document.getElementById('awaitingPrintQueueResultModal');
  const qcFailModal = document.getElementById('qcFailModal');
  const onHoldModal = document.getElementById('onHoldModal');
  const verifyShippingModal = document.getElementById('verifyShippingModal');
  const bagLabelsModal = document.getElementById('bagLabelsModal');
  const hpaTankRegRemovalModal = document.getElementById('hpaTankRegRemovalModal');

  return Boolean(
    awaitingPartsModal?.classList.contains('is-open') ||
    printQueueResultModal?.classList.contains('is-open') ||
    qcFailModal?.classList.contains('is-open') ||
    onHoldModal?.classList.contains('is-open') ||
    verifyShippingModal?.classList.contains('is-open') ||
    bagLabelsModal?.classList.contains('is-open') ||
    hpaTankRegRemovalModal?.classList.contains('is-open') ||
    isOrderActionReminderDialogOpen()
  );
}

async function saveAwaitingPartsSelection({ orderId, items, closeDialog = false } = {}) {
  const normalizedOrderId = String(orderId || currentOrderBarcode || '').trim().toUpperCase();
  const normalizedItems = (Array.isArray(items) ? items : [])
    .map((item) => ({
      sku: normalizeDisplaySku(item?.sku || item?.partSku),
      quantity: Math.max(1, Number(item?.quantity) || 1),
    }))
    .filter((item) => item.sku);

  if (!normalizedOrderId) {
    setStatus('Error: Missing order id for awaiting parts.', 'error');
    return false;
  }

  if (loading) return false;

  setLoading(true);
  try {
    const response = await fetch('/api/awaiting-parts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: normalizedOrderId, items: normalizedItems }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to save awaiting parts');
    }

    setCurrentAwaitingPartsItems(Array.isArray(data.awaitingPartsSelection) ? data.awaitingPartsSelection : normalizedItems);
    if (normalizedItems.length > 0) {
      lastActionTag = 'awaiting_parts';
      lastActionBarcode = normalizedOrderId;
    }
    applyOrderHeaderData(data, {
      fallbackTag: normalizedItems.length > 0 ? 'awaiting_parts' : '',
    });
    if (hasRenderedPickList) {
      renderCurrentOrderSection();
    }

    const savedOrderNumber = data.orderNumber || currentOrderNumber || normalizedOrderId;
    const baseStatus = normalizedItems.length > 0
      ? `Awaiting parts updated for ${savedOrderNumber}.`
      : `Awaiting parts cleared for ${savedOrderNumber}.`;
    const printQueueStatus = normalizedItems.length > 0
      ? formatAwaitingPrintQueueMessage(data.printQueueUpdate)
      : '';
    setStatus(
      [appendOrderNoteWarning(baseStatus, data), printQueueStatus].filter(Boolean).join(' '),
      data.printQueueUpdate?.error ? 'error' : 'success'
    );

    if (closeDialog) {
      closeAwaitingPartsDialog();
    }

    if (printQueueStatus) {
      openAwaitingPrintQueueResultPopup(printQueueStatus, {
        isError: Boolean(data.printQueueUpdate?.error),
      });
    }

    return true;
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    return false;
  } finally {
    setLoading(false);
  }
}

async function toggleAwaitingPart(sku) {
  const normalizedSku = normalizeDisplaySku(sku);
  if (!normalizedSku || !hasRenderedPickList || isCurrentOrderWorkflowBlocked()) {
    return false;
  }

  const nextSelectionMap = new Map(currentAwaitingPartsSkuMap);
  if (nextSelectionMap.has(normalizedSku)) {
    nextSelectionMap.delete(normalizedSku);
  } else {
    nextSelectionMap.set(
      normalizedSku,
      Math.max(1, getAwaitingPartsTargetQty(normalizedSku) || getAwaitingPartsQty(normalizedSku) || 1)
    );
  }

  const nextItems = Array.from(nextSelectionMap.entries())
    .map(([nextSku, quantity]) => ({ sku: nextSku, quantity }))
    .sort((left, right) => left.sku.localeCompare(right.sku));

  return saveAwaitingPartsSelection({
    orderId: currentOrderBarcode,
    items: nextItems,
  });
}

function createAwaitingToggleButton(sku) {
  const normalizedSku = normalizeDisplaySku(sku);
  const isAwaiting = isAwaitingPartsSku(normalizedSku);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `pick-list-awaiting-toggle${isAwaiting ? ' is-active' : ''}`;
  button.textContent = isAwaiting ? 'Clear' : 'Await';
  button.title = isAwaiting
    ? `Mark ${normalizedSku} as no longer awaiting parts`
    : `Mark ${normalizedSku} as awaiting parts`;
  button.disabled = loading || isCurrentOrderWorkflowBlocked();
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await toggleAwaitingPart(normalizedSku);
  });
  return button;
}

async function addGettingLowToPrintQueue(row) {
  const normalizedSku = normalizeDisplaySku(row?.sku);
  if (!normalizedSku || loading || isCurrentOrderWorkflowBlocked()) return false;

  const quantity = promptGettingLowQuantity(row);
  if (quantity === null) return false;

  setLoading(true);
  setStatus(`Adding ${normalizedSku} x${quantity} to Needs Printed...`, 'info');

  try {
    const response = await fetch('/api/print-queue/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sku: normalizedSku, quantity }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to add to print queue');
    }

    const addedPartCount = Number(data.createdPartCount || data.createdCount || 0);
    const message = `Added ${normalizedSku} x${quantity} to Needs Printed${addedPartCount > 1 ? ` (${addedPartCount} build parts)` : ''}.`;
    setStatus(message, 'success');
    openAwaitingPrintQueueResultPopup(`Print queue: ${message}`, { isError: false });
    return true;
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    return false;
  } finally {
    setLoading(false);
  }
}

function createGettingLowButton(row) {
  const normalizedSku = normalizeDisplaySku(row?.sku);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pick-list-getting-low-btn';
  button.textContent = 'Getting low';
  button.title = `Add ${normalizedSku} to Needs Printed without changing the order tag`;
  button.disabled = loading || isCurrentOrderWorkflowBlocked();
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await addGettingLowToPrintQueue(row);
  });
  return button;
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

function comparePickLocation(left, right) {
  const leftLocation = parsePickLocation(left?.location);
  const rightLocation = parsePickLocation(right?.location);

  if (!leftLocation.raw && rightLocation.raw) return 1;
  if (leftLocation.raw && !rightLocation.raw) return -1;

  const bayDiff = leftLocation.bay.localeCompare(rightLocation.bay, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (bayDiff !== 0) return bayDiff;

  const trayAlphaDiff = leftLocation.trayAlpha.localeCompare(rightLocation.trayAlpha, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (trayAlphaDiff !== 0) return trayAlphaDiff;

  const trayNumberDiff = leftLocation.trayNumber.localeCompare(rightLocation.trayNumber, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (trayNumberDiff !== 0) return trayNumberDiff;

  const rawDiff = leftLocation.raw.localeCompare(rightLocation.raw, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (rawDiff !== 0) return rawDiff;

  return normalizeDisplaySku(left?.sku).localeCompare(normalizeDisplaySku(right?.sku), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
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

function renderLocationCell(rowLocation) {
  const location = document.createElement('div');
  location.className = 'pick-list-cell pick-list-col-location pick-list-item-location';

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

function getPickRowKey(row, sectionTitle, rowIndex) {
  return [
    currentOrderBarcode,
    sectionTitle,
    rowIndex,
    normalizeDisplaySku(row?.sku),
    String(row?.location || '').trim(),
    String(row?.note || '').trim(),
    Math.max(1, Number(row?.quantity) || 1),
  ].join('|');
}

function getPickRowsFromLineSummary(line) {
  const rows = [];
  [
    ['Must Pick', line?.mustPick],
    ['Desk Items', line?.deskItems],
    ['Needs Review', line?.reviewItems],
  ].forEach(([sectionTitle, sectionRows]) => {
    (Array.isArray(sectionRows) ? sectionRows : []).forEach((row) => {
      const sku = normalizeDisplaySku(row?.sku);
      if (!sku) return;
      rows.push({
        sku,
        quantity: Math.max(1, Number(row?.quantity) || 1),
        location: String(row?.location || '').trim(),
        note: String(row?.note || '').trim(),
        type: String(row?.type || row?.typeRaw || '').trim(),
        sectionTitle,
      });
    });
  });
  return rows;
}

function findPickRowsForOrderItem(orderItem = {}) {
  const sku = normalizeDisplaySku(orderItem?.sku);
  const bundleGroupId = String(orderItem?.bundleGroup?.id || '').trim();
  if (!sku && !bundleGroupId) return [];

  const matchedLines = (lastRenderedLineItems || []).filter((line) => {
    const lineSku = normalizeDisplaySku(line?.sku);
    const lineBundleGroupId = String(line?.bundleGroupId || '').trim();

    if (bundleGroupId && lineBundleGroupId) {
      return lineBundleGroupId === bundleGroupId && (!sku || !lineSku || lineSku === sku);
    }
    return sku && lineSku === sku;
  });

  const rowMap = new Map();
  matchedLines.flatMap(getPickRowsFromLineSummary)
    .filter((row) => normalizeDisplaySku(row?.sku) === sku)
    .forEach((row) => {
      const key = [
        row.sku,
        row.location,
        row.note,
        row.type,
        row.sectionTitle,
      ].join('|');
      if (!rowMap.has(key)) {
        rowMap.set(key, { ...row });
        return;
      }
      const existing = rowMap.get(key);
      existing.quantity += row.quantity;
    });

  return Array.from(rowMap.values()).sort(comparePickLocation);
}

function mergeVerifyPickRows(targetRow, pickRows = []) {
  if (!targetRow || !Array.isArray(pickRows) || !pickRows.length) return;
  const existingRows = Array.isArray(targetRow.pickRows) ? targetRow.pickRows : [];
  const rowMap = new Map(existingRows.map((row) => ([
    [row.sku, row.location, row.note, row.type, row.sectionTitle].join('|'),
    { ...row },
  ])));

  pickRows.forEach((row) => {
    const key = [row.sku, row.location, row.note, row.type, row.sectionTitle].join('|');
    if (!rowMap.has(key)) {
      rowMap.set(key, { ...row });
      return;
    }
    const existing = rowMap.get(key);
    existing.quantity += Math.max(1, Number(row.quantity) || 1);
  });

  targetRow.pickRows = Array.from(rowMap.values()).sort(comparePickLocation);
}

function getNoteQuantityMultiplier(noteText) {
  const note = String(noteText || '').trim().toUpperCase();
  if (!note) return 1;

  const quantities = [];
  const patterns = [
    /\b(\d{1,3})\s*(?:PCS?|PIECES?)\b/g,
    /\b(?:QTY|QUANTITY)\s*[:=\-]?\s*(\d{1,3})\b/g,
    /(?:^|[^A-Z0-9])X\s*(\d{1,3})(?=$|[^A-Z0-9])/g,
    /(?:^|[^A-Z0-9])(\d{1,3})\s*X(?=$|[^A-Z0-9])/g,
  ];

  patterns.forEach((pattern) => {
    let match = pattern.exec(note);
    while (match) {
      const quantity = Number(match[1]);
      if (Number.isFinite(quantity) && quantity > 1) {
        quantities.push(quantity);
      }
      match = pattern.exec(note);
    }
  });

  return quantities.length ? Math.max(...quantities) : 1;
}

function getPickRowRequiredCount(row) {
  const orderedQuantity = Math.max(1, Number(row?.quantity) || 1);
  const noteMultiplier = getNoteQuantityMultiplier(row?.note);
  return Math.max(1, orderedQuantity * noteMultiplier);
}

function getPickedRowCountsSnapshot() {
  const snapshot = {};
  currentPickedRowCounts.forEach((count, rowKey) => {
    const pickedCount = Math.max(0, Math.floor(Number(count) || 0));
    if (!rowKey || pickedCount <= 0) return;
    snapshot[rowKey] = pickedCount;
  });
  return snapshot;
}

function setPickedRowCountsFromPayload(pickedRowCounts) {
  currentPickedRowCounts = new Map();
  if (!pickedRowCounts || typeof pickedRowCounts !== 'object' || Array.isArray(pickedRowCounts)) {
    return;
  }

  Object.entries(pickedRowCounts).forEach(([rowKey, count]) => {
    const normalizedKey = String(rowKey || '').trim();
    const pickedCount = Math.max(0, Math.floor(Number(count) || 0));
    if (!normalizedKey || pickedCount <= 0) return;
    currentPickedRowCounts.set(normalizedKey, pickedCount);
  });
}

async function flushPickedRowCountsSave({ force = false } = {}) {
  if (!hasRenderedPickList || !currentOrderBarcode) return;
  if (!force && !pickerModeEnabled) return;

  if (pickedRowsSaveInFlight) {
    pickedRowsSaveQueued = true;
    return;
  }

  pickedRowsSaveInFlight = true;
  pickedRowsSaveQueued = false;

  try {
    const response = await fetch('/api/pick-list-picked-progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        barcode: currentOrderBarcode,
        pickedRowCounts: getPickedRowCountsSnapshot(),
      }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to save picked rows');
    }
  } catch (err) {
    console.error('Error saving picked rows:', err);
  } finally {
    pickedRowsSaveInFlight = false;
    if (pickedRowsSaveQueued) {
      pickedRowsSaveQueued = false;
      flushPickedRowCountsSave({ force });
    }
  }
}

function schedulePickedRowCountsSave() {
  if (!hasRenderedPickList || !currentOrderBarcode || !pickerModeEnabled) return;

  if (pickedRowsSaveTimeoutId) {
    clearTimeout(pickedRowsSaveTimeoutId);
  }

  pickedRowsSaveTimeoutId = setTimeout(() => {
    pickedRowsSaveTimeoutId = null;
    flushPickedRowCountsSave();
  }, 150);
}

async function flushPendingPickedRowCountsSave() {
  if (!pickedRowsSaveTimeoutId) return;

  clearTimeout(pickedRowsSaveTimeoutId);
  pickedRowsSaveTimeoutId = null;
  await flushPickedRowCountsSave({ force: true });
}

function sendPickedRowCountsBeacon() {
  if (!hasRenderedPickList || !currentOrderBarcode) return;
  if (!navigator.sendBeacon) return;

  const payload = JSON.stringify({
    barcode: currentOrderBarcode,
    pickedRowCounts: getPickedRowCountsSnapshot(),
  });
  const blob = new Blob([payload], { type: 'application/json' });
  navigator.sendBeacon('/api/pick-list-picked-progress', blob);
}

function getVerifyProgressSnapshot() {
  const progressByItemKey = {};
  verifyItems.forEach((row) => {
    const qty = Math.max(0, Math.floor(Number(row.scannedQty) || 0));
    if (qty <= 0) return;
    progressByItemKey[row.key] = qty;
  });
  return progressByItemKey;
}

function updateVerifyProgressCacheFromState() {
  lastVerifyProgressByItemKey = getVerifyProgressSnapshot();
}

async function flushVerifyProgressSave(force = false) {
  if (!hasRenderedPickList || !currentOrderBarcode) return;
  if (!force && (!verifyModeEnabled || wholesaleModeEnabled)) return;

  if (verifySaveInFlight) {
    verifySaveQueued = true;
    return;
  }

  verifySaveInFlight = true;
  verifySaveQueued = false;

  try {
    const response = await fetch('/api/pick-list-verify-progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        barcode: currentOrderBarcode,
        progressByItemKey: getVerifyProgressSnapshot(),
      }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to save verify progress');
    }
  } catch (err) {
    console.error('Error saving verify progress:', err);
  } finally {
    verifySaveInFlight = false;
    if (verifySaveQueued) {
      verifySaveQueued = false;
      flushVerifyProgressSave(force);
    }
  }
}

function scheduleVerifyProgressSave() {
  if (!verifyModeEnabled || wholesaleModeEnabled) return;

  updateVerifyProgressCacheFromState();

  if (verifySaveTimeoutId) {
    clearTimeout(verifySaveTimeoutId);
  }

  verifySaveTimeoutId = setTimeout(() => {
    verifySaveTimeoutId = null;
    flushVerifyProgressSave(false);
  }, 150);
}

async function flushPendingVerifyProgressSave() {
  if (!verifySaveTimeoutId) return;

  clearTimeout(verifySaveTimeoutId);
  verifySaveTimeoutId = null;
  await flushVerifyProgressSave(true);
}

function sendVerifyProgressBeacon() {
  if (!hasRenderedPickList || !currentOrderBarcode || !verifyModeEnabled || wholesaleModeEnabled) return;
  if (!navigator.sendBeacon) return;

  const payload = JSON.stringify({
    barcode: currentOrderBarcode,
    progressByItemKey: getVerifyProgressSnapshot(),
  });
  const blob = new Blob([payload], { type: 'application/json' });
  navigator.sendBeacon('/api/pick-list-verify-progress', blob);
}

function getPickedRowCount(rowKey) {
  return Math.max(0, Number(currentPickedRowCounts.get(rowKey)) || 0);
}

function isPickedRowComplete(rowKey, requiredCount) {
  return getPickedRowCount(rowKey) >= requiredCount;
}

function setPickProgressValue(progress, pickedCount, requiredCount) {
  if (!progress) return;

  progress.innerHTML = '';

  const current = document.createElement('span');
  current.className = 'pick-list-pick-progress-current';
  current.textContent = String(pickedCount);

  const divider = document.createElement('span');
  divider.className = 'pick-list-pick-progress-divider';
  divider.textContent = '/';

  const target = document.createElement('span');
  target.className = 'pick-list-pick-progress-target';
  target.textContent = String(requiredCount);

  progress.appendChild(current);
  progress.appendChild(divider);
  progress.appendChild(target);
  progress.title = `Picked ${pickedCount} of ${requiredCount}`;
}

function syncPickedRowState(rowKey, item, checkbox, progress, requiredCount) {
  const pickedCount = Math.min(getPickedRowCount(rowKey), requiredCount);
  const isComplete = pickedCount >= requiredCount;

  item.classList.toggle('pick-list-item--picked', isComplete);
  item.classList.toggle('pick-list-item--picked-partial', pickedCount > 0 && !isComplete);

  if (checkbox) {
    checkbox.checked = isComplete;
  }

  setPickProgressValue(progress, pickedCount, requiredCount);
}

function setPickedRowCount(rowKey, item, checkbox, progress, requiredCount, nextCount, row = null) {
  const previousCount = Math.min(getPickedRowCount(rowKey), requiredCount);
  const normalizedCount = Math.max(0, Math.min(requiredCount, Number(nextCount) || 0));

  if (normalizedCount > 0) {
    currentPickedRowCounts.set(rowKey, normalizedCount);
  } else {
    currentPickedRowCounts.delete(rowKey);
  }

  syncPickedRowState(rowKey, item, checkbox, progress, requiredCount);
  schedulePickedRowCountsSave();
  maybeShowHpaTankRegRemovalPopupForPickRow(row, rowKey, previousCount, normalizedCount);
}

function togglePickedRowState(rowKey, item, checkbox, progress, requiredCount, row = null) {
  const currentCount = getPickedRowCount(rowKey);
  const nextCount = currentCount >= requiredCount ? 0 : currentCount + 1;
  setPickedRowCount(rowKey, item, checkbox, progress, requiredCount, nextCount, row);
}

function createPickedCheckbox(rowKey, sku, item, progress, requiredCount, row = null) {
  const label = document.createElement('label');
  label.className = 'pick-list-picked-toggle';
  label.title = `Mark ${normalizeDisplaySku(sku)} as picked`;

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = isPickedRowComplete(rowKey, requiredCount);
  checkbox.setAttribute('aria-label', `Mark ${normalizeDisplaySku(sku)} as picked`);
  checkbox.addEventListener('click', (event) => {
    event.stopPropagation();
    setPickedRowCount(rowKey, item, checkbox, progress, requiredCount, checkbox.checked ? requiredCount : 0, row);
  });

  label.appendChild(checkbox);
  return { label, checkbox };
}

function renderRows(container, rows, emptyText, sectionTitle = '') {
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
  locationHeader.textContent = 'Bay / Tray';

  const noteHeader = document.createElement('div');
  noteHeader.className = 'pick-list-cell pick-list-col-note';
  noteHeader.textContent = 'Note';

  const actionHeader = document.createElement('div');
  actionHeader.className = 'pick-list-cell pick-list-col-action';
  actionHeader.textContent = qcModeEnabled ? '' : 'Action';

  headerItem.appendChild(skuHeader);
  headerItem.appendChild(locationHeader);
  headerItem.appendChild(noteHeader);
  headerItem.appendChild(actionHeader);
  list.appendChild(headerItem);

  const sortedRows = [...rows].sort(comparePickLocation);

  sortedRows.forEach((row, rowIndex) => {
    const item = document.createElement('li');
    item.className = 'pick-list-item';
    const rowKey = getPickRowKey(row, sectionTitle, rowIndex);
    const requiredPickCount = getPickRowRequiredCount(row);
    const noteText = String(row.note || '').trim();
    const noteIndicatesQuantity = getNoteQuantityMultiplier(noteText) > 1;
    const shouldReplaceNoteWithProgress = pickerModeEnabled && noteIndicatesQuantity && requiredPickCount > 1;
    const isAwaitingParts = isAwaitingPartsSku(row.sku);
    const awaitingPartsQty = getAwaitingPartsQty(row.sku);
    if (isAwaitingParts) {
      item.classList.add('pick-list-item--awaiting-parts');
    }
    if (isHpaTankPickRow(row)) {
      item.classList.add('pick-list-item--hpa-tank-warning');
    }

    let pickedCheckbox = null;
    let pickProgress = null;
    const main = document.createElement('div');
    main.className = 'pick-list-cell pick-list-col-sku pick-list-item-main';
    if (pickerModeEnabled) {
      item.classList.add('pick-list-item--pickable');
      if (requiredPickCount > 1) {
        pickProgress = document.createElement('span');
        pickProgress.className = 'pick-list-pick-progress';
      }
      const pickedControl = createPickedCheckbox(rowKey, row.sku, item, pickProgress, requiredPickCount, row);
      pickedCheckbox = pickedControl.checkbox;
      main.appendChild(pickedControl.label);
    }
    const skuText = document.createElement('span');
    skuText.textContent = Number(row.quantity) > 1 ? `${row.sku} x${row.quantity}` : `${row.sku}`;
    main.appendChild(skuText);
    if (pickProgress && !shouldReplaceNoteWithProgress) {
      main.appendChild(pickProgress);
    }
    if (isAwaitingParts) {
      const badge = document.createElement('span');
      badge.className = 'pick-list-awaiting-parts-badge';
      badge.textContent = awaitingPartsQty > 1 ? `Awaiting Parts x${awaitingPartsQty}` : 'Awaiting Parts';
      main.appendChild(badge);
    }

    const location = renderLocationCell(row.location);

    const note = document.createElement('div');
    note.className = 'pick-list-cell pick-list-col-note pick-list-item-note';
    if (shouldReplaceNoteWithProgress) {
      note.classList.add('pick-list-item-note--pick-progress');
      note.appendChild(pickProgress);
    } else {
      note.textContent = noteText;
    }

    const action = document.createElement('div');
    action.className = 'pick-list-cell pick-list-col-action pick-list-item-action';
    if (!qcModeEnabled) {
      if (isPrintablePickListType(row.typeRaw || row.type)) {
        action.appendChild(createGettingLowButton(row));
      }
      action.appendChild(createAwaitingToggleButton(row.sku));
    }

    item.appendChild(main);
    item.appendChild(location);
    item.appendChild(note);
    item.appendChild(action);

    if (pickerModeEnabled) {
      syncPickedRowState(rowKey, item, pickedCheckbox, pickProgress, requiredPickCount);
      item.addEventListener('click', (event) => {
        if (event.target.closest('.pick-list-item-action, .pick-list-picked-toggle')) {
          return;
        }
        togglePickedRowState(rowKey, item, pickedCheckbox, pickProgress, requiredPickCount, row);
      });
    }

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

  renderRows(content, rows, emptyText, title);
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

function getRenderedPickerRowKeySet(lineItems = lastRenderedLineItems) {
  const rowKeys = new Set();

  (lineItems || []).forEach((line) => {
    [
      ['Must Pick', line?.mustPick],
      ['Needs Review', line?.reviewItems],
    ].forEach(([sectionTitle, rows]) => {
      if (!Array.isArray(rows) || rows.length === 0) return;
      [...rows].sort(comparePickLocation).forEach((row, rowIndex) => {
        rowKeys.add(getPickRowKey(row, sectionTitle, rowIndex));
      });
    });
  });

  return rowKeys;
}

function prunePickedRowCountsToRenderedRows() {
  if (!pickerModeEnabled || !hasRenderedPickList || !currentOrderBarcode) return;

  const renderedKeys = getRenderedPickerRowKeySet();
  let changed = false;

  Array.from(currentPickedRowCounts.keys()).forEach((rowKey) => {
    if (renderedKeys.has(rowKey)) return;
    currentPickedRowCounts.delete(rowKey);
    changed = true;
  });

  if (changed) {
    schedulePickedRowCountsSave();
  }
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
    const lineValueAmount = Number(item?.priceAmount || 0);
    const lineValueCurrency = String(item?.priceCurrency || '').trim().toUpperCase();
    const requiresRegRemoval = isHpaTankWarningSku(sku);
    const pickRows = findPickRowsForOrderItem(item);

    const normalizedSku = normalizeVerifyCode(sku);
    const normalizedUpc = normalizeVerifyCode(upc);
    const lineStableId = String(item?.id || '').trim() || `ORDER_ITEM_${index + 1}`;
    const isWholesaleBundle = wholesaleModeEnabled && Boolean(bundleGroupId);
    // Keep no-SKU rows separate even if UPC matches, so duplicate UPC items
    // are verified one item at a time.
    const rowBaseKey = normalizedSku ? `SKU:${normalizedSku}` : `LINE:${lineStableId}`;
    const key = isWholesaleBundle
      ? `bundle:${bundleGroupId}`
      : `${bundleGroupId ? `bundle:${bundleGroupId}` : 'ungrouped'}::${rowBaseKey}`;

    if (bundleGroupId && !bundleOrder.has(bundleGroupId)) {
      bundleOrder.set(bundleGroupId, index);
    }

    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        sku: isWholesaleBundle ? 'Bundle' : (sku || '(No SKU)'),
        upc: isWholesaleBundle ? '' : upc,
        productName: isWholesaleBundle
          ? (bundleGroupTitle ? `Bundle: ${bundleGroupTitle}` : 'Bundle adapter')
          : (productName || sku || upc || `Item ${index + 1}`),
        bundleGroupId,
        bundleGroupTitle,
        bundleGroupQuantity,
        isWholesaleBundle,
        bundleItemCount: 0,
        bundleParts: [],
        sortIndex: index,
        requiredQty: 0,
        scannedQty: 0,
        codes: new Set(),
        totalValueAmount: 0,
        unitValueAmount: 0,
        valueCurrency: lineValueCurrency || 'GBP',
        requiresRegRemoval: false,
        pickRows: [],
      });
    }

    const row = grouped.get(key);
    row.requiresRegRemoval = row.requiresRegRemoval || requiresRegRemoval;
    mergeVerifyPickRows(row, pickRows);
    row.sortIndex = Math.min(row.sortIndex, index);
    if (Number.isFinite(lineValueAmount) && lineValueAmount > 0) {
      row.totalValueAmount += lineValueAmount;
    }
    if (!row.valueCurrency && lineValueCurrency) {
      row.valueCurrency = lineValueCurrency;
    }
    if (isWholesaleBundle) {
      row.bundleItemCount += 1;
      row.bundleParts.push({
        sku: sku || '(No SKU)',
        productName: productName || sku || upc || `Item ${index + 1}`,
        quantity: qty,
      });
      row.requiredQty = Math.max(
        row.requiredQty,
        Math.max(1, Number(bundleGroupQuantity) || 1)
      );
      return;
    }

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

  verifyItems.forEach((row) => {
    const requiredQty = Math.max(1, Number(row.requiredQty) || 1);
    row.unitValueAmount = row.totalValueAmount > 0
      ? Number((row.totalValueAmount / requiredQty).toFixed(4))
      : 0;
    row.valueCurrency = String(row.valueCurrency || 'GBP').trim().toUpperCase() || 'GBP';
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
  if (wholesaleModeEnabled) {
    return 'Build +1';
  }
  if (!row?.codes || row.codes.size <= 0) {
    return 'Mark +1';
  }
  return 'Scan +1';
}

async function fetchShippingJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const err = new Error(data.error || 'Shipping request failed');
    err.data = data;
    throw err;
  }
  return data;
}

async function loadVerifyShippingLookup() {
  if (!shouldShowVerifyShippingPanel() || shippingLookupInFlight) return;
  const barcode = String(currentOrderBarcode || '').trim().toUpperCase();
  if (!barcode) return;

  if (shippingPanelState.barcode !== barcode) {
    resetShippingPanelState(barcode);
  }

  if (shippingPanelState.status !== 'idle') return;

  const requestToken = shippingRequestToken + 1;
  shippingRequestToken = requestToken;
  shippingLookupInFlight = true;
  setShippingPanelState({ status: 'loading_lookup', error: '', actionLoading: 'lookup' });
  renderVerifyShippingModal();
  renderCurrentOrderSection();

  try {
    const data = await fetchShippingJson('/api/pick-list/shipping/lookup', {
      method: 'POST',
      body: JSON.stringify({ barcode }),
    });
    if (requestToken !== shippingRequestToken) return;

    const existingLabels = Array.isArray(data.existingLabels) ? data.existingLabels : [];
    const existingLabel = existingLabels.find((label) => !isShippingLabelVoided(label)) || existingLabels[0] || null;
    const packageDefaults = data.shipment ? getShippingPackageStateFromShipment(data.shipment) : {};
    if (!data.payment?.canShip) {
      setShippingPanelState({
        status: 'payment_blocked',
        actionLoading: '',
        orderNumber: data.orderNumber || currentOrderNumber,
        payment: data.payment || null,
        attemptedIdentifiers: data.attemptedIdentifiers || [],
      });
    } else if (existingLabel?.labelId && !isShippingLabelVoided(existingLabel)) {
      setShippingPanelState({
        status: 'purchased',
        actionLoading: '',
        orderNumber: data.orderNumber || currentOrderNumber,
        payment: data.payment || null,
        shipment: data.shipment || null,
        selectedAttemptLabel: data.selectedAttemptLabel || '',
        attemptedIdentifiers: data.attemptedIdentifiers || [],
        attemptedQueries: data.attemptedQueries || [],
        label: existingLabel,
        reusedExistingLabel: true,
        ...packageDefaults,
      });
    } else if (existingLabel?.labelId && data.shipmentFound && data.shipment) {
      setShippingPanelState({
        status: 'shipment_found',
        actionLoading: '',
        orderNumber: data.orderNumber || currentOrderNumber,
        payment: data.payment || null,
        shipment: data.shipment,
        selectedAttemptLabel: data.selectedAttemptLabel || '',
        attemptedIdentifiers: data.attemptedIdentifiers || [],
        attemptedQueries: data.attemptedQueries || [],
        label: existingLabel,
        reusedExistingLabel: false,
        ...packageDefaults,
      });
    } else if (data.shipmentFound && data.shipment) {
      setShippingPanelState({
        status: 'shipment_found',
        actionLoading: '',
        orderNumber: data.orderNumber || currentOrderNumber,
        payment: data.payment || null,
        shipment: data.shipment,
        selectedAttemptLabel: data.selectedAttemptLabel || '',
        attemptedIdentifiers: data.attemptedIdentifiers || [],
        attemptedQueries: data.attemptedQueries || [],
        ...packageDefaults,
      });
    } else {
      setShippingPanelState({
        status: 'no_shipment',
        actionLoading: '',
        orderNumber: data.orderNumber || currentOrderNumber,
        payment: data.payment || null,
        shipment: null,
        selectedAttemptLabel: data.selectedAttemptLabel || '',
        attemptedIdentifiers: data.attemptedIdentifiers || [],
        attemptedQueries: data.attemptedQueries || [],
      });
    }
  } catch (err) {
    if (requestToken !== shippingRequestToken) return;
    setShippingPanelState({
      status: 'error',
      actionLoading: '',
      error: err.message || 'Failed to load shipping details',
      payment: err.data?.payment || shippingPanelState.payment,
      label: err.data?.label || shippingPanelState.label,
    });
  } finally {
    if (requestToken === shippingRequestToken) {
      shippingLookupInFlight = false;
      renderVerifyShippingModal();
      renderCurrentOrderSection();
      queueVerifyShippingRateRefresh({ force: true, delay: 0 });
    }
  }
}

async function rateVerifyShippingShipment({ automatic = false, force = false } = {}) {
  if (shippingPanelState.actionLoading || loading) return;
  const shipmentId = String(shippingPanelState.shipment?.shipmentId || '').trim();
  const rateInputSignature = getShippingRateInputSignature();
  if (!force && rateInputSignature && shippingPanelState.status === 'rates' && shippingPanelState.rateInputSignature === rateInputSignature) {
    return;
  }
  if (!shipmentId) {
    if (!automatic) setStatus('No ShipStation shipment selected.', 'error');
    return;
  }
  const packages = getNormalizedShippingPackages();
  if (packages.length !== getShippingPackageRows().length) {
    if (!automatic) setStatus('Enter valid weights and package sizes for every package.', 'error');
    return;
  }
  const weightGrams = packages.reduce((sum, pkg) => sum + Math.max(1, Number(pkg.weightGrams) || 1), 0);
  const packageDimensions = packages[0]?.packageDimensions || null;

  setShippingPanelState({ actionLoading: 'rates', error: '', rateDiagnostics: null });
  renderVerifyShippingModal();
  renderCurrentOrderSection();

  try {
    const data = await fetchShippingJson('/api/pick-list/shipping/rates', {
      method: 'POST',
      body: JSON.stringify({
        barcode: currentOrderBarcode,
        shipmentId,
        weightGrams,
        packageDimensions,
        packages,
      }),
    });
    const rates = Array.isArray(data.rates) ? data.rates : [];
    setShippingPanelState({
      status: 'rates',
      actionLoading: '',
      payment: data.payment || shippingPanelState.payment,
      shipment: data.shipment || shippingPanelState.shipment,
      rates,
      selectedQuoteId: rates[0]?.quoteId || '',
      expiresAt: data.expiresAt || '',
      noRateReason: data.noRateReason || '',
      rateDiagnostics: data.rateDiagnostics || null,
      rateInputSignature,
    });
  } catch (err) {
    setShippingPanelState({
      status: err.data?.rateError ? 'shipment_found' : shippingPanelState.status,
      actionLoading: '',
      error: err.message || 'Failed to check shipping rates',
      payment: err.data?.payment || shippingPanelState.payment,
      shipment: err.data?.shipment || shippingPanelState.shipment,
      rates: [],
      selectedQuoteId: '',
      expiresAt: '',
      noRateReason: '',
      rateDiagnostics: err.data?.rateDiagnostics || null,
      rateInputSignature: '',
    });
    setStatus(`Shipping error: ${err.message}`, 'error');
  } finally {
    renderVerifyShippingModal();
    renderCurrentOrderSection();
  }
}

async function buyVerifyShippingLabel() {
  if (shippingPanelState.actionLoading || loading) return;
  if (!canBuyShippingLabelForCurrentOrder()) {
    setStatus(getShippingPurchaseLockedMessage(), 'error');
    return;
  }
  const rate = getSelectedShippingRate();
  if (!rate?.quoteId) {
    setStatus('Select a shipping rate first.', 'error');
    return;
  }

  setShippingPanelState({ actionLoading: 'buy', error: '' });
  renderVerifyShippingModal();
  renderCurrentOrderSection();
  setStatus('Buying ShipStation label...', 'info');

  try {
    const data = await fetchShippingJson('/api/pick-list/shipping/labels', {
      method: 'POST',
      body: JSON.stringify({ quoteId: rate.quoteId }),
    });
    const label = data.label || null;
    setShippingPanelState({
      status: 'purchased',
      actionLoading: '',
      payment: data.payment || shippingPanelState.payment,
      label,
      reusedExistingLabel: Boolean(data.reusedExistingLabel),
    });

    if (label?.printStatus === 'error') {
      setStatus(`Label bought, but printing failed: ${label.printError || 'PrintNode error'}`, 'error');
    } else if (data.reusedExistingLabel) {
      setStatus('Existing ShipStation label found. No new label was bought.', 'info');
    } else {
      setStatus('Label bought and sent to PrintNode.', 'success');
      closeVerifyShippingModal();
    }
  } catch (err) {
    setShippingPanelState({
      actionLoading: '',
      error: err.message || 'Failed to buy shipping label',
      payment: err.data?.payment || shippingPanelState.payment,
      label: err.data?.label || shippingPanelState.label,
    });
    setStatus(`Shipping error: ${err.message}`, 'error');
  } finally {
    renderVerifyShippingModal();
    renderCurrentOrderSection();
  }
}

async function retryVerifyShippingLabelPrint() {
  if (shippingPanelState.actionLoading || loading) return;
  const labelId = String(shippingPanelState.label?.labelId || '').trim();
  if (!labelId) {
    setStatus('No purchased label to print.', 'error');
    return;
  }

  setShippingPanelState({ actionLoading: 'print', error: '' });
  renderVerifyShippingModal();
  renderCurrentOrderSection();
  setStatus('Sending label to PrintNode...', 'info');

  try {
    const data = await fetchShippingJson(`/api/pick-list/shipping/labels/${encodeURIComponent(labelId)}/print`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setShippingPanelState({
      actionLoading: '',
      label: data.label || shippingPanelState.label,
    });
    setStatus('Label sent to PrintNode.', 'success');
  } catch (err) {
    setShippingPanelState({
      actionLoading: '',
      error: err.message || 'Failed to print label',
      label: err.data?.label || shippingPanelState.label,
    });
    setStatus(`Print error: ${err.message}`, 'error');
  } finally {
    renderVerifyShippingModal();
    renderCurrentOrderSection();
  }
}

async function voidVerifyShippingLabel() {
  if (shippingPanelState.actionLoading || loading) return;
  const labelId = String(shippingPanelState.label?.labelId || '').trim();
  if (!labelId || isShippingLabelVoided()) {
    setStatus('No active shipping label to void.', 'error');
    return;
  }

  const confirmed = window.confirm('Void this ShipStation label? You will need to check rates and buy a new label before shipping.');
  if (!confirmed) return;

  setShippingPanelState({ actionLoading: 'void', error: '' });
  renderVerifyShippingModal();
  renderCurrentOrderSection();
  setStatus('Voiding ShipStation label...', 'info');

  try {
    const data = await fetchShippingJson(`/api/pick-list/shipping/labels/${encodeURIComponent(labelId)}/void`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setShippingPanelState({
      status: 'shipment_found',
      actionLoading: '',
      label: data.label || { ...shippingPanelState.label, status: 'voided' },
      reusedExistingLabel: false,
      rates: [],
      selectedQuoteId: '',
      expiresAt: '',
      noRateReason: '',
    });
    setStatus('ShipStation label voided. Check rates again before buying a replacement label.', 'success');
  } catch (err) {
    setShippingPanelState({
      actionLoading: '',
      error: err.message || 'Failed to void shipping label',
      label: err.data?.label || shippingPanelState.label,
    });
    setStatus(`Void error: ${err.message}`, 'error');
  } finally {
    renderVerifyShippingModal();
    renderCurrentOrderSection();
  }
}

function appendShippingDetail(container, label, value) {
  if (!value) return;
  const item = document.createElement('div');
  item.className = 'pick-shipping-detail';

  const labelEl = document.createElement('span');
  labelEl.textContent = label;

  const valueEl = document.createElement('strong');
  valueEl.textContent = value;

  item.appendChild(labelEl);
  item.appendChild(valueEl);
  container.appendChild(item);
}

function renderShippingShipmentDetails(container) {
  const shipment = shippingPanelState.shipment;
  if (!shipment) return;

  const details = document.createElement('div');
  details.className = 'pick-shipping-details';
  appendShippingDetail(details, 'Selected Service', formatShippingServiceCode(shipment.serviceCode));
  appendShippingDetail(details, 'Requested Service', formatRequestedShippingService(shipment));
  appendShippingDetail(details, 'Confirmation', formatShippingConfirmation(shipment.confirmation));
  appendShippingDetail(details, 'Insurance', formatShippingInsurance(shipment));
  container.appendChild(details);
}

function renderShippingPackageAllocationControls(packageRows) {
  const allocationRows = getShippingAllocationRows();
  if (packageRows.length <= 1 || !allocationRows.length) return null;

  const section = document.createElement('section');
  section.className = 'pick-shipping-allocation';

  const head = document.createElement('div');
  head.className = 'pick-shipping-allocation__head';
  const title = document.createElement('strong');
  title.textContent = 'Package contents';
  head.appendChild(title);

  const valueSummary = document.createElement('div');
  valueSummary.className = 'pick-shipping-allocation__values';
  packageRows.forEach((row, index) => {
    const insuranceValue = getShippingPackageInsuranceValue(row);
    const value = document.createElement('span');
    value.textContent = insuranceValue.amount > 0
      ? `P${index + 1}: ${formatShippingMoney(insuranceValue.amount, insuranceValue.currency)}`
      : `P${index + 1}: no value`;
    valueSummary.appendChild(value);
  });
  head.appendChild(valueSummary);
  section.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'pick-shipping-allocation-grid';
  grid.style.gridTemplateColumns = `minmax(190px, 1fr) 54px repeat(${packageRows.length}, minmax(64px, 82px))`;

  ['SKU / item', 'Total', ...packageRows.map((_, index) => `P${index + 1}`)].forEach((label) => {
    const cell = document.createElement('div');
    cell.className = 'pick-shipping-allocation-cell pick-shipping-allocation-cell--head';
    cell.textContent = label;
    grid.appendChild(cell);
  });

  allocationRows.forEach((allocationRow) => {
    const itemCell = document.createElement('div');
    itemCell.className = 'pick-shipping-allocation-cell pick-shipping-allocation-cell--item';
    const itemTitle = document.createElement('strong');
    itemTitle.textContent = allocationRow.skuLabel || allocationRow.productLabel;
    itemCell.appendChild(itemTitle);
    if (allocationRow.skuLabel && allocationRow.productLabel && allocationRow.productLabel !== allocationRow.skuLabel) {
      const itemSubtitle = document.createElement('span');
      itemSubtitle.textContent = allocationRow.productLabel;
      itemCell.appendChild(itemSubtitle);
    }
    grid.appendChild(itemCell);

    const totalCell = document.createElement('div');
    totalCell.className = 'pick-shipping-allocation-cell pick-shipping-allocation-cell--total';
    totalCell.textContent = String(allocationRow.requiredQty);
    grid.appendChild(totalCell);

    const counts = getShippingPackageAllocationCounts(allocationRow, packageRows);
    packageRows.forEach((_, packageIndex) => {
      const cell = document.createElement('label');
      cell.className = 'pick-shipping-allocation-cell pick-shipping-allocation-cell--input';
      const input = document.createElement('input');
      input.type = 'tel';
      input.inputMode = 'numeric';
      input.pattern = '[0-9]*';
      input.value = String(counts[packageIndex] || 0);
      input.setAttribute('aria-label', `${allocationRow.skuLabel || allocationRow.productLabel} quantity in Package ${packageIndex + 1}`);
      let committedValue = input.value;
      const commit = () => {
        const nextValue = String(Math.max(0, Math.floor(Number(input.value) || 0)));
        if (nextValue === committedValue) {
          input.value = committedValue;
          return;
        }
        committedValue = nextValue;
        setShippingAllocationCount(allocationRow, packageIndex, nextValue);
        renderVerifyShippingModal();
        if (hasRequiredShippingRateInputs()) {
          queueVerifyShippingRateRefresh({ force: true, delay: 0 });
        }
      };
      input.addEventListener('input', () => {
        input.value = String(input.value || '').replace(/\D/g, '').slice(0, 4);
      });
      input.addEventListener('focus', () => input.select());
      input.addEventListener('change', commit);
      input.addEventListener('blur', commit);
      cell.appendChild(input);
      grid.appendChild(cell);
    });
  });

  section.appendChild(grid);
  return section;
}

function renderShippingRateControls(container) {
  const form = document.createElement('div');
  form.className = 'pick-shipping-rate-form';
  let rateCheckButton = null;
  const packageRows = getShippingPackageRows();

  const syncRateCheckButtonState = () => {
    if (!rateCheckButton) {
      return;
    }
    const canCheckRates = hasRequiredShippingRateInputs();
    rateCheckButton.disabled = loading || Boolean(shippingPanelState.actionLoading) || !canCheckRates;
    rateCheckButton.title = canCheckRates
      ? ''
      : 'Enter package weight and package size first.';
  };

  const updatePackageRow = (index, patch, { rerender = true, refreshRates = true, rateDelay = 0 } = {}) => {
    const rows = getShippingPackageRows();
    const existingRow = rows[index] || makeShippingPackageRow();
    rows[index] = makeShippingPackageRow({
      ...existingRow,
      ...patch,
      packageDimensions: {
        ...(existingRow.packageDimensions || {}),
        ...(patch.packageDimensions || {}),
      },
    });
    setShippingPackageRows(rows);
    if (rerender) {
      renderVerifyShippingModal();
    } else {
      syncRateCheckButtonState();
    }
    if (refreshRates && hasRequiredShippingRateInputs()) {
      queueVerifyShippingRateRefresh({ force: true, delay: rateDelay });
    }
  };

  const updateWeightInputValue = (index, value) => {
    const visibleInput = form.querySelector(`[data-shipping-weight-index="${index}"]`);
    if (visibleInput) {
      visibleInput.value = value;
    }
  };

  const packageList = document.createElement('div');
  packageList.className = 'pick-shipping-package-list';

  packageRows.forEach((row, index) => {
    const packageCard = document.createElement('div');
    packageCard.className = 'pick-shipping-package-card';

    const packageHead = document.createElement('div');
    packageHead.className = 'pick-shipping-package-card__head';
    const packageTitle = document.createElement('strong');
    packageTitle.textContent = `Package ${index + 1}`;
    packageHead.appendChild(packageTitle);
    if (packageRows.length > 1) {
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'pick-shipping-package-remove';
      removeButton.textContent = 'Remove';
      removeButton.addEventListener('click', () => {
        activeShippingWeightPackageIndex = null;
        const currentRows = getShippingPackageRows();
        const removedItemIds = normalizeShippingPackageItemUnitIds(currentRows[index]?.itemUnitIds);
        const rows = currentRows.filter((_, rowIndex) => rowIndex !== index);
        if (removedItemIds.length && rows.length) {
          const targetIndex = index === 0 ? 0 : Math.max(0, index - 1);
          rows[targetIndex] = {
            ...rows[targetIndex],
            itemUnitIds: [
              ...(rows[targetIndex].itemUnitIds || []),
              ...removedItemIds,
            ],
          };
        }
        setShippingPackageRows(rows);
        renderVerifyShippingModal();
        if (hasRequiredShippingRateInputs()) {
          queueVerifyShippingRateRefresh({ force: true, delay: 0 });
        }
      });
      packageHead.appendChild(removeButton);
    }
    packageCard.appendChild(packageHead);

    const packageEntry = document.createElement('div');
    packageEntry.className = 'pick-shipping-package-entry';

    const packageLabel = document.createElement('label');
    packageLabel.className = 'pick-shipping-package-label';
    packageLabel.textContent = 'Package size';

    const packageSelect = document.createElement('select');
    packageSelect.className = 'pick-shipping-package-select';
    SHIPPING_PACKAGE_PRESETS.forEach((preset) => {
      const option = document.createElement('option');
      option.value = preset.key;
      option.textContent = formatShippingPresetOptionLabel(preset);
      packageSelect.appendChild(option);
    });
    packageSelect.value = row.packagePresetKey || 'custom';
    packageSelect.addEventListener('change', () => {
      const selectedKey = packageSelect.value;
      const presetDimensions = getPresetDimensions(selectedKey);
      const currentDimensions = getShippingPackageRowDimensions(row) || row.packageDimensions || {};
      updatePackageRow(index, {
        packagePresetKey: selectedKey,
        packageDimensions: presetDimensions || {
          length: normalizeShippingDimension(currentDimensions.length),
          width: normalizeShippingDimension(currentDimensions.width),
          height: normalizeShippingDimension(currentDimensions.height),
          unit: currentDimensions.unit || SHIPPING_PACKAGE_DIMENSION_UNIT,
        },
      });
    });
    packageLabel.appendChild(packageSelect);
    packageEntry.appendChild(packageLabel);

    if ((row.packagePresetKey || 'custom') === 'custom') {
      const customGrid = document.createElement('div');
      customGrid.className = 'pick-shipping-custom-dimensions';
      [
        ['length', 'Length'],
        ['width', 'Width'],
        ['height', 'Height'],
      ].forEach(([dimensionKey, dimensionLabel]) => {
        const dimensionField = document.createElement('label');
        dimensionField.textContent = dimensionLabel;

        const dimensionInput = document.createElement('input');
        dimensionInput.type = 'text';
        dimensionInput.inputMode = 'decimal';
        dimensionInput.value = row.packageDimensions?.[dimensionKey] || '';
        dimensionInput.placeholder = '0';
        dimensionInput.addEventListener('input', () => {
          const value = normalizeShippingDimension(dimensionInput.value);
          updatePackageRow(index, {
            packagePresetKey: 'custom',
            packageDimensions: {
              [dimensionKey]: value,
              unit: SHIPPING_PACKAGE_DIMENSION_UNIT,
            },
          }, { rerender: false, rateDelay: 600 });
          dimensionInput.value = value;
        });
        dimensionField.appendChild(dimensionInput);
        customGrid.appendChild(dimensionField);
      });

      const unit = document.createElement('span');
      unit.className = 'pick-shipping-dimension-unit';
      unit.textContent = 'centimetres';
      customGrid.appendChild(unit);
      packageEntry.appendChild(customGrid);
    }

    const weightEntry = document.createElement('div');
    weightEntry.className = 'pick-shipping-weight-entry';

    const weightLabel = document.createElement('label');
    weightLabel.className = 'pick-shipping-weight-label';
    weightLabel.textContent = 'Package weight';
    const input = document.createElement('input');
    input.type = 'tel';
    input.inputMode = 'none';
    input.pattern = '[0-9]*';
    input.autocomplete = 'off';
    input.enterKeyHint = 'done';
    input.value = row.weightGrams || '';
    input.placeholder = '0';
    input.dataset.shippingWeightIndex = String(index);
    weightLabel.appendChild(input);
    const unit = document.createElement('span');
    unit.className = 'pick-shipping-weight-unit';
    unit.textContent = 'grams';
    weightLabel.appendChild(unit);
    weightEntry.appendChild(weightLabel);

    input.addEventListener('input', () => {
      const digits = String(input.value || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 6);
      updatePackageRow(index, { weightGrams: digits }, { rerender: false, refreshRates: false });
      input.value = digits;
    });
    input.addEventListener('focus', () => {
      if (activeShippingWeightPackageIndex !== index) {
        activeShippingWeightPackageIndex = index;
        suppressShippingWeightBlurRefresh = true;
        renderVerifyShippingModal();
        window.requestAnimationFrame(() => {
          const focusedInput = document.querySelector(`[data-shipping-weight-index="${index}"]`);
          if (focusedInput instanceof HTMLInputElement) {
            focusedInput.focus();
            focusedInput.select();
          }
          suppressShippingWeightBlurRefresh = false;
        });
        return;
      }
      input.select();
    });
    input.addEventListener('blur', () => {
      if (suppressShippingWeightBlurRefresh) return;
      if (hasRequiredShippingRateInputs()) {
        queueVerifyShippingRateRefresh({ force: true, delay: 0 });
      }
    });

    packageCard.appendChild(packageEntry);
    packageCard.appendChild(weightEntry);

    packageList.appendChild(packageCard);
  });

  const renderWeightKeypad = () => {
    const index = Number(activeShippingWeightPackageIndex);
    if (!Number.isInteger(index) || index < 0 || index >= packageRows.length) {
      activeShippingWeightPackageIndex = null;
      return null;
    }

    const keypad = document.createElement('div');
    keypad.className = 'pick-shipping-weight-keypad';
    keypad.setAttribute('aria-label', `Package ${index + 1} weight keypad`);

    const setWeight = (value) => {
      const digits = String(value || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 6);
      updatePackageRow(index, { weightGrams: digits }, { rerender: false, refreshRates: false });
      updateWeightInputValue(index, digits);
    };

    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].forEach((digit) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pick-shipping-weight-keypad__key';
      button.textContent = digit;
      button.addEventListener('pointerdown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        const currentValue = getShippingPackageRows()[index]?.weightGrams || '';
        setWeight(`${currentValue}${digit}`);
      });
      keypad.appendChild(button);
    });

    const backButton = document.createElement('button');
    backButton.type = 'button';
    backButton.className = 'pick-shipping-weight-keypad__key pick-shipping-weight-keypad__key--back';
    backButton.textContent = 'Back';
    backButton.addEventListener('pointerdown', (event) => event.preventDefault());
    backButton.addEventListener('click', () => {
      const currentValue = String(getShippingPackageRows()[index]?.weightGrams || '');
      setWeight(currentValue.slice(0, -1));
    });
    keypad.appendChild(backButton);

    const submitButton = document.createElement('button');
    submitButton.type = 'button';
    submitButton.className = 'pick-shipping-weight-keypad__key pick-shipping-weight-keypad__key--submit';
    submitButton.textContent = 'Submit';
    submitButton.addEventListener('pointerdown', (event) => event.preventDefault());
    submitButton.addEventListener('click', () => {
      activeShippingWeightPackageIndex = null;
      renderVerifyShippingModal();
      if (hasRequiredShippingRateInputs()) {
        queueVerifyShippingRateRefresh({ force: true, delay: 0 });
      }
    });
    keypad.appendChild(submitButton);

    return keypad;
  };

  const addPackageButton = document.createElement('button');
  addPackageButton.type = 'button';
  addPackageButton.className = 'pick-shipping-package-add';
  addPackageButton.textContent = 'Add Package';
  addPackageButton.disabled = loading || Boolean(shippingPanelState.actionLoading) || packageRows.length >= 8;
  addPackageButton.addEventListener('click', () => {
    const firstRow = getShippingPackageRows()[0] || makeShippingPackageRow();
    setShippingPackageRows([
      ...getShippingPackageRows(),
      makeShippingPackageRow({
        packagePresetKey: firstRow.packagePresetKey,
        packageDimensions: firstRow.packageDimensions,
      }),
    ]);
    renderVerifyShippingModal();
  });

  if (shippingPanelState.status !== 'rates' || shippingPanelState.actionLoading === 'rates') {
    rateCheckButton = document.createElement('button');
    rateCheckButton.type = 'button';
    rateCheckButton.className = 'pick-shipping-rate-check';
    rateCheckButton.classList.toggle('is-loading', shippingPanelState.actionLoading === 'rates');
    rateCheckButton.textContent = shippingPanelState.actionLoading === 'rates'
      ? 'Checking Rates...'
      : 'Check Rates';
    syncRateCheckButtonState();
    rateCheckButton.addEventListener('click', () => rateVerifyShippingShipment({ force: true }));
  }

  const allocationControls = renderShippingPackageAllocationControls(packageRows);
  const weightKeypad = renderWeightKeypad();

  form.appendChild(packageList);
  if (weightKeypad) {
    form.appendChild(weightKeypad);
  }
  if (allocationControls) {
    form.appendChild(allocationControls);
  }
  form.appendChild(addPackageButton);
  if (rateCheckButton) {
    form.appendChild(rateCheckButton);
  }
  container.appendChild(form);
}

function normalizeShippingDiagnosticMessages(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap(normalizeShippingDiagnosticMessages).filter(Boolean);
  }
  if (typeof value === 'object') {
    const message = String(value.message || value.error || value.detail || value.reason || value.code || '').trim();
    return message ? [message] : [JSON.stringify(value)];
  }
  return [String(value || '').trim()].filter(Boolean);
}

function appendShippingDiagnosticList(container, titleText, messages) {
  const items = normalizeShippingDiagnosticMessages(messages);
  if (!items.length) return;

  const section = document.createElement('section');
  section.className = 'pick-shipping-rate-diagnostics__section';

  const title = document.createElement('strong');
  title.textContent = titleText;
  section.appendChild(title);

  const list = document.createElement('ul');
  items.forEach((message) => {
    const item = document.createElement('li');
    item.textContent = message;
    list.appendChild(item);
  });
  section.appendChild(list);
  container.appendChild(section);
}

function appendShippingDiagnosticDetails(container, titleText, value) {
  if (!value) return;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!String(text || '').trim()) return;

  const details = document.createElement('details');
  details.className = 'pick-shipping-rate-diagnostics__details';

  const summary = document.createElement('summary');
  summary.textContent = titleText;
  details.appendChild(summary);

  const pre = document.createElement('pre');
  pre.textContent = text;
  details.appendChild(pre);

  container.appendChild(details);
}

function hasShippingDimensionSet(dimensions) {
  if (!dimensions || typeof dimensions !== 'object') return false;
  return ['length', 'width', 'height'].every((key) => Number(dimensions[key]) > 0);
}

function buildShippingDiagnosticReasonMessages(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return [];

  const reasons = [];
  const counts = diagnostics.counts || {};
  const shipment = diagnostics.shipment || {};
  const context = diagnostics.context || {};
  const requestBody = diagnostics.request?.body || {};
  const packages = Array.isArray(diagnostics.packages) ? diagnostics.packages : [];
  const shipTo = shipment.shipTo || {};
  const shipFrom = shipment.shipFrom || {};

  if (Number(counts.rawRateCount || 0) === 0 && Number(counts.invalidRateCount || 0) === 0) {
    reasons.push('ShipStation returned zero rates and zero invalid-rate explanations. This usually means the selected carrier/service/defaults cannot rate this shipment through the API.');
  } else if (Number(counts.validRateCount || 0) === 0) {
    reasons.push('ShipStation returned rate data, but every rate was rejected or missing a usable rate id.');
  }

  if (!context.carrierId && !shipment.carrierCode && !shipment.carrierFriendlyName) {
    reasons.push('No carrier is selected on the ShipStation shipment.');
  }
  if (!shipment.serviceCode && !shipment.requestedShipmentService && !requestBody.rate_options?.service_codes?.length) {
    reasons.push('No true shipping service is selected on the ShipStation shipment.');
  }
  if (!shipment.packageCode && !requestBody.rate_options?.package_types?.length) {
    reasons.push('No ShipStation package type is selected. Use a known package type or set better defaults in ShipStation.');
  }
  if (!shipment.shipDate) {
    reasons.push('Ship date is missing. ShipStation can reject labels or rates when the shipment date is absent or old.');
  }

  if (packages.length && packages.some((pkg) => !Number(pkg.weightGrams))) {
    reasons.push('At least one package has no valid weight.');
  }
  if (packages.length && packages.some((pkg) => !hasShippingDimensionSet(pkg.packageDimensions || pkg.dimensions))) {
    reasons.push('At least one package has missing package dimensions.');
  }
  if (packages.length > 1 && packages.some((pkg) => Number(pkg.insuredValueAmount || pkg.insuranceValueAmount || 0) < 0)) {
    reasons.push('At least one package has an invalid insurance value.');
  }

  if (!shipTo.name) reasons.push('Destination name is missing. If the customer only has a company name, ShipStation needs that copied into name.');
  if (!shipTo.addressLine1) reasons.push('Destination address line 1 is missing.');
  if (!shipTo.city) reasons.push('Destination city is missing.');
  if (!shipTo.postalCode) reasons.push('Destination postcode/ZIP is missing.');
  if (!shipTo.countryCode) reasons.push('Destination country is missing.');
  if (!shipFrom.addressLine1 || !shipFrom.postalCode || !shipFrom.countryCode) {
    reasons.push('Ship-from address is incomplete in ShipStation.');
  }

  if (shipment.serviceCode || requestBody.rate_options?.service_codes?.length) {
    reasons.push('The selected service may not be valid for the destination country, package size, weight, customs setup or carrier account.');
  }
  if (shipTo.countryCode && shipTo.countryCode !== 'GB') {
    reasons.push('International shipments can fail rating if customs declarations, item values, HS codes, carrier terms or recipient phone/email details are missing in ShipStation.');
  }
  if (shipment.insuranceProvider && shipment.insuranceProvider !== 'none') {
    reasons.push('Insurance can block rates if package values, currency or carrier insurance rules are not acceptable.');
  }

  return Array.from(new Set(reasons));
}

function renderShippingRateDiagnostics(container) {
  const diagnostics = shippingPanelState.rateDiagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') return;

  const panel = document.createElement('div');
  panel.className = 'pick-shipping-rate-diagnostics';

  const title = document.createElement('strong');
  title.textContent = 'ShipStation diagnostic details';
  panel.appendChild(title);

  appendShippingDiagnosticList(panel, 'ShipStation response errors', diagnostics.response?.errors);
  appendShippingDiagnosticList(panel, 'Possible reasons to check', buildShippingDiagnosticReasonMessages(diagnostics));

  const invalidRates = Array.isArray(diagnostics.invalidRates) ? diagnostics.invalidRates : [];
  if (invalidRates.length) {
    const section = document.createElement('section');
    section.className = 'pick-shipping-rate-diagnostics__section';
    const heading = document.createElement('strong');
    heading.textContent = 'Invalid rates returned';
    section.appendChild(heading);

    const list = document.createElement('ul');
    invalidRates.forEach((rate, index) => {
      const item = document.createElement('li');
      const service = [
        rate.carrierName || rate.carrierCode,
        rate.serviceName || rate.serviceCode,
        rate.packageCode,
      ].filter(Boolean).join(' / ') || `Invalid rate ${index + 1}`;
      const messages = [
        ...normalizeShippingDiagnosticMessages(rate.errors),
        ...normalizeShippingDiagnosticMessages(rate.warnings).map((warning) => `Warning: ${warning}`),
      ];
      item.textContent = messages.length ? `${service}: ${messages.join('; ')}` : service;
      list.appendChild(item);
    });
    section.appendChild(list);
    panel.appendChild(section);
  }

  const rejectedRates = (Array.isArray(diagnostics.rates) ? diagnostics.rates : [])
    .filter((rate) => (
      normalizeShippingDiagnosticMessages(rate.errorMessages).length > 0
      || normalizeShippingDiagnosticMessages(rate.warningMessages).length > 0
      || String(rate.validationStatus || '').trim()
    ));
  if (rejectedRates.length) {
    const messages = rejectedRates.map((rate, index) => {
      const service = [
        rate.carrierName || rate.carrierCode,
        rate.serviceName || rate.serviceCode,
        rate.packageCode,
      ].filter(Boolean).join(' / ') || `Rate ${index + 1}`;
      const parts = [
        rate.validationStatus ? `Status: ${rate.validationStatus}` : '',
        ...normalizeShippingDiagnosticMessages(rate.errorMessages),
        ...normalizeShippingDiagnosticMessages(rate.warningMessages).map((warning) => `Warning: ${warning}`),
      ].filter(Boolean);
      return parts.length ? `${service}: ${parts.join('; ')}` : service;
    });
    appendShippingDiagnosticList(panel, 'Rejected or warning rates', messages);
  }

  appendShippingDiagnosticDetails(panel, 'Request, shipment and package data', {
    request: diagnostics.request || null,
    context: diagnostics.context || null,
    shipment: diagnostics.shipment || null,
    packages: diagnostics.packages || null,
    counts: diagnostics.counts || null,
  });
  appendShippingDiagnosticDetails(panel, 'Raw ShipStation errors', diagnostics.response?.rawErrors);
  appendShippingDiagnosticDetails(panel, 'Raw invalid rate data', invalidRates);

  container.appendChild(panel);
}

function renderShippingRates(container) {
  const rates = Array.isArray(shippingPanelState.rates) ? shippingPanelState.rates : [];
  if (!rates.length) {
    if (shippingPanelState.noRateReason) {
      const noRate = document.createElement('div');
      noRate.className = 'pick-shipping-no-rate';
      noRate.textContent = shippingPanelState.noRateReason;
      container.appendChild(noRate);
    }
    renderShippingRateDiagnostics(container);
    return;
  }

  const list = document.createElement('div');
  list.className = 'pick-shipping-rates';

  rates.forEach((rate, index) => {
    const option = document.createElement('label');
    option.className = 'pick-shipping-rate';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'pickShippingRate';
    radio.value = rate.quoteId;
    radio.checked = shippingPanelState.selectedQuoteId
      ? shippingPanelState.selectedQuoteId === rate.quoteId
      : index === 0;
    radio.addEventListener('change', () => {
      setShippingPanelState({ selectedQuoteId: rate.quoteId });
      renderCurrentOrderSection();
    });

    const body = document.createElement('span');
    body.className = 'pick-shipping-rate__body';

    const service = document.createElement('strong');
    service.textContent = formatShippingService(rate);

    const meta = document.createElement('span');
    const delivery = rate.deliveryDays ? `${rate.deliveryDays} day${rate.deliveryDays === 1 ? '' : 's'}` : '';
    meta.textContent = [rate.serviceCode, delivery].filter(Boolean).join(' | ');

    const price = document.createElement('b');
    if (rate.priceUnavailable) {
      price.className = 'pick-shipping-rate__no-price';
      price.textContent = rate.priceUnavailableReason || 'No quote';
    } else {
      price.textContent = formatShippingMoney(rate.priceAmount, rate.priceCurrency);
    }

    body.appendChild(service);
    if (meta.textContent) body.appendChild(meta);
    option.appendChild(radio);
    option.appendChild(body);
    option.appendChild(price);
    list.appendChild(option);
  });

  if (!canBuyShippingLabelForCurrentOrder()) {
    const blocker = document.createElement('div');
    blocker.className = 'pick-shipping-blocker pick-shipping-blocker--warn';
    blocker.textContent = getShippingPurchaseLockedMessage();
    container.appendChild(list);
    container.appendChild(blocker);
    return;
  }

  const buyButton = document.createElement('button');
  buyButton.type = 'button';
  buyButton.className = 'pick-shipping-buy-btn';
  buyButton.classList.toggle('is-loading', shippingPanelState.actionLoading === 'buy');
  buyButton.textContent = shippingPanelState.actionLoading === 'buy' ? 'Buying...' : 'Buy Label & Print';
  buyButton.disabled = loading || Boolean(shippingPanelState.actionLoading) || !getSelectedShippingRate();
  buyButton.addEventListener('click', buyVerifyShippingLabel);

  container.appendChild(list);
  container.appendChild(buyButton);
}

function renderPurchasedShippingLabel(container) {
  const label = shippingPanelState.label;
  if (!label?.labelId) return;
  const voided = isShippingLabelVoided(label);
  if (voided) return;

  const panel = document.createElement('div');
  panel.className = `pick-shipping-label${label.printStatus === 'error' ? ' has-print-error' : ''}`;

  const title = document.createElement('strong');
  title.textContent = shippingPanelState.reusedExistingLabel ? 'Existing label found' : 'Label purchased';
  panel.appendChild(title);

  const tracking = document.createElement('p');
  tracking.textContent = label.trackingNumber
    ? `Tracking: ${label.trackingNumber}`
    : 'Tracking not returned yet.';
  panel.appendChild(tracking);

  const labelPackages = Array.isArray(label.packages) ? label.packages : [];
  if (labelPackages.length > 1) {
    const packageSummary = document.createElement('p');
    const childTrackingNumbers = labelPackages
      .map((pkg) => String(pkg.trackingNumber || '').trim())
      .filter(Boolean)
      .filter((trackingNumber) => trackingNumber !== label.trackingNumber);
    packageSummary.textContent = childTrackingNumbers.length
      ? `${labelPackages.length} packages. Additional tracking: ${childTrackingNumbers.join(', ')}`
      : `${labelPackages.length} packages on this label.`;
    panel.appendChild(packageSummary);
  }

  const print = document.createElement('p');
  if (label.printStatus === 'submitted') {
    print.textContent = label.printNodeJobId
      ? `PrintNode job: ${label.printNodeJobId}`
      : 'Sent to PrintNode.';
  } else if (label.printStatus === 'already_submitted') {
    print.textContent = 'PrintNode already received this label.';
  } else if (label.printStatus === 'error') {
    print.textContent = `Print failed: ${label.printError || 'PrintNode error'}`;
  } else {
    print.textContent = 'Ready to print.';
  }
  panel.appendChild(print);

  const actions = document.createElement('div');
  actions.className = 'pick-shipping-label-actions';

  const downloadUrl = getShippingLabelDownloadUrl(label);
  if (downloadUrl) {
    const download = document.createElement('a');
    download.href = downloadUrl;
    download.textContent = 'Download PDF';
    download.target = '_blank';
    download.rel = 'noopener';
    actions.appendChild(download);
  }

  const printButton = document.createElement('button');
  printButton.type = 'button';
  printButton.textContent = label.printStatus === 'error' ? 'Retry Print' : 'Print Again';
  printButton.disabled = loading || Boolean(shippingPanelState.actionLoading);
  printButton.addEventListener('click', retryVerifyShippingLabelPrint);
  actions.appendChild(printButton);

  const voidButton = document.createElement('button');
  voidButton.type = 'button';
  voidButton.className = 'pick-shipping-label-void-btn';
  voidButton.textContent = shippingPanelState.actionLoading === 'void' ? 'Voiding...' : 'Void Label';
  voidButton.disabled = loading || Boolean(shippingPanelState.actionLoading);
  voidButton.addEventListener('click', voidVerifyShippingLabel);
  actions.appendChild(voidButton);

  if (actions.childElementCount) {
    panel.appendChild(actions);
  }
  container.appendChild(panel);
}

function renderVerifyShippingPanel(card, { includeHeader = true } = {}) {
  if (!card) return;
  card.innerHTML = '';

  if (includeHeader) {
    const header = document.createElement('header');
    header.className = 'pick-list-card-header';

    const title = document.createElement('h3');
    title.textContent = getVerifyShippingModalTitle();

    header.appendChild(title);
    card.appendChild(header);
  }

  if (shippingPanelState.actionLoading) {
    const loadingText = document.createElement('div');
    loadingText.className = 'pick-shipping-loading';
    const message = {
      lookup: 'Loading ShipStation shipment...',
      rates: 'Checking rates...',
      buy: 'Buying label...',
      print: 'Sending to PrintNode...',
      void: 'Voiding label...',
    }[shippingPanelState.actionLoading] || 'Working...';
    loadingText.innerHTML = `<span></span><strong>${message}</strong>`;
    card.appendChild(loadingText);
  }

  if (shippingPanelState.status === 'payment_blocked') {
    const blocker = document.createElement('div');
    blocker.className = 'pick-shipping-blocker';
    blocker.textContent = shippingPanelState.payment?.message || 'Payment is pending. Ask the customer to pay in Shopify before dispatch.';
    card.appendChild(blocker);
    return;
  }

  if (shippingPanelState.status === 'error') {
    const error = document.createElement('div');
    error.className = 'pick-shipping-blocker';
    error.textContent = shippingPanelState.error || 'Shipping details could not be loaded.';
    card.appendChild(error);

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'pick-shipping-secondary-btn';
    retry.textContent = 'Retry Shipping Lookup';
    retry.addEventListener('click', () => {
      resetShippingPanelState(currentOrderBarcode);
      renderCurrentOrderSection();
      loadVerifyShippingLookup();
    });
    card.appendChild(retry);
    return;
  }

  if (shippingPanelState.status === 'loading_lookup' || shippingPanelState.status === 'idle') {
    if (shippingPanelState.actionLoading === 'lookup') return;
    const loadingMessage = document.createElement('p');
    loadingMessage.className = 'pick-shipping-state';
    loadingMessage.textContent = 'Loading ShipStation shipment...';
    card.appendChild(loadingMessage);
    return;
  }

  if (shippingPanelState.status === 'no_shipment') {
    const missing = document.createElement('div');
    missing.className = 'pick-shipping-blocker pick-shipping-blocker--warn';
    missing.textContent = 'No ShipStation shipment was found for this order.';
    card.appendChild(missing);

    const attempted = Array.isArray(shippingPanelState.attemptedIdentifiers)
      ? shippingPanelState.attemptedIdentifiers
      : [];
    if (attempted.length) {
      const list = document.createElement('p');
      list.className = 'pick-shipping-state';
      list.textContent = `Tried: ${attempted.join(', ')}`;
      card.appendChild(list);
    }
    return;
  }

  renderShippingShipmentDetails(card);

  if (shippingPanelState.status === 'purchased') {
    renderPurchasedShippingLabel(card);
    return;
  }
  if (shippingPanelState.label?.labelId) {
    renderPurchasedShippingLabel(card);
  }

  renderShippingRateControls(card);
  renderShippingRates(card);

  if (shippingPanelState.error) {
    const error = document.createElement('div');
    error.className = 'pick-shipping-rate-error';
    const title = document.createElement('strong');
    title.textContent = 'Rate could not be generated';
    const guidance = document.createElement('span');
    guidance.textContent = 'Contact James, Caity or Taig and ask them to set better ShipStation defaults for this order.';
    const message = document.createElement('span');
    message.textContent = shippingPanelState.error;
    error.appendChild(title);
    error.appendChild(guidance);
    error.appendChild(message);
    card.appendChild(error);
    renderShippingRateDiagnostics(card);
  }
}

function getVerifyShippingLaunchStatusText() {
  if (shippingPanelState.label?.labelId) {
    return shippingPanelState.label.printStatus === 'error'
      ? 'Label ready, print needs attention'
      : 'Label ready';
  }
  if (shippingPanelState.status === 'payment_blocked') {
    return 'Payment needs attention before shipping';
  }
  if (shippingPanelState.status === 'rates') {
    if (!canBuyShippingLabelForCurrentOrder()) {
      return 'Mark Packaged before buying label';
    }
    return 'Rates ready';
  }
  if (shippingPanelState.actionLoading === 'lookup' || shippingPanelState.status === 'loading_lookup') {
    return 'Loading shipment';
  }
  if (shippingPanelState.status === 'shipment_found') {
    return 'Shipment ready';
  }
  return 'Create shipping label';
}

function createHpaTankVerifyWarningCard() {
  const warning = currentHpaTankShippingWarning;
  if (!warning?.active) return null;

  const card = document.createElement('article');
  card.className = 'pick-list-card pick-hpa-tank-warning';

  const headline = document.createElement('h2');
  headline.textContent = 'HPA TANK - REMOVE REG BEFORE SHIPPING';
  card.appendChild(headline);

  const message = document.createElement('p');
  message.textContent = warning.message || 'Take to a team member to get reg removed';
  card.appendChild(message);

  const detailParts = [
    warning.countryName || warning.countryCode ? `Destination: ${warning.countryName || warning.countryCode}` : '',
    warning.skus?.length ? `SKU: ${warning.skus.join(', ')}` : '',
  ].filter(Boolean);
  if (detailParts.length) {
    const detail = document.createElement('span');
    detail.textContent = detailParts.join(' | ');
    card.appendChild(detail);
  }

  return card;
}

function createWholesaleVerifyWarningCard() {
  const warning = currentWholesaleOrderWarning;
  if (!verifyModeEnabled || wholesaleModeEnabled || !warning?.active) return null;

  const card = document.createElement('article');
  card.className = 'pick-list-card pick-wholesale-order-warning';

  const headline = document.createElement('h2');
  headline.textContent = 'WHOLESALE ORDER';
  card.appendChild(headline);

  const message = document.createElement('p');
  message.textContent = warning.message || 'Print bag topper labels before dispatch. A team member can help you apply them.';
  card.appendChild(message);

  const detailParts = [
    warning.companyName ? `Company: ${warning.companyName}` : '',
    warning.locationName ? `Location: ${warning.locationName}` : '',
  ].filter(Boolean);
  if (detailParts.length) {
    const detail = document.createElement('span');
    detail.textContent = detailParts.join(' | ');
    card.appendChild(detail);
  }

  return card;
}

function renderVerifyPickLocations(row) {
  const pickRows = Array.isArray(row?.pickRows) ? row.pickRows : [];
  const wrapper = document.createElement('div');
  wrapper.className = 'pick-verify-item-locations';

  const label = document.createElement('span');
  label.className = 'pick-verify-item-locations__label';
  label.textContent = 'Bay / Tray';
  wrapper.appendChild(label);

  const rows = pickRows.length
    ? pickRows
    : [{ sku: row?.sku || '', quantity: 1, location: '' }];

  rows.forEach((pickRow) => {
    const line = document.createElement('div');
    line.className = 'pick-verify-location-row';

    if (rows.length > 1 || normalizeDisplaySku(pickRow.sku) !== normalizeDisplaySku(row?.sku)) {
      const sku = document.createElement('span');
      sku.className = 'pick-verify-location-sku';
      sku.textContent = pickRow.sku;
      line.appendChild(sku);
    }

    line.appendChild(renderLocationCell(pickRow.location));
    wrapper.appendChild(line);
  });

  return wrapper;
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
  const canOpenShippingPanel = shouldShowVerifyShippingPanel(totals);
  if (!canOpenShippingPanel && isVerifyShippingModalOpen()) {
    closeVerifyShippingModal();
  }
  if (canOpenShippingPanel && shippingPanelState.barcode !== currentOrderBarcode) {
    resetShippingPanelState(currentOrderBarcode);
  }

  const hpaTankWarningCard = createHpaTankVerifyWarningCard();
  if (hpaTankWarningCard) {
    container.appendChild(hpaTankWarningCard);
  }

  const wholesaleWarningCard = createWholesaleVerifyWarningCard();
  if (wholesaleWarningCard) {
    container.appendChild(wholesaleWarningCard);
  }

  const summaryCard = document.createElement('article');
  const summaryTitle = canOpenShippingPanel
    ? (totals.isComplete ? 'ORDER VERIFIED - TAP TO SHIP' : 'ORDER FULFILLED - TAP TO SHIP')
    : getVerificationModeTitle();
  const summarySubtitle = canOpenShippingPanel
    ? getVerifyShippingLaunchStatusText()
    : `${getVerificationVerb()} ${totals.scanned} of ${totals.required}${totals.isComplete ? ' - complete' : ''}`;
  summaryCard.className = `pick-list-card pick-verify-summary${totals.isComplete ? ' is-complete' : ''}${canOpenShippingPanel ? ' is-shipping-launch' : ''}`;
  summaryCard.innerHTML = `
    <header class="pick-list-card-header">
      <h3>${summaryTitle}</h3>
      <p>${summarySubtitle}</p>
    </header>
  `;
  if (canOpenShippingPanel) {
    summaryCard.setAttribute('role', 'button');
    summaryCard.tabIndex = 0;
    summaryCard.addEventListener('click', openVerifyShippingModalFromLaunch);
    summaryCard.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openVerifyShippingModalFromLaunch();
      }
    });
  }
  container.appendChild(summaryCard);

  if (canOpenShippingPanel) {
    queueVerifyShippingLookupPreload();
  }

  const listCard = document.createElement('article');
  listCard.className = 'pick-list-card';

  const list = document.createElement('div');
  list.className = 'pick-verify-list';

  const shouldRenderBundleMarkers = !wholesaleModeEnabled;
  let previousBundleGroupId = '';
  verifyItems.forEach((row, index) => {
    const bundleGroupId = String(row.bundleGroupId || '').trim();
    const bundleGroupTitle = String(row.bundleGroupTitle || '').trim();
    const bundleGroupQty = Number(row.bundleGroupQuantity) || null;
    const hasFollowingItem = index < verifyItems.length - 1;
    const nextBundleGroupId = String(verifyItems[index + 1]?.bundleGroupId || '').trim();
    if (shouldRenderBundleMarkers && bundleGroupId && bundleGroupId !== previousBundleGroupId) {
      const bundleMarker = document.createElement('div');
      bundleMarker.className = 'pick-verify-bundle-marker';
      const bundleLabel = bundleGroupTitle ? `Bundle: ${bundleGroupTitle}` : 'Bundle';
      bundleMarker.textContent = bundleGroupQty ? `${bundleLabel} x${bundleGroupQty}` : bundleLabel;
      list.appendChild(bundleMarker);
    }

    const complete = row.scannedQty >= row.requiredQty;
    const usePickStyleVerifyTap = verifyModeEnabled && !wholesaleModeEnabled;
    const item = document.createElement('div');
    item.className = `pick-verify-item${complete ? ' is-complete' : ''}`;
    if (row.isWholesaleBundle) {
      item.classList.add('pick-verify-item--bundle-build');
    }
    if (row.requiresRegRemoval) {
      item.classList.add('pick-verify-item--hpa-tank-warning');
    }
    item.dataset.verifyKey = row.key;
    if (usePickStyleVerifyTap) {
      item.classList.add('pick-verify-item--tap-scan', 'pick-list-item--pickable');
      item.classList.toggle('pick-list-item--picked', complete);
      item.classList.toggle('pick-list-item--picked-partial', row.scannedQty > 0 && !complete);
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', `${complete ? 'Clear' : 'Scan'} ${getVerifyDisplayLabel(row)}`);
      item.addEventListener('click', async (event) => {
        if (loading) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('button, a, input, select, textarea')) return;
        await processVerifyTap(row.key);
        refocusBarcodeInputForScanner();
      });
      item.addEventListener('keydown', async (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (event.key === 'Enter' && hidBuffer.trim().length > 0) return;
        event.preventDefault();
        if (loading) return;
        await processVerifyTap(row.key);
        refocusBarcodeInputForScanner();
      });
    }

    const info = document.createElement('div');
    info.className = 'pick-verify-item-info';

    const title = document.createElement('h3');
    title.textContent = row.productName;

    const meta = document.createElement('p');
    if (row.isWholesaleBundle) {
      const bundleParts = [
        row.requiredQty > 1 ? `${row.requiredQty} bundle adapters` : '1 bundle adapter',
        row.bundleItemCount > 1 ? `${row.bundleItemCount} SKU lines` : '',
      ].filter(Boolean);
      meta.textContent = bundleParts.join(' | ');
    } else if (row.codes.size > 0) {
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
    if (row.requiresRegRemoval) {
      const warningBadge = document.createElement('span');
      warningBadge.className = 'pick-verify-hpa-tank-badge';
      warningBadge.textContent = 'REG REMOVAL REQUIRED';
      info.appendChild(warningBadge);
    }
    if (row.isWholesaleBundle && Array.isArray(row.bundleParts) && row.bundleParts.length > 0) {
      const partsList = document.createElement('ul');
      partsList.className = 'pick-verify-bundle-parts';

      row.bundleParts.forEach((part) => {
        const partItem = document.createElement('li');
        const partSku = String(part?.sku || '').trim();
        const partName = String(part?.productName || '').trim();
        const partQty = Math.max(1, Number(part?.quantity) || 1);
        const label = [partSku, partName && partName !== partSku ? partName : '']
          .filter(Boolean)
          .join(' - ');
        partItem.textContent = partQty > 1 ? `${label} x${partQty}` : label;
        partsList.appendChild(partItem);
      });

      info.appendChild(partsList);
    }

    const progress = document.createElement('p');
    progress.className = 'pick-verify-item-progress';
    progress.textContent = `${row.scannedQty} / ${row.requiredQty}`;

    item.appendChild(info);
    if (verifyModeEnabled && !wholesaleModeEnabled) {
      item.appendChild(renderVerifyPickLocations(row));
    }
    item.appendChild(progress);
    if (!usePickStyleVerifyTap) {
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
      item.appendChild(actions);
    }
    list.appendChild(item);

    if (shouldRenderBundleMarkers && bundleGroupId && bundleGroupId !== nextBundleGroupId && hasFollowingItem) {
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

function createQcModePanel() {
  const card = document.createElement('article');
  card.className = 'pick-list-card pick-qc-mode-card';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'pick-qc-mode-card__eyebrow';
  eyebrow.textContent = 'BUILT BY';
  card.appendChild(eyebrow);

  const builder = document.createElement('h2');
  builder.textContent = currentQcBuilderStaff || 'NO BUILDER RECORDED';
  card.appendChild(builder);

  const detail = document.createElement('p');
  detail.className = 'pick-qc-mode-card__detail';
  detail.textContent = currentQcBuilderStaff
    ? 'Use QC PASS or QC FAIL after checking the adapter.'
    : 'Mark the order as Waiting QC when the builder hands it over, then reload this order.';
  card.appendChild(detail);

  return card;
}

function renderQcOrderSection() {
  renderLineCards(lastRenderedLineItems);
  const container = document.getElementById('pickListLineItems');
  if (!container) return;
  container.prepend(createQcModePanel());
}

function renderCurrentOrderSection() {
  if (isVerificationStyleModeEnabled()) {
    renderVerifyOrderCards();
    return;
  }
  prunePickedRowCountsToRenderedRows();
  if (qcModeEnabled) {
    renderQcOrderSection();
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

async function processVerifyTap(key) {
  if (!verifyModeEnabled || wholesaleModeEnabled) return;
  if (isCurrentOrderWorkflowBlocked()) {
    showWorkflowBlockedWarning(currentWorkflowBlock?.message);
    return;
  }

  const row = verifyItems.find((item) => item.key === key);
  if (!row) {
    setStatus('Error: Verification item not found.', 'error');
    return;
  }

  const requiredQty = Math.max(1, Number(row.requiredQty) || 1);
  const wasComplete = row.scannedQty >= requiredQty;
  row.scannedQty = wasComplete ? 0 : Math.min(requiredQty, Math.max(0, Number(row.scannedQty) || 0) + 1);

  renderVerifyOrderCards();
  scheduleVerifyProgressSave();

  const totals = getVerifyTotals();
  if (wasComplete) {
    setStatus(`Cleared: ${getVerifyDisplayLabel(row)} (0/${requiredQty}).`, totals.isComplete ? 'success' : 'info');
    return;
  }

  if (totals.isComplete) {
    playVerifyCompleteSound();
    setStatus(`Order ${currentOrderNumber} fully verified (${totals.scanned}/${totals.required}).`, 'success');
  } else {
    playVerifyScanSound();
    setStatus(`${getManualVerificationVerb()}: ${getVerifyDisplayLabel(row)} (${row.scannedQty}/${row.requiredQty}).`, 'success');
  }
}

async function processVerifyManual(key) {
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

  if (row.scannedQty >= row.requiredQty) {
    setStatus(`${getVerifyDisplayLabel(row)} is already fully scanned.`, 'info');
    return;
  }

  if (wholesaleModeEnabled) {
    const actionResult = await runOrderAction('wholesale_adapter_built');
    if (actionResult !== true) {
      return;
    }
  }

  const result = incrementVerifyRow(row);
  if (!result.success) {
    setStatus(`${getVerifyDisplayLabel(row)} is already fully scanned.`, 'info');
    return;
  }

  renderVerifyOrderCards();
  if (wholesaleModeEnabled) {
    scheduleWholesaleProgressSave();
  } else {
    scheduleVerifyProgressSave();
  }
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
  if (wholesaleModeEnabled) {
    scheduleWholesaleProgressSave();
  } else {
    scheduleVerifyProgressSave();
  }
  const totals = getVerifyTotals();
  setStatus(`Undo: ${getVerifyDisplayLabel(row)} (${row.scannedQty}/${row.requiredQty}).`, totals.isComplete ? 'success' : 'info');
}

async function processVerifyScan(scannedCode) {
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
  if (target.scannedQty >= target.requiredQty) {
    setStatus(`${getVerifyDisplayLabel(target)} is already fully scanned.`, 'info');
    return true;
  }

  if (wholesaleModeEnabled) {
    const actionResult = await runOrderAction('wholesale_adapter_built');
    if (actionResult !== true) {
      return true;
    }
  }

  const result = incrementVerifyRow(target);

  if (!result.success) {
    setStatus(`${getVerifyDisplayLabel(target)} is already fully scanned.`, 'info');
    return true;
  }

  renderVerifyOrderCards();
  if (wholesaleModeEnabled) {
    scheduleWholesaleProgressSave();
  } else {
    scheduleVerifyProgressSave();
  }
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

function openAwaitingPartsDialog(orderId, lineItems = lastRenderedLineItems) {
  const modal = document.getElementById('awaitingPartsModal');
  const form = document.getElementById('awaitingPartsForm');
  if (!modal || !form) return;

  form.innerHTML = '';
  const modalCatalog = buildAwaitingPartsCatalog(lineItems);
  getCurrentAwaitingPartsSelection().forEach((item) => {
    const sku = normalizeDisplaySku(item?.sku || item?.partSku);
    if (!sku || modalCatalog.has(sku)) return;
    modalCatalog.set(sku, {
      sku,
      quantity: Math.max(1, Number(item?.quantity) || 1),
      contexts: ['Currently awaiting (not on current pick list)'],
      location: '',
      note: '',
      type: '',
    });
  });

  const modalItems = Array.from(modalCatalog.values())
    .sort((left, right) => left.sku.localeCompare(right.sku));

  if (!modalItems.length) {
    const empty = document.createElement('p');
    empty.className = 'pick-list-empty';
    empty.textContent = 'No SKU or component rows available to mark as awaiting parts.';
    form.appendChild(empty);
  }

  modalItems.forEach((item) => {
    const label = document.createElement('label');
    label.className = 'pick-modal-item';
    const currentQty = getAwaitingPartsQty(item.sku);
    const suggestedQty = Math.max(1, Number(item.quantity) || 1);
    const maxQty = Math.max(suggestedQty, currentQty || 0, 1);
    const defaultQty = currentQty > 0 ? currentQty : suggestedQty;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = item.sku;
    checkbox.checked = currentQty > 0;

    const body = document.createElement('div');
    body.className = 'pick-modal-item__body';

    const textWrap = document.createElement('div');
    textWrap.className = 'pick-modal-item__text';

    const text = document.createElement('span');
    text.textContent = suggestedQty > 1 ? `${item.sku} x${suggestedQty}` : item.sku;

    const metaParts = [];
    if (item.contexts.length > 0) {
      const visibleContexts = item.contexts.slice(0, 2);
      const remainingContextCount = Math.max(0, item.contexts.length - visibleContexts.length);
      metaParts.push(
        visibleContexts.join(' | ') + (remainingContextCount > 0 ? ` | +${remainingContextCount} more` : '')
      );
    }
    if (item.location) {
      metaParts.push(`Loc: ${item.location}`);
    }
    if (item.note) {
      metaParts.push(item.note);
    }

    textWrap.appendChild(text);
    if (metaParts.length > 0) {
      const meta = document.createElement('small');
      meta.className = 'pick-modal-item__meta';
      meta.textContent = metaParts.join(' | ');
      textWrap.appendChild(meta);
    }

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

    body.appendChild(textWrap);
    body.appendChild(qtyInput);
    label.appendChild(checkbox);
    label.appendChild(body);
    form.appendChild(label);
  });

  form.dataset.orderId = orderId;
  modal.classList.add('is-open');
}

function closeAwaitingPartsDialog({ clearPendingReminder = false } = {}) {
  const modal = document.getElementById('awaitingPartsModal');
  const form = document.getElementById('awaitingPartsForm');

  if (modal) modal.classList.remove('is-open');
  if (form) {
    form.innerHTML = '';
    form.dataset.orderId = '';
  }
  if (clearPendingReminder) {
    pendingActionReminderTarget = null;
  }
}

function cancelAwaitingPartsDialog() {
  closeAwaitingPartsDialog({ clearPendingReminder: true });
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

  const saved = await saveAwaitingPartsSelection({
    orderId,
    items,
    closeDialog: true,
  });

  if (saved && pendingActionReminderTarget) {
    if (hasActionForCurrentOrder()) {
      continueActionReminderTarget();
    } else {
      pendingActionReminderTarget = null;
    }
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

function openOnHoldDialog(orderId) {
  const modal = document.getElementById('onHoldModal');
  const reasonInput = document.getElementById('onHoldReason');
  if (!modal || !reasonInput) return;

  reasonInput.dataset.orderId = String(orderId || '').trim().toUpperCase();
  reasonInput.value = '';
  modal.classList.add('is-open');
  window.requestAnimationFrame(() => reasonInput.focus());
}

function closeOnHoldDialog() {
  const modal = document.getElementById('onHoldModal');
  const reasonInput = document.getElementById('onHoldReason');

  if (modal) modal.classList.remove('is-open');
  if (reasonInput) {
    reasonInput.dataset.orderId = '';
    reasonInput.value = '';
  }
}

async function submitOnHold() {
  const reasonInput = document.getElementById('onHoldReason');
  if (!reasonInput) return;

  const orderId = String(reasonInput.dataset.orderId || '').trim().toUpperCase();
  const reason = reasonInput.value.trim();

  if (!orderId) {
    setStatus('Error: Missing order id for On Hold.', 'error');
    return;
  }

  if (!reason) {
    setStatus('Enter a reason for putting this order on hold.', 'error');
    reasonInput.focus();
    return;
  }

  if (loading) return;

  setLoading(true);
  setStatus('Applying On Hold...', 'info');

  try {
    const response = await fetch('/api/tag-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barcode: orderId, tag: 'on_hold', reason }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to apply action');
    }

    lastActionTag = 'on_hold';
    lastActionBarcode = orderId;
    closeOnHoldDialog();
    setStatus(
      appendActionWarnings(`Order ${data.orderNumber} put on hold by ${data.staff}: ${reason}`, data),
      'success'
    );
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
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
    return false;
  }

  if (isCurrentOrderWorkflowBlocked()) {
    showWorkflowBlockedWarning(currentWorkflowBlock?.message);
    return false;
  }

  if (tag === 'packaged' && isPackagedActionLocked()) {
    setStatus('Complete Verify Order before marking this order as Packaged.', 'error');
    return false;
  }

  if (loading || isAnyDialogOpen()) return false;

  const isDuplicate =
    lastActionTag === tag &&
    lastActionBarcode === normalizedBarcode &&
    !NON_DEDUPE_ACTION_TAGS.has(tag);

  if (isDuplicate) {
    setStatus(`Skipped duplicate action: ${formatActionLabel(tag)}.`, 'info');
    return true;
  }

  if (tag === 'awaiting_parts') {
    openAwaitingPartsDialog(normalizedBarcode, lastRenderedLineItems);
    return 'dialog';
  }

  if (tag === 'on_hold') {
    openOnHoldDialog(normalizedBarcode);
    return 'dialog';
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
    applyOrderHeaderData(data, { fallbackTag: tag });

    if (tag === 'wholesale_adapter_built') {
      setStatus(
        appendActionWarnings(
          `Order ${data.orderNumber} adapter built by ${data.staff}. Total scans: ${data.wholesaleAdapterBuiltCount ?? 1}`,
          data
        ),
        'success'
      );
    } else {
      setStatus(
        appendActionWarnings(`Order ${data.orderNumber} tagged ${tag} successfully by ${data.staff}`, data),
        'success'
      );
    }

    if (tag === 'awaiting_parts') {
      openAwaitingPartsDialog(normalizedBarcode, lastRenderedLineItems);
    } else if (tag === 'qc_fail') {
      openQcFailDialog(normalizedBarcode, data.lineItems || []);
    } else if (hasRenderedPickList) {
      setCurrentAwaitingPartsItems([]);
      renderCurrentOrderSection();
    }
    return true;
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    return false;
  } finally {
    setLoading(false);
  }
}

async function fetchPickList(barcodeInput, { skipActionReminder = false } = {}) {
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

  if (!skipActionReminder && shouldShowOrderActionReminder({ nextLookup: barcode })) {
    openOrderActionReminderDialog({ lookup: barcode });
    return;
  }

  await flushPendingPickedRowCountsSave();
  await flushPendingVerifyProgressSave();
  scrollPickListToTop();

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
        setOrderLookupInUrl(barcode);
        clearLoadedOrderState({ preserveOrderLookup: true });
        currentOrderBarcode = barcode;
        currentOrderNumber = data.orderNumber || barcode;
        setHpaTankShippingWarning(data.hpaTankShippingWarning);
        setWholesaleOrderWarning(data.wholesaleOrderWarning);
        applyOrderHeaderData(data);
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
    currentOrderTimeline = Array.isArray(data.orderTimeline) ? data.orderTimeline : [];
    currentOrderFinancialStatus = String(data.orderFinancialStatus || '').trim();
    setHpaTankShippingWarning(data.hpaTankShippingWarning);
    setWholesaleOrderWarning(data.wholesaleOrderWarning);
    resetShippingPanelState(data.barcode);
    setCurrentAwaitingPartsItems(Array.isArray(data.awaitingPartsItems) ? data.awaitingPartsItems : []);
    setOrderLookupInUrl(data.barcode || barcode);
    currentWorkflowBlock = data.workflowBlocked
      ? {
          blocked: true,
          code: data.workflowBlockCode || '',
          status: data.workflowStatus || '',
          message: data.workflowWarning || data.error || 'This order cannot be picked or built.',
        }
      : null;
    setActionButtonsEnabled(true);

    applyOrderHeaderData(data);
    renderWorkflowAlert();

    lastRenderedLineItems = Array.isArray(data.lineItems) ? data.lineItems : [];
    lastOrderItems = Array.isArray(data.orderItems) ? data.orderItems : [];
    refreshAwaitingPartsCatalog(lastRenderedLineItems);
    lastWholesaleProgressByItemKey =
      data.wholesaleProgressByItemKey && typeof data.wholesaleProgressByItemKey === 'object'
        ? data.wholesaleProgressByItemKey
        : {};
    lastVerifyProgressByItemKey =
      data.verifyProgressByItemKey && typeof data.verifyProgressByItemKey === 'object'
        ? data.verifyProgressByItemKey
        : {};
    setPickedRowCountsFromPayload(data.pickedRowCounts);
    buildVerifyState(
      lastOrderItems,
      wholesaleModeEnabled
        ? lastWholesaleProgressByItemKey
        : (verifyModeEnabled ? lastVerifyProgressByItemKey : null)
    );
    hasRenderedPickList = true;
    prunePickedRowCountsToRenderedRows();
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

  document.addEventListener('keydown', async (event) => {
    if (loading) return;

    const actionReminderOpen = isOrderActionReminderDialogOpen();
    if (isAnyDialogOpen() && !actionReminderOpen) return;

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

        if (actionReminderOpen) {
          if (!handleOrderActionReminderScan(scannedCode)) {
            setStatus('Scan the order label again to continue without action.', 'info');
          }
          return;
        }

        if (isVerificationStyleModeEnabled() && hasRenderedPickList && !isOrderCode) {
          await processVerifyScan(scannedCode);
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

function registerOrderActionReminderNavigationGuards() {
  window.addEventListener('beforeunload', (event) => {
    sendPickedRowCountsBeacon();
    sendVerifyProgressBeacon();
    if (suppressNextActionReminderUnload) return;
    if (!shouldShowOrderActionReminder()) return;

    event.preventDefault();
    event.returnValue = '';
  });

  document.querySelectorAll('a[href]').forEach((link) => {
    link.addEventListener('click', (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        (link.target && link.target !== '_self')
      ) {
        return;
      }

      if (!shouldShowOrderActionReminder()) return;

      event.preventDefault();
      openOrderActionReminderDialog({ href: link.href });
    });
  });
}

function registerModalHandlers() {
  const awaitingPartsModal = document.getElementById('awaitingPartsModal');
  const printQueueResultModal = document.getElementById('awaitingPrintQueueResultModal');
  const qcFailModal = document.getElementById('qcFailModal');
  const onHoldModal = document.getElementById('onHoldModal');
  const orderActionReminderModal = document.getElementById('orderActionReminderModal');
  const verifyShippingModal = document.getElementById('verifyShippingModal');
  const bagLabelsModal = document.getElementById('bagLabelsModal');
  const hpaTankRegRemovalModal = document.getElementById('hpaTankRegRemovalModal');

  const awaitingCancel = document.getElementById('awaitingPartsCancelBtn');
  const awaitingConfirm = document.getElementById('awaitingPartsConfirmBtn');
  const printQueueResultClose = document.getElementById('awaitingPrintQueueResultCloseBtn');
  const qcCancel = document.getElementById('qcFailCancelBtn');
  const qcConfirm = document.getElementById('qcFailConfirmBtn');
  const onHoldCancel = document.getElementById('onHoldCancelBtn');
  const onHoldConfirm = document.getElementById('onHoldConfirmBtn');
  const reminderCancel = document.getElementById('orderActionReminderCancelBtn');
  const reminderContinue = document.getElementById('orderActionReminderContinueBtn');
  const verifyShippingClose = document.getElementById('verifyShippingModalCloseBtn');
  const bagLabelsCancel = document.getElementById('bagLabelsCancelBtn');
  const bagLabelsPreview = document.getElementById('bagLabelsPreviewBtn');
  const bagLabelsPrint = document.getElementById('bagLabelsPrintBtn');
  const bagLabelsAdd = document.getElementById('bagLabelsAddBtn');
  const hpaTankRegRemovalClose = document.getElementById('hpaTankRegRemovalCloseBtn');

  if (awaitingCancel) awaitingCancel.addEventListener('click', cancelAwaitingPartsDialog);
  if (awaitingConfirm) awaitingConfirm.addEventListener('click', submitAwaitingParts);
  if (printQueueResultClose) printQueueResultClose.addEventListener('click', closeAwaitingPrintQueueResultPopup);
  if (qcCancel) qcCancel.addEventListener('click', closeQcFailDialog);
  if (qcConfirm) qcConfirm.addEventListener('click', submitQcFail);
  if (onHoldCancel) onHoldCancel.addEventListener('click', closeOnHoldDialog);
  if (onHoldConfirm) onHoldConfirm.addEventListener('click', submitOnHold);
  if (verifyShippingClose) verifyShippingClose.addEventListener('click', closeVerifyShippingModal);
  if (bagLabelsCancel) bagLabelsCancel.addEventListener('click', closeBagLabelsDialog);
  if (bagLabelsPreview) bagLabelsPreview.addEventListener('click', previewBagLabelsPdf);
  if (bagLabelsPrint) bagLabelsPrint.addEventListener('click', submitBagLabels);
  if (bagLabelsAdd) bagLabelsAdd.addEventListener('click', addBagLabelRow);
  if (hpaTankRegRemovalClose) hpaTankRegRemovalClose.addEventListener('click', closeHpaTankRegRemovalPopup);
  if (reminderCancel) reminderCancel.addEventListener('click', () => closeOrderActionReminderDialog());
  if (reminderContinue) {
    reminderContinue.addEventListener('click', () => {
      const pendingTarget = pendingActionReminderTarget;
      closeOrderActionReminderDialog({ clearPending: false });
      continueActionReminderTarget(pendingTarget);
    });
  }

  if (awaitingPartsModal) {
    awaitingPartsModal.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        cancelAwaitingPartsDialog();
      }
    });
  }

  if (printQueueResultModal) {
    printQueueResultModal.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        closeAwaitingPrintQueueResultPopup();
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

  if (onHoldModal) {
    onHoldModal.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        closeOnHoldDialog();
      }
    });
  }

  if (orderActionReminderModal) {
    orderActionReminderModal.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        closeOrderActionReminderDialog();
      }
    });
  }

  if (verifyShippingModal) {
    verifyShippingModal.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        closeVerifyShippingModal();
      }
    });
  }

  if (bagLabelsModal) {
    bagLabelsModal.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        closeBagLabelsDialog();
      }
    });
  }

  if (hpaTankRegRemovalModal) {
    hpaTankRegRemovalModal.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        closeHpaTankRegRemovalPopup();
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
  const qcModeToggle = document.getElementById('qcModeToggle');
  const bagLabelsOpenBtn = document.getElementById('bagLabelsOpenBtn');

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

  if (bagLabelsOpenBtn) {
    bagLabelsOpenBtn.addEventListener('click', openBagLabelsDialog);
  }

  if (button) {
    button.addEventListener('click', () => fetchPickList(input?.value || ''));
  }

  if (input) {
    input.addEventListener('focus', () => focusBarcodeInput({ selectAll: true }));
    input.addEventListener('click', () => focusBarcodeInput({ selectAll: true }));
    input.addEventListener('keydown', async (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const rawValue = input.value;
        const normalized = normalizeVerifyCode(rawValue);
        const isOrderCode = normalized.startsWith('AT');

        if (isOrderActionReminderDialogOpen()) {
          if (!handleOrderActionReminderScan(rawValue)) {
            setStatus('Scan the order label again to continue without action.', 'info');
          }
          input.value = '';
          focusBarcodeInput();
          return;
        }

        if (isVerificationStyleModeEnabled() && hasRenderedPickList && !isOrderCode) {
          await processVerifyScan(rawValue);
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
  qcModeEnabled = getCookieValue(QC_MODE_COOKIE) === '1';

  if (qcModeEnabled) {
    pickerModeEnabled = false;
    verifyModeEnabled = false;
    wholesaleModeEnabled = false;
  } else if (wholesaleModeEnabled) {
    pickerModeEnabled = false;
    verifyModeEnabled = false;
    qcModeEnabled = false;
  } else if (pickerModeEnabled && verifyModeEnabled) {
    verifyModeEnabled = false;
    setCookieValue(VERIFY_MODE_COOKIE, '0');
  }

  const syncVerificationStateForMode = () => {
    if (!hasRenderedPickList || !isVerificationStyleModeEnabled()) return;
    buildVerifyState(
      lastOrderItems,
      wholesaleModeEnabled
        ? lastWholesaleProgressByItemKey
        : (verifyModeEnabled ? lastVerifyProgressByItemKey : null)
    );
  };

  const applyModeState = () => {
    if (!verifyModeEnabled && verifySaveTimeoutId) {
      clearTimeout(verifySaveTimeoutId);
      verifySaveTimeoutId = null;
      flushVerifyProgressSave(true);
    }

    if (!wholesaleModeEnabled && wholesaleSaveTimeoutId) {
      clearTimeout(wholesaleSaveTimeoutId);
      wholesaleSaveTimeoutId = null;
      flushWholesaleProgressSave(true);
    }

    if (pickerModeToggle) pickerModeToggle.checked = pickerModeEnabled;
    if (verifyModeToggle) verifyModeToggle.checked = verifyModeEnabled;
    if (wholesaleModeToggle) wholesaleModeToggle.checked = wholesaleModeEnabled;
    if (qcModeToggle) qcModeToggle.checked = qcModeEnabled;
    document.body?.classList.toggle('pick-list-page--qc-mode', qcModeEnabled);

    setCookieValue(PICKER_MODE_COOKIE, pickerModeEnabled ? '1' : '0');
    setCookieValue(VERIFY_MODE_COOKIE, verifyModeEnabled ? '1' : '0');
    setCookieValue(WHOLESALE_MODE_COOKIE, wholesaleModeEnabled ? '1' : '0');
    setCookieValue(QC_MODE_COOKIE, qcModeEnabled ? '1' : '0');

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
        qcModeEnabled = false;
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
        qcModeEnabled = false;
      }
      applyModeState();
    });
  }

  if (qcModeToggle) {
    qcModeToggle.checked = qcModeEnabled;
    qcModeToggle.addEventListener('change', () => {
      qcModeEnabled = Boolean(qcModeToggle.checked);
      if (qcModeEnabled) {
        pickerModeEnabled = false;
        verifyModeEnabled = false;
        wholesaleModeEnabled = false;
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
        qcModeEnabled = false;
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
  registerOrderActionReminderNavigationGuards();

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
