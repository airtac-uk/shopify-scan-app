const fetch = require('node-fetch');

const DEFAULT_SHEET_ID = '12rubfiCDcpz2Vb5AFxaHuXwu0b-ac6Gpu_18iu3IxRQ';
const DEFAULT_GID = '0';
const DEFAULT_SHEET_NAME = 'PICK LIST BY SKU';
const CACHE_TTL_MS = 5 * 60 * 1000;
const PICKABLE_TYPES = new Set(['DROP IN', 'RACKED']);
const DESK_TYPE = 'DESK ITEM';
const NOTE_PRIORITY_HEADERS = ['LOCATION', 'SKU', 'PICK'];
const TYPE_ORDER = ['RACKED', 'DROP IN', 'DESK ITEM', '3RD PARTY'];
const TYPE_ORDER_INDEX = new Map(TYPE_ORDER.map((type, index) => [type, index]));

let cachedSheet = null;
let cacheExpiresAt = 0;

function normalizeSku(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function getTypeSortRank(type) {
  return TYPE_ORDER_INDEX.has(type) ? TYPE_ORDER_INDEX.get(type) : Number.MAX_SAFE_INTEGER;
}

function normalizeBundleGroupId(value) {
  return String(value || '').trim();
}

function parseGoogleVizJson(text) {
  const startIndex = text.indexOf('{');
  const endIndex = text.lastIndexOf('}');

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error('Unexpected Google Sheets response format');
  }

  const jsonString = text.slice(startIndex, endIndex + 1);
  return JSON.parse(jsonString);
}

function getCellValue(cell) {
  if (!cell) return '';
  if (Object.prototype.hasOwnProperty.call(cell, 'v') && cell.v != null) {
    return String(cell.v).trim();
  }
  if (Object.prototype.hasOwnProperty.call(cell, 'f') && cell.f != null) {
    return String(cell.f).trim();
  }
  return '';
}

function getSheetsApiCellValue(cell) {
  if (!cell) return '';

  const effective = cell.effectiveValue || cell.userEnteredValue || {};

  if (Object.prototype.hasOwnProperty.call(effective, 'stringValue')) {
    return String(effective.stringValue).trim();
  }
  if (Object.prototype.hasOwnProperty.call(effective, 'numberValue')) {
    return String(effective.numberValue).trim();
  }
  if (Object.prototype.hasOwnProperty.call(effective, 'boolValue')) {
    return effective.boolValue ? 'TRUE' : 'FALSE';
  }
  if (Object.prototype.hasOwnProperty.call(effective, 'formulaValue')) {
    return String(effective.formulaValue).trim();
  }

  return '';
}

function pickPrimaryNote(notes = []) {
  if (!notes.length) return '';

  for (const header of NOTE_PRIORITY_HEADERS) {
    const match = notes.find((entry) => entry.header === header);
    if (match) return match.note;
  }

  const plMatch = notes.find((entry) => /^PL\d+$/.test(entry.header));
  if (plMatch) return plMatch.note;

  return notes[0].note;
}

function addNoteForSku(noteMap, sku, header, note) {
  if (!sku || !note) return;

  if (!noteMap.has(sku)) {
    noteMap.set(sku, {
      note: '',
      notes: [],
    });
  }

  const payload = noteMap.get(sku);
  const alreadyExists = payload.notes.some(
    (entry) => entry.header === header && entry.note === note
  );

  if (!alreadyExists) {
    payload.notes.push({ header, note });
  }
}

