const { normalizeSku, normalizePickType } = require('./pickListService');

const SLS_PRINT_QUEUE_STAGES = [
  { key: 'needs_printed', label: 'Needs Printed' },
  { key: 'in_build', label: 'In Build' },
  { key: 'pre_dye', label: 'Pre Dye' },
  { key: 'post_dye', label: 'Post Dye' },
  { key: 'complete', label: 'Complete' },
];

const FDM_PRINT_QUEUE_STAGES = [
  { key: 'needs_printed', label: 'Needs Printed' },
  { key: 'in_build', label: 'Printing' },
  { key: 'complete', label: 'Complete' },
];

const PRINT_QUEUE_STAGES = SLS_PRINT_QUEUE_STAGES;

const PRINT_QUEUE_CONFIGS = {
  sls: {
    key: 'sls',
    label: 'Print Queue',
    shortLabel: 'SLS / Adapter',
    catalogLabel: 'SLS and adapter rows',
    emptyCatalogLabel: 'No SLS or adapter SKUs found in the sheet.',
    supportsPreformBuild: true,
    typeMatches: ['SLS', 'ADAPTER'],
    stages: SLS_PRINT_QUEUE_STAGES,
  },
  fdm: {
    key: 'fdm',
    label: 'FDM Print Queue',
    shortLabel: 'FDM',
    catalogLabel: 'FDM rows',
    emptyCatalogLabel: 'No FDM SKUs found in the sheet.',
    supportsPreformBuild: false,
    typeMatches: ['FDM'],
    stages: FDM_PRINT_QUEUE_STAGES,
  },
};

const DEFAULT_PRINT_QUEUE_KEY = 'sls';
const PRINT_QUEUE_KEYS = new Set(Object.keys(PRINT_QUEUE_CONFIGS));
const PRINT_QUEUE_STAGE_KEYS = new Set(
  Object.values(PRINT_QUEUE_CONFIGS)
    .flatMap((config) => config.stages || [])
    .map((stage) => stage.key)
);
const PRINT_QUEUE_STAGE_LOOKUP = new Map(
  Object.values(PRINT_QUEUE_CONFIGS)
    .flatMap((config) => config.stages || [])
    .map((stage) => [stage.key, stage])
);
const DEFAULT_PRINT_QUEUE_STAGE = 'needs_printed';

function normalizePrintQueueKey(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return PRINT_QUEUE_KEYS.has(normalized) ? normalized : DEFAULT_PRINT_QUEUE_KEY;
}

function getPrintQueueConfig(value) {
  return PRINT_QUEUE_CONFIGS[normalizePrintQueueKey(value)] || PRINT_QUEUE_CONFIGS[DEFAULT_PRINT_QUEUE_KEY];
}

function getPrintQueueStages(value = DEFAULT_PRINT_QUEUE_KEY) {
  const config = getPrintQueueConfig(value);
  return Array.isArray(config.stages) && config.stages.length ? config.stages : PRINT_QUEUE_STAGES;
}

function normalizeStageKey(value, queueKey = null) {
  const normalized = String(value || '').trim().toLowerCase();
  if (queueKey != null) {
    const stageKeys = new Set(getPrintQueueStages(queueKey).map((stage) => stage.key));
    return stageKeys.has(normalized) ? normalized : '';
  }

  return PRINT_QUEUE_STAGE_KEYS.has(normalized) ? normalized : '';
}

function getPrintQueueStage(value, queueKey = null) {
  const normalized = normalizeStageKey(value, queueKey);
  const stages = queueKey == null ? null : getPrintQueueStages(queueKey);
  return stages
    ? stages.find((stage) => stage.key === normalized) || null
    : PRINT_QUEUE_STAGE_LOOKUP.get(normalized) || null;
}

