const { normalizeSku, normalizePickType } = require('./pickListService');

const PRINT_QUEUE_STAGES = [
  { key: 'needs_printed', label: 'Needs Printed' },
  { key: 'in_build', label: 'In Build' },
  { key: 'pre_dye', label: 'Pre Dye' },
  { key: 'post_dye', label: 'Post Dye' },
  { key: 'complete', label: 'Complete' },
];

const PRINT_QUEUE_STAGE_KEYS = new Set(PRINT_QUEUE_STAGES.map((stage) => stage.key));
const DEFAULT_PRINT_QUEUE_STAGE = 'needs_printed';

function normalizeStageKey(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return PRINT_QUEUE_STAGE_KEYS.has(normalized) ? normalized : '';
}

function getPrintQueueStage(value) {
  const normalized = normalizeStageKey(value);
  return PRINT_QUEUE_STAGES.find((stage) => stage.key === normalized) || null;
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

function isPrintableSheetType(type) {
  const normalized = normalizePrintableType(type);
  return /(^|[^A-Z0-9])SLS([^A-Z0-9]|$)/.test(normalized)
    || /(^|[^A-Z0-9])ADAPTER([^A-Z0-9]|$)/.test(normalized);
}

function isPrintableSheetRow(row) {
  return isPrintableSheetType(row?.type || row?.pickType);
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

function countEligibleDescendants({ skuMap, sku, seen = new Set() }) {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku || seen.has(normalizedSku)) return 0;

  seen.add(normalizedSku);
  const row = skuMap.get(normalizedSku);
  const components = getComponentItems(row);

  return components.reduce((count, component) => {
    if (!component.sku || seen.has(component.sku)) return count;

    const componentRow = skuMap.get(component.sku);
    const ownCount = isPrintableSheetRow(componentRow) ? 1 : 0;
    return count + ownCount + countEligibleDescendants({
      skuMap,
      sku: component.sku,
      seen,
    });
  }, 0);
}

function serializeSheetRow({ skuMap, sku, parentSku = '', rootSku = '' }) {
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
  });
  const baseQuantity = rootQuantity == null ? row.defaultQuantity : rootQuantity;
  const isRootRow = rootQuantity == null;
  const noteMultiplier = isRootRow ? 1 : row.noteQuantityMultiplier;
  const rowWithQuantity = {
    ...row,
    printQuantity: parsePositiveInteger(baseQuantity * noteMultiplier, 1),
    quantityMultiplier: noteMultiplier,
  };

  const childRows = row.componentItems.flatMap((component) => collectPrintableSkuWithChildren({
    skuMap,
    sku: component.sku,
    rootSku: rootSku || normalizedSku,
    parentSku: normalizedSku,
    seen,
    rootQuantity: baseQuantity,
  }));

  return includeCurrent || isPrintableSheetRow(sheetRow)
    ? [rowWithQuantity, ...childRows]
    : childRows;
}

function buildPrintCatalogFromSheet({ skuMap }) {
  if (!(skuMap instanceof Map)) return [];

  return Array.from(skuMap.entries())
    .filter(([, row]) => isPrintableSheetRow(row))
    .map(([sku]) => serializeSheetRow({ skuMap, sku }))
    .sort((left, right) => {
      const typeDiff = left.typeRaw.localeCompare(right.typeRaw);
      if (typeDiff !== 0) return typeDiff;
      return left.sku.localeCompare(right.sku);
    });
}

function buildPrintQueueItemsForCatalogSku({ skuMap, sku }) {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku || !(skuMap instanceof Map) || !skuMap.has(normalizedSku)) {
    return [];
  }

  if (!isPrintableSheetRow(skuMap.get(normalizedSku))) {
    return [];
  }

  const printableRows = collectPrintableSkuWithChildren({
    skuMap,
    sku: normalizedSku,
    includeCurrent: true,
  });
  const rootRow = printableRows[0];
  if (!rootRow) return [];

  return [{
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
  DEFAULT_PRINT_QUEUE_STAGE,
  normalizeStageKey,
  getPrintQueueStage,
  isPrintableSheetType,
  isPrintableSheetRow,
  buildPrintCatalogFromSheet,
  buildPrintQueueItemsForCatalogSku,
  parsePositiveInteger,
};