function buildNotesBySkuFromSheetsApi(tableData) {
  const rows = tableData?.sheets?.[0]?.data?.[0]?.rowData || [];
  if (rows.length === 0) {
    return new Map();
  }

  const headers = (rows[0].values || []).map((cell) =>
    normalizeHeader(getSheetsApiCellValue(cell))
  );
  const skuIdx = headers.findIndex((h) => h === 'SKU');
  if (skuIdx < 0) {
    return new Map();
  }

  const notesBySku = new Map();

  for (let i = 1; i < rows.length; i += 1) {
    const values = rows[i].values || [];
    const rowSku = normalizeSku(getSheetsApiCellValue(values[skuIdx]));
    if (!rowSku) continue;

    for (let colIdx = 0; colIdx < values.length; colIdx += 1) {
      const rawNote = String(values[colIdx]?.note || '').trim();
      if (!rawNote) continue;

      const header = headers[colIdx] || `COL${colIdx + 1}`;
      let targetSku = rowSku;

      // PL cell notes belong to the component SKU in that PL cell.
      if (/^PL\d+$/.test(header)) {
        const componentSku = normalizeSku(getSheetsApiCellValue(values[colIdx]));
        if (!componentSku) continue;
        targetSku = componentSku;
      }

      addNoteForSku(notesBySku, targetSku, header, rawNote);
    }
  }

  for (const payload of notesBySku.values()) {
    payload.note = pickPrimaryNote(payload.notes);
  }

  return notesBySku;
}

function buildRowsFromTable(table) {
  const rows = table?.rows || [];
  let headers = (table?.cols || []).map((col) => normalizeHeader(col?.label || col?.id || ''));
  let dataStartIndex = 0;

  // Fallback for payloads that do not expose column labels.
  if (!headers.some(Boolean)) {
    if (rows.length === 0) {
      throw new Error('Google Sheet has no rows');
    }
    headers = (rows[0].c || []).map((cell) => normalizeHeader(getCellValue(cell)));
    dataStartIndex = 1;
  }

  const skuIdx = headers.findIndex((h) => h === 'SKU');
  const typeIdx = headers.findIndex((h) => h === 'PICK');
  const locationIdx = headers.findIndex((h) => h === 'LOCATION');
  const plIndexes = headers
    .map((h, idx) => ({ h, idx }))
    .filter((item) => /^PL\d+$/.test(item.h))
    .sort((a, b) => Number(a.h.slice(2)) - Number(b.h.slice(2)))
    .map((item) => item.idx);

  if (skuIdx < 0) {
    throw new Error(`Could not find SKU column in Google Sheet. Headers: ${JSON.stringify(headers)}`);
  }

  const skuMap = new Map();

  for (let i = dataStartIndex; i < rows.length; i += 1) {
    const rowCells = rows[i].c || [];
    const sku = normalizeSku(getCellValue(rowCells[skuIdx]));
    if (!sku) continue;

    const type = typeIdx >= 0 ? String(getCellValue(rowCells[typeIdx] || '')).trim().toUpperCase() : '';
    const location = locationIdx >= 0 ? String(getCellValue(rowCells[locationIdx] || '')).trim() : '';
    const components = plIndexes
      .map((idx) => normalizeSku(getCellValue(rowCells[idx] || '')))
      .filter(Boolean);

    skuMap.set(sku, {
      sku,
      type,
      location,
      components,
      note: '',
    });
  }

  return { skuMap, sourceRowCount: skuMap.size };
}

async function fetchNotesBySku({ sheetId, sheetName, apiKey }) {
  if (!apiKey) {
    return { notesBySku: new Map(), notesEnabled: false, notesLoaded: false };
  }

  const fields = [
    'sheets(data(rowData(values(note,effectiveValue,userEnteredValue))))',
  ].join(',');

  const url = [
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`,
    `?includeGridData=true`,
    `&ranges=${encodeURIComponent(sheetName)}`,
    `&fields=${encodeURIComponent(fields)}`,
    `&key=${encodeURIComponent(apiKey)}`,
  ].join('');

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sheets API note fetch failed (${response.status}): ${body}`);
  }

  const json = await response.json();
  const notesBySku = buildNotesBySkuFromSheetsApi(json);
  return { notesBySku, notesEnabled: true, notesLoaded: true };
}