function parsePositiveInteger(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  const integer = Math.floor(parsed);
  return integer > 0 ? integer : fallback;
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

function normalizePrintableType(value) {
  return normalizePickType(value);
}

function typeContainsToken(type, token) {
  const normalized = normalizePrintableType(type);
  const escapedToken = String(token || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Z0-9])${escapedToken}([^A-Z0-9]|$)`).test(normalized);
}

function isPrintableSheetType(type, queueKey = DEFAULT_PRINT_QUEUE_KEY) {
  const config = getPrintQueueConfig(queueKey);
  return config.typeMatches.some((token) => typeContainsToken(type, token));
}

function isPrintableSheetRow(row, queueKey = DEFAULT_PRINT_QUEUE_KEY) {
  return isPrintableSheetType(row?.type || row?.pickType, queueKey);
}

function getPrintQueueKeyForSheetRow(row) {
  const type = row?.type || row?.pickType;
  if (isPrintableSheetType(type, 'fdm')) return 'fdm';
  if (isPrintableSheetType(type, 'sls')) return 'sls';
  return '';
}

function getComponentItems(row) {
  if (Array.isArray(row?.componentItems) && row.componentItems.length > 0) {
    return row.componentItems
      .map((component) => ({
        sku: normalizeSku(component?.sku),
        quantityMultiplier: parsePositiveInteger(component?.quantityMultiplier, 1),
      }))
      .filter((component) => component.sku);
  }

  return (Array.isArray(row?.components) ? row.components : [])
    .map((componentSku) => ({
      sku: normalizeSku(componentSku),
      quantityMultiplier: 1,
    }))
    .filter((component) => component.sku);
}

function countEligibleDescendants({ skuMap, sku, queueKey = DEFAULT_PRINT_QUEUE_KEY, seen = new Set() }) {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku || seen.has(normalizedSku)) return 0;

  seen.add(normalizedSku);
  const row = skuMap.get(normalizedSku);
  const components = getComponentItems(row);

  return components.reduce((count, component) => {
    if (!component.sku || seen.has(component.sku)) return count;

    const componentRow = skuMap.get(component.sku);
    const ownCount = isPrintableSheetRow(componentRow, queueKey) ? 1 : 0;
    return count + ownCount + countEligibleDescendants({
      skuMap,
      sku: component.sku,
      queueKey,
      seen,
    });
  }, 0);
}

function serializeSheetRow({ skuMap, sku, parentSku = '', rootSku = '', queueKey = DEFAULT_PRINT_QUEUE_KEY }) {
  const normalizedSku = normalizeSku(sku);
  const row = skuMap.get(normalizedSku);
  const typeRaw = normalizePrintableType(row?.type || row?.pickType);
  const componentItems = getComponentItems(row);
  const components = componentItems.map((component) => component.sku);
  const rsq = Math.max(0, Math.floor(Number(row?.rsq) || 0));
  const note = String(row?.note || '').trim();

  return {
    sku: normalizedSku,
    title: String(row?.title || '').trim(),
    typeRaw: typeRaw || 'UNKNOWN',
    pickType: String(row?.pickType || '').trim().toUpperCase(),
    location: String(row?.location || '').trim(),
    note,
    noteQuantityMultiplier: getNoteQuantityMultiplier(note),
    rsq,
    defaultQuantity: parsePositiveInteger(rsq, 1),
    componentCount: components.length,
    eligibleComponentCount: countEligibleDescendants({
      skuMap,
      sku: normalizedSku,
      queueKey,
    }),
    components,
    componentItems,
    parentSku: normalizeSku(parentSku),
    rootSku: normalizeSku(rootSku || normalizedSku),
  };
}

function collectPrintableSkuWithChildren({
  skuMap,
  sku,
  queueKey = DEFAULT_PRINT_QUEUE_KEY,
  rootSku = '',
  parentSku = '',
  seen = new Set(),
  includeCurrent = false,
  rootQuantity = null,
}) {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku || seen.has(normalizedSku)) return [];

  seen.add(normalizedSku);
  const sheetRow = skuMap.get(normalizedSku);
  const row = serializeSheetRow({
    skuMap,
    sku: normalizedSku,
    parentSku,
    rootSku: rootSku || normalizedSku,
    queueKey,
  });
  const baseQuantity = rootQuantity == null ? row.defaultQuantity : rootQuantity;
  const isRootRow = !normalizeSku(parentSku);
  const noteMultiplier = isRootRow ? 1 : row.noteQuantityMultiplier;
  const rowWithQuantity = {
    ...row,
    printQuantity: parsePositiveInteger(baseQuantity * noteMultiplier, 1),
    quantityMultiplier: noteMultiplier,
  };

  const childRows = row.componentItems.flatMap((component) => collectPrintableSkuWithChildren({
    skuMap,
    sku: component.sku,
    queueKey,
    rootSku: rootSku || normalizedSku,
    parentSku: normalizedSku,
    seen,
    rootQuantity: baseQuantity,
  }));

  return includeCurrent || isPrintableSheetRow(sheetRow, queueKey)
    ? [rowWithQuantity, ...childRows]
    : childRows;
}

function buildPrintCatalogFromSheet({ skuMap, queueKey = DEFAULT_PRINT_QUEUE_KEY }) {
  if (!(skuMap instanceof Map)) return [];
  const normalizedQueueKey = normalizePrintQueueKey(queueKey);

  return Array.from(skuMap.entries())
    .filter(([, row]) => isPrintableSheetRow(row, normalizedQueueKey))
    .map(([sku]) => ({
      ...serializeSheetRow({ skuMap, sku, queueKey: normalizedQueueKey }),
      queueKey: normalizedQueueKey,
    }))
    .sort((left, right) => {
      const typeDiff = left.typeRaw.localeCompare(right.typeRaw);
      if (typeDiff !== 0) return typeDiff;
      return left.sku.localeCompare(right.sku);
    });
}

function buildPrintQueueItemsForCatalogSku({ skuMap, sku, quantity = null, queueKey = DEFAULT_PRINT_QUEUE_KEY }) {
  const normalizedSku = normalizeSku(sku);
  const normalizedQueueKey = normalizePrintQueueKey(queueKey);
  if (!normalizedSku || !(skuMap instanceof Map) || !skuMap.has(normalizedSku)) {
    return [];
  }

  if (!isPrintableSheetRow(skuMap.get(normalizedSku), normalizedQueueKey)) {
    return [];
  }

  const printableRows = collectPrintableSkuWithChildren({
    skuMap,
    sku: normalizedSku,
    queueKey: normalizedQueueKey,
    includeCurrent: true,
    rootQuantity: quantity == null ? null : parsePositiveInteger(quantity, 1),
  });
  const rootRow = printableRows[0];
  if (!rootRow) return [];

  return [{
    queueKey: normalizedQueueKey,
    sourceType: 'catalog',
    sku: rootRow.sku,
    rootSku: rootRow.rootSku,
    parentSku: rootRow.parentSku,
    title: rootRow.title || rootRow.sku,
    typeRaw: rootRow.typeRaw,
    location: rootRow.location,
    quantity: rootRow.printQuantity,
    rsq: rootRow.rsq || null,
    notes: rootRow.note,
    childItems: printableRows.slice(1).map((row) => ({
      sku: row.sku,
      parentSku: row.parentSku,
      title: row.title || row.sku,
      typeRaw: row.typeRaw,
      location: row.location,
      quantity: row.printQuantity,
      rsq: row.rsq || null,
      quantityMultiplier: row.quantityMultiplier,
      notes: row.note,
    })),
    stageKey: DEFAULT_PRINT_QUEUE_STAGE,
  }];
}

module.exports = {
  PRINT_QUEUE_STAGES,
  PRINT_QUEUE_CONFIGS,
  DEFAULT_PRINT_QUEUE_KEY,
  DEFAULT_PRINT_QUEUE_STAGE,
  normalizePrintQueueKey,
  getPrintQueueConfig,
  getPrintQueueStages,
  normalizeStageKey,
  getPrintQueueStage,
  isPrintableSheetType,
  isPrintableSheetRow,
  getPrintQueueKeyForSheetRow,
  buildPrintCatalogFromSheet,
  buildPrintQueueItemsForCatalogSku,
  parsePositiveInteger,
};