async function fetchPickListSheet({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedSheet && now < cacheExpiresAt) {
    return cachedSheet;
  }

  const sheetId = process.env.PICKLIST_SHEET_ID || DEFAULT_SHEET_ID;
  const gid = process.env.PICKLIST_SHEET_GID || DEFAULT_GID;
  const sheetName = process.env.PICKLIST_SHEET_NAME || DEFAULT_SHEET_NAME;
  const baseUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&headers=1`;
  const fetchUrls = [];

  if (sheetName) {
    fetchUrls.push(`${baseUrl}&sheet=${encodeURIComponent(sheetName)}`);
  }
  if (gid) {
    fetchUrls.push(`${baseUrl}&gid=${gid}`);
  }
  fetchUrls.push(baseUrl);

  let built = null;
  let lastError = null;

  for (const url of fetchUrls) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch Google Sheet (${response.status})`);
      }

      const rawText = await response.text();
      const parsed = parseGoogleVizJson(rawText);
      built = buildRowsFromTable(parsed?.table);
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!built) {
    throw new Error(`Failed to load pick list sheet. ${lastError ? lastError.message : 'Unknown error'}`);
  }

  const apiKey = String(process.env.GOOGLE_API_KEY || '').trim();
  let notesEnabled = Boolean(apiKey);
  let notesLoaded = false;
  let notesError = null;

  if (notesEnabled) {
    try {
      const noteResult = await fetchNotesBySku({
        sheetId,
        sheetName,
        apiKey,
      });

      notesEnabled = noteResult.notesEnabled;
      notesLoaded = noteResult.notesLoaded;

      for (const [sku, row] of built.skuMap.entries()) {
        const notePayload = noteResult.notesBySku.get(sku);
        if (!notePayload) continue;
        row.note = notePayload.note || '';
        row.notes = notePayload.notes || [];
      }
    } catch (err) {
      notesError = err.message;
      console.error('Failed to fetch Google Sheet notes:', err);
    }
  }

  cachedSheet = {
    ...built,
    fetchedAt: new Date().toISOString(),
    notesEnabled,
    notesLoaded,
    notesError,
  };
  cacheExpiresAt = now + CACHE_TTL_MS;

  return cachedSheet;
}

function classifyComponent(skuMap, sku) {
  const sheetRow = skuMap.get(sku);
  if (!sheetRow) {
    return {
      sku,
      type: 'UNKNOWN',
      location: '',
      note: '',
      classification: 'review',
    };
  }

  if (sheetRow.type === DESK_TYPE) {
    return {
      sku,
      type: sheetRow.type,
      location: sheetRow.location,
      note: sheetRow.note || '',
      classification: 'desk',
    };
  }

  if (PICKABLE_TYPES.has(sheetRow.type)) {
    return {
      sku,
      type: sheetRow.type,
      location: sheetRow.location,
      note: sheetRow.note || '',
      classification: 'pick',
    };
  }

  return {
    sku,
    type: sheetRow.type || 'UNKNOWN',
    location: sheetRow.location,
    note: sheetRow.note || '',
    classification: 'review',
  };
}

function expandSkuRecursively({ skuMap, sku, quantity, outCounts, stackSet }) {
  if (!sku || quantity <= 0) return;

  outCounts.set(sku, (outCounts.get(sku) || 0) + quantity);

  if (stackSet.has(sku)) {
    return;
  }

  const row = skuMap.get(sku);
  if (!row || !Array.isArray(row.components) || row.components.length === 0) {
    return;
  }

  stackSet.add(sku);

  for (const componentSku of row.components) {
    expandSkuRecursively({
      skuMap,
      sku: componentSku,
      quantity,
      outCounts,
      stackSet,
    });
  }

  stackSet.delete(sku);
}

function mapCountsToDisplayRows({ skuMap, counts }) {
  const rows = Array.from(counts.entries()).map(([sku, qty]) => {
    const meta = classifyComponent(skuMap, sku);
    return {
      sku,
      quantity: qty,
      location: meta.location,
      type: meta.type,
      note: meta.note,
      classification: meta.classification,
    };
  });

  rows.sort((a, b) => {
    const typeRankDiff = getTypeSortRank(a.type) - getTypeSortRank(b.type);
    if (typeRankDiff !== 0) return typeRankDiff;
    return a.sku.localeCompare(b.sku);
  });

  return {
    mustPick: rows.filter((r) => r.classification === 'pick'),
    deskItems: rows.filter((r) => r.classification === 'desk'),
    reviewItems: rows.filter((r) => r.classification === 'review'),
  };
}

function buildPickListForOrder({ skuMap, lineItems }) {
  const lineSummaries = [];
  const totalCounts = new Map();
  const groupMeta = new Map();

  for (let lineIndex = 0; lineIndex < lineItems.length; lineIndex += 1) {
    const item = lineItems[lineIndex];
    const sku = normalizeSku(item.sku);
    const quantity = Number(item.quantity) || 0;
    if (!sku || quantity <= 0) continue;

    const lineCounts = new Map();

    expandSkuRecursively({
      skuMap,
      sku,
      quantity,
      outCounts: lineCounts,
      stackSet: new Set(),
    });

    for (const [componentSku, qty] of lineCounts.entries()) {
      totalCounts.set(componentSku, (totalCounts.get(componentSku) || 0) + qty);
    }

    const grouped = mapCountsToDisplayRows({ skuMap, counts: lineCounts });
    const lineMeta = classifyComponent(skuMap, sku);
    const bundleGroupId = normalizeBundleGroupId(item.bundleGroup?.id);
    const bundleGroupTitle = String(item.bundleGroup?.title || '').trim();
    const bundleGroupQuantity = Number(item.bundleGroup?.quantity) || null;
    const sortGroupKey = bundleGroupId ? `bundle:${bundleGroupId}` : `single:${lineIndex}`;
    const lineTypeRank = getTypeSortRank(lineMeta.type || 'UNKNOWN');

    lineSummaries.push({
      title: item.title,
      variantTitle: item.variantTitle,
      sku,
      quantity,
      lineType: lineMeta.type || 'UNKNOWN',
      bundleGroupId,
      bundleGroupTitle,
      bundleGroupQuantity,
      sortGroupKey,
      lineTypeRank,
      sourceIndex: lineIndex,
      mustPick: grouped.mustPick,
      deskItems: grouped.deskItems,
      reviewItems: grouped.reviewItems,
    });

    if (!groupMeta.has(sortGroupKey)) {
      groupMeta.set(sortGroupKey, {
        typeRank: lineTypeRank,
        sku,
        sourceIndex: lineIndex,
      });
    } else {
      const current = groupMeta.get(sortGroupKey);
      current.typeRank = Math.min(current.typeRank, lineTypeRank);
      if (sku.localeCompare(current.sku) < 0) {
        current.sku = sku;
      }
      current.sourceIndex = Math.min(current.sourceIndex, lineIndex);
    }
  }

  lineSummaries.sort((a, b) => {
    const aGroup = groupMeta.get(a.sortGroupKey);
    const bGroup = groupMeta.get(b.sortGroupKey);

    const typeRankDiff = aGroup.typeRank - bGroup.typeRank;
    if (typeRankDiff !== 0) return typeRankDiff;

    const groupSkuDiff = aGroup.sku.localeCompare(bGroup.sku);
    if (groupSkuDiff !== 0) return groupSkuDiff;

    const groupIndexDiff = aGroup.sourceIndex - bGroup.sourceIndex;
    if (groupIndexDiff !== 0) return groupIndexDiff;

    const inGroupTypeDiff = a.lineTypeRank - b.lineTypeRank;
    if (inGroupTypeDiff !== 0) return inGroupTypeDiff;

    const inGroupSkuDiff = a.sku.localeCompare(b.sku);
    if (inGroupSkuDiff !== 0) return inGroupSkuDiff;

    return a.sourceIndex - b.sourceIndex;
  });

  const cleanLineSummaries = lineSummaries.map((line) => ({
    title: line.title,
    variantTitle: line.variantTitle,
    sku: line.sku,
    quantity: line.quantity,
    lineType: line.lineType,
    bundleGroupId: line.bundleGroupId,
    bundleGroupTitle: line.bundleGroupTitle,
    bundleGroupQuantity: line.bundleGroupQuantity,
    mustPick: line.mustPick,
    deskItems: line.deskItems,
    reviewItems: line.reviewItems,
  }));

  const totals = mapCountsToDisplayRows({ skuMap, counts: totalCounts });

  return {
    lineItems: cleanLineSummaries,
    totals,
  };
}

module.exports = {
  fetchPickListSheet,
  buildPickListForOrder,
  normalizeSku,
};
