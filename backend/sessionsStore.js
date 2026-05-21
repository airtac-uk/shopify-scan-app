// sessionsStore.js (better-sqlite3 version)
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function resolveSessionDbPath() {
  const configuredPath = String(process.env.SESSION_DB || '').trim();
  if (!configuredPath) return path.resolve(__dirname, './db/sessions.db');
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(__dirname, configuredPath);
}

const dbPath = resolveSessionDbPath();

// Ensure DB folder exists
if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

// Open database
const db = new Database(dbPath);
console.log('Better-SQLite3 DB connected at', dbPath);

// Create table if not exists
db.prepare(`
  CREATE TABLE IF NOT EXISTS sessions (
    shop TEXT PRIMARY KEY,
    accessToken TEXT,
    scope TEXT,
    isOnline INTEGER,
    expires TEXT,
    associatedUser TEXT
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS waiting_qc_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT NOT NULL,
    staff TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_waiting_qc_events_barcode_createdAt
  ON waiting_qc_events (barcode, createdAt DESC, id DESC)
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS wholesale_build_progress (
    shop TEXT NOT NULL,
    barcode TEXT NOT NULL,
    itemKey TEXT NOT NULL,
    scannedQty INTEGER NOT NULL,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (shop, barcode, itemKey)
  )
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_wholesale_build_progress_shop_barcode
  ON wholesale_build_progress (shop, barcode)
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS pick_list_picked_progress (
    shop TEXT NOT NULL,
    barcode TEXT NOT NULL,
    rowKey TEXT NOT NULL,
    pickedCount INTEGER NOT NULL,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (shop, barcode, rowKey)
  )
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_pick_list_picked_progress_shop_barcode
  ON pick_list_picked_progress (shop, barcode)
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS wholesale_build_events (
    shop TEXT NOT NULL,
    barcode TEXT NOT NULL,
    orderId TEXT,
    orderNumber TEXT,
    staff TEXT,
    createdAt TEXT NOT NULL,
    PRIMARY KEY (shop, barcode)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS order_trackers (
    shop TEXT NOT NULL,
    orderId TEXT NOT NULL,
    barcode TEXT NOT NULL,
    orderNumber TEXT NOT NULL,
    publicToken TEXT NOT NULL UNIQUE,
    currentStageKey TEXT NOT NULL,
    currentStageLabel TEXT NOT NULL,
    currentStageDescription TEXT NOT NULL,
    currentStageTone TEXT NOT NULL,
    currentStageProgress REAL NOT NULL,
    currentStageIsTerminal INTEGER NOT NULL,
    workflowStatus TEXT,
    orderCreatedAt TEXT,
    lineItemsJson TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    lastEventAt TEXT NOT NULL,
    PRIMARY KEY (shop, orderId)
  )
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_order_trackers_publicToken
  ON order_trackers (publicToken)
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_order_trackers_shop_barcode
  ON order_trackers (shop, barcode)
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS order_tracker_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    orderId TEXT NOT NULL,
    stageKey TEXT NOT NULL,
    stageLabel TEXT NOT NULL,
    stageDescription TEXT NOT NULL,
    sourceTag TEXT,
    staff TEXT,
    createdAt TEXT NOT NULL
  )
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_order_tracker_events_shop_order_createdAt
  ON order_tracker_events (shop, orderId, createdAt ASC, id ASC)
`).run();

const orderTrackerEventColumns = db.prepare(`
  PRAGMA table_info(order_tracker_events)
`).all();

if (!orderTrackerEventColumns.some((column) => column?.name === 'staff')) {
  db.prepare(`
    ALTER TABLE order_tracker_events
    ADD COLUMN staff TEXT
  `).run();
}

db.prepare(`
  CREATE TABLE IF NOT EXISTS awaiting_parts_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    orderId TEXT NOT NULL,
    orderNumber TEXT NOT NULL,
    partSku TEXT NOT NULL,
    partTypeRaw TEXT NOT NULL,
    partTypeGroup TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    reportedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    resolvedAt TEXT
  )
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_awaiting_parts_items_shop_open
  ON awaiting_parts_items (shop, resolvedAt, partTypeGroup, partSku, createdAt)
`).run();

db.prepare(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_awaiting_parts_items_open_unique
  ON awaiting_parts_items (shop, orderId, partSku)
  WHERE resolvedAt IS NULL
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS print_queue_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    sourceType TEXT NOT NULL,
    sku TEXT,
    rootSku TEXT,
    parentSku TEXT,
    title TEXT NOT NULL,
    typeRaw TEXT,
    location TEXT,
    quantity INTEGER NOT NULL,
    rsq INTEGER,
    stageKey TEXT NOT NULL,
    childItemsJson TEXT,
    customFileName TEXT,
    customFileUrl TEXT,
    notes TEXT,
    createdBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    completedAt TEXT,
    putAwayAt TEXT,
    removedAt TEXT,
    removedBy TEXT
  )
`).run();

const printQueueItemColumns = db.prepare(`
  PRAGMA table_info(print_queue_items)
`).all();

if (!printQueueItemColumns.some((column) => column?.name === 'putAwayAt')) {
  db.prepare(`
    ALTER TABLE print_queue_items
    ADD COLUMN putAwayAt TEXT
  `).run();
}

if (!printQueueItemColumns.some((column) => column?.name === 'childItemsJson')) {
  db.prepare(`
    ALTER TABLE print_queue_items
    ADD COLUMN childItemsJson TEXT
  `).run();
}

if (!printQueueItemColumns.some((column) => column?.name === 'location')) {
  db.prepare(`
    ALTER TABLE print_queue_items
    ADD COLUMN location TEXT
  `).run();
}

if (!printQueueItemColumns.some((column) => column?.name === 'removedAt')) {
  db.prepare(`
    ALTER TABLE print_queue_items
    ADD COLUMN removedAt TEXT
  `).run();
}

if (!printQueueItemColumns.some((column) => column?.name === 'removedBy')) {
  db.prepare(`
    ALTER TABLE print_queue_items
    ADD COLUMN removedBy TEXT
  `).run();
}

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_print_queue_items_shop_stage
  ON print_queue_items (shop, stageKey, updatedAt DESC)
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_print_queue_items_shop_open
  ON print_queue_items (shop, completedAt, updatedAt DESC)
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_print_queue_items_shop_put_away
  ON print_queue_items (shop, putAwayAt, completedAt, updatedAt DESC)
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_print_queue_items_shop_removed
  ON print_queue_items (shop, removedAt, updatedAt DESC)
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS print_queue_settings (
    shop TEXT PRIMARY KEY,
    driveFolderIdsJson TEXT NOT NULL,
    stlExtensions TEXT NOT NULL,
    updatedBy TEXT,
    updatedAt TEXT NOT NULL
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS print_part_orientations (
    shop TEXT NOT NULL,
    sku TEXT NOT NULL,
    driveFileId TEXT,
    driveFileName TEXT,
    driveModifiedTime TEXT,
    driveSize TEXT,
    orientationJson TEXT NOT NULL,
    lockMode TEXT NOT NULL,
    updatedBy TEXT,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (shop, sku)
  )
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_print_part_orientations_shop_updated
  ON print_part_orientations (shop, updatedAt DESC)
`).run();

function normalizeBarcode(barcode) {
  return String(barcode || '').trim().toUpperCase();
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function generatePublicToken() {
  return crypto.randomBytes(18).toString('hex');
}

function buildOrderTrackerRecord(tracker) {
  if (!tracker) return null;

  const events = db.prepare(`
    SELECT stageKey, stageLabel, stageDescription, sourceTag, staff, createdAt
    FROM order_tracker_events
    WHERE shop = ? AND orderId = ?
    ORDER BY createdAt ASC, id ASC
  `).all(tracker.shop, tracker.orderId);

  return {
    ...tracker,
    currentStageIsTerminal: Boolean(tracker.currentStageIsTerminal),
    lineItems: safeJsonParse(tracker.lineItemsJson || '[]', []),
    events,
  };
}

function buildPrintQueueItemRecord(row) {
  if (!row) return null;

  return {
    id: Number(row.id),
    shop: String(row.shop || ''),
    sourceType: String(row.sourceType || ''),
    sku: normalizeBarcode(row.sku),
    rootSku: normalizeBarcode(row.rootSku),
    parentSku: normalizeBarcode(row.parentSku),
    title: String(row.title || '').trim(),
    typeRaw: String(row.typeRaw || '').trim().toUpperCase(),
    location: String(row.location || '').trim(),
    quantity: Math.max(1, Number(row.quantity) || 1),
    rsq: Number(row.rsq) > 0 ? Number(row.rsq) : null,
    stageKey: String(row.stageKey || '').trim(),
    childItems: safeJsonParse(row.childItemsJson || '[]', [])
      .map((item) => ({
        sku: normalizeBarcode(item?.sku),
        parentSku: normalizeBarcode(item?.parentSku),
        title: String(item?.title || item?.sku || '').trim(),
        typeRaw: String(item?.typeRaw || 'UNKNOWN').trim().toUpperCase(),
        location: String(item?.location || '').trim(),
        quantity: Math.max(1, Number(item?.quantity) || 1),
        rsq: Number(item?.rsq) > 0 ? Number(item.rsq) : null,
        quantityMultiplier: Math.max(1, Number(item?.quantityMultiplier) || 1),
        notes: String(item?.notes || '').trim(),
      }))
      .filter((item) => item.sku),
    customFileName: String(row.customFileName || '').trim(),
    customFileUrl: String(row.customFileUrl || '').trim(),
    notes: String(row.notes || '').trim(),
    createdBy: String(row.createdBy || '').trim(),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    completedAt: row.completedAt || null,
    putAwayAt: row.putAwayAt || null,
    removedAt: row.removedAt || null,
    removedBy: String(row.removedBy || '').trim(),
  };
}

function normalizePrintQueueSettings(row) {
  return {
    driveFolderIds: safeJsonParse(row?.driveFolderIdsJson || '[]', [])
      .map((folderId) => String(folderId || '').trim())
      .filter(Boolean),
    stlExtensions: String(row?.stlExtensions || 'stl,3mf').trim() || 'stl,3mf',
    updatedBy: String(row?.updatedBy || '').trim(),
    updatedAt: row?.updatedAt || null,
  };
}

function normalizeOrientationValue(value) {
  const parsed = typeof value === 'string' ? safeJsonParse(value || '{}', {}) : (value || {});
  const x = Number(parsed?.x || 0);
  const y = Number(parsed?.y || 0);
  const z = Number(parsed?.z || 0);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    z: Number.isFinite(z) ? z : 0,
  };
}

function normalizePrintPartOrientationRecord(row) {
  if (!row) return null;

  return {
    shop: String(row.shop || '').trim(),
    sku: normalizeBarcode(row.sku),
    driveFileId: String(row.driveFileId || '').trim(),
    driveFileName: String(row.driveFileName || '').trim(),
    driveModifiedTime: String(row.driveModifiedTime || '').trim(),
    driveSize: String(row.driveSize || '').trim(),
    orientation: normalizeOrientationValue(row.orientationJson),
    lockMode: String(row.lockMode || 'LOCKED_XY_ROTATION_FREE_TRANSLATION').trim() || 'LOCKED_XY_ROTATION_FREE_TRANSLATION',
    updatedBy: String(row.updatedBy || '').trim(),
    updatedAt: row.updatedAt || null,
  };
}

module.exports = {
  /**
   * Save session for a shop
   * @param {string} shop 
   * @param {object} session - { accessToken, scope, isOnline, expires, associated_user }
   */
  set(shop, session) {
    const { accessToken, scope, isOnline, expires, associated_user } = session;

    const expiresStr = expires ? new Date(expires).toISOString() : null;
    const associatedUserStr = associated_user ? JSON.stringify(associated_user) : null;

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO sessions
      (shop, accessToken, scope, isOnline, expires, associatedUser)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(shop, accessToken, scope, isOnline ? 1 : 0, expiresStr, associatedUserStr);

    console.log(`Saving session for shop ${shop}:`, session);
    console.log(`Session stored for shop ${shop}`);
  },

  /**
   * Retrieve session for a shop
   * @param {string} shop 
   * @returns {object|null} session
   */
  get(shop) {
    const row = db.prepare('SELECT * FROM sessions WHERE shop = ?').get(shop);
    if (!row) return null;

    return {
      shop: shop,
      accessToken: row.accessToken,
      scope: row.scope,
      isOnline: !!row.isOnline,
      expires: row.expires ? new Date(row.expires) : null,
      associated_user: row.associatedUser ? JSON.parse(row.associatedUser) : null
    };
  },

  list() {
    return db.prepare('SELECT * FROM sessions ORDER BY shop ASC').all().map((row) => ({
      shop: row.shop,
      accessToken: row.accessToken,
      scope: row.scope,
      isOnline: !!row.isOnline,
      expires: row.expires ? new Date(row.expires) : null,
      associated_user: row.associatedUser ? JSON.parse(row.associatedUser) : null,
    }));
  },

  recordWaitingQcEvent({ barcode, staff, createdAt }) {
    const normalizedBarcode = normalizeBarcode(barcode);
    if (!normalizedBarcode || !staff) return;

    const stmt = db.prepare(`
      INSERT INTO waiting_qc_events (barcode, staff, createdAt)
      VALUES (?, ?, ?)
    `);
    stmt.run(normalizedBarcode, String(staff), createdAt || new Date().toISOString());
  },

  getLatestWaitingQcStaffByBarcode(barcode) {
    const normalizedBarcode = normalizeBarcode(barcode);
    if (!normalizedBarcode) return null;

    const row = db.prepare(`
      SELECT staff
      FROM waiting_qc_events
      WHERE barcode = ?
      ORDER BY createdAt DESC, id DESC
      LIMIT 1
    `).get(normalizedBarcode);

    return row?.staff || null;
  },

  getWholesaleBuildProgress({ shop, barcode }) {
    const normalizedBarcode = normalizeBarcode(barcode);
    if (!shop || !normalizedBarcode) return {};

    const rows = db.prepare(`
      SELECT itemKey, scannedQty
      FROM wholesale_build_progress
      WHERE shop = ? AND barcode = ?
    `).all(String(shop), normalizedBarcode);

    const progressByItemKey = {};
    rows.forEach((row) => {
      if (!row?.itemKey) return;
      const qty = Math.max(0, Number(row.scannedQty) || 0);
      progressByItemKey[String(row.itemKey)] = qty;
    });

    return progressByItemKey;
  },

  getWholesaleBuildEvent({ shop, barcode }) {
    const normalizedBarcode = normalizeBarcode(barcode);
    if (!shop || !normalizedBarcode) return null;

    return db.prepare(`
      SELECT shop, barcode, orderId, orderNumber, staff, createdAt
      FROM wholesale_build_events
      WHERE shop = ? AND barcode = ?
      LIMIT 1
    `).get(String(shop), normalizedBarcode) || null;
  },

  recordWholesaleBuildEvent({
    shop,
    barcode,
    orderId = null,
    orderNumber = null,
    staff = null,
    createdAt = null,
  }) {
    const normalizedBarcode = normalizeBarcode(barcode);
    if (!shop || !normalizedBarcode) return false;

    const result = db.prepare(`
      INSERT OR IGNORE INTO wholesale_build_events
      (shop, barcode, orderId, orderNumber, staff, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      String(shop),
      normalizedBarcode,
      orderId ? String(orderId) : null,
      orderNumber ? String(orderNumber) : null,
      staff ? String(staff) : null,
      createdAt || new Date().toISOString()
    );

    return Number(result?.changes || 0) > 0;
  },

  getPickListPickedProgress({ shop, barcode }) {
    const normalizedBarcode = normalizeBarcode(barcode);
    if (!shop || !normalizedBarcode) return {};

    const rows = db.prepare(`
      SELECT rowKey, pickedCount
      FROM pick_list_picked_progress
      WHERE shop = ? AND barcode = ?
    `).all(String(shop), normalizedBarcode);

    const pickedRowCounts = {};
    rows.forEach((row) => {
      if (!row?.rowKey) return;
      const pickedCount = Math.max(0, Number(row.pickedCount) || 0);
      if (pickedCount <= 0) return;
      pickedRowCounts[String(row.rowKey)] = pickedCount;
    });

    return pickedRowCounts;
  },

  setPickListPickedProgress({ shop, barcode, pickedRowCounts }) {
    const normalizedBarcode = normalizeBarcode(barcode);
    if (!shop || !normalizedBarcode) return;

    const entries = Object.entries(pickedRowCounts || {})
      .map(([rowKey, pickedCount]) => ({
        rowKey: String(rowKey || '').trim(),
        pickedCount: Math.max(0, Math.floor(Number(pickedCount) || 0)),
      }))
      .filter((entry) => entry.rowKey && entry.pickedCount > 0);

    const nowIso = new Date().toISOString();
    const deleteStmt = db.prepare(`
      DELETE FROM pick_list_picked_progress
      WHERE shop = ? AND barcode = ?
    `);
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO pick_list_picked_progress
      (shop, barcode, rowKey, pickedCount, updatedAt)
      VALUES (?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      deleteStmt.run(String(shop), normalizedBarcode);
      entries.forEach((entry) => {
        insertStmt.run(String(shop), normalizedBarcode, entry.rowKey, entry.pickedCount, nowIso);
      });
    });

    tx();
  },

  setWholesaleBuildProgress({ shop, barcode, progressByItemKey }) {
    const normalizedBarcode = normalizeBarcode(barcode);
    if (!shop || !normalizedBarcode) return;

    const entries = Object.entries(progressByItemKey || {})
      .map(([itemKey, scannedQty]) => ({
        itemKey: String(itemKey || '').trim(),
        scannedQty: Math.max(0, Number(scannedQty) || 0),
      }))
      .filter((entry) => entry.itemKey && entry.scannedQty > 0);

    const nowIso = new Date().toISOString();
    const deleteStmt = db.prepare(`
      DELETE FROM wholesale_build_progress
      WHERE shop = ? AND barcode = ?
    `);
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO wholesale_build_progress
      (shop, barcode, itemKey, scannedQty, updatedAt)
      VALUES (?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      deleteStmt.run(String(shop), normalizedBarcode);
      entries.forEach((entry) => {
        insertStmt.run(String(shop), normalizedBarcode, entry.itemKey, entry.scannedQty, nowIso);
      });
    });

    tx();
  },

  saveOrderTrackerSnapshot({
    shop,
    orderId,
    barcode,
    orderNumber,
    orderCreatedAt,
    currentStage,
    workflowStatus,
    lineItems,
    legacyEvents = [],
    appendEventIfStageChanged = false,
    sourceTag = null,
    staff = null,
  }) {
    const normalizedBarcode = normalizeBarcode(barcode);
    const normalizedOrderId = String(orderId || '').trim();
    const normalizedOrderNumber = String(orderNumber || '').trim();
    const stageKey = String(currentStage?.key || '').trim();

    if (!shop || !normalizedOrderId || !normalizedBarcode || !normalizedOrderNumber || !stageKey) {
      return null;
    }

    const nowIso = new Date().toISOString();
    const safeLineItems = Array.isArray(lineItems) ? lineItems : [];
    const serializedLineItems = JSON.stringify(safeLineItems);
    const stageLabel = String(currentStage?.label || stageKey).trim();
    const stageDescription = String(currentStage?.description || '').trim();
    const stageTone = String(currentStage?.tone || 'info').trim();
    const stageProgress = Number.isFinite(Number(currentStage?.progress))
      ? Number(currentStage.progress)
      : 0;
    const stageIsTerminal = currentStage?.isTerminal ? 1 : 0;
    const normalizedWorkflowStatus = String(workflowStatus || '').trim() || null;
    const normalizedStaff = String(staff || '').trim() || null;
    const safeLegacyEvents = Array.isArray(legacyEvents)
      ? legacyEvents
          .map((event) => ({
            stageKey: String(event?.stageKey || '').trim(),
            stageLabel: String(event?.stageLabel || '').trim(),
            stageDescription: String(event?.stageDescription || '').trim(),
            sourceTag: String(event?.sourceTag || '').trim() || null,
            staff: String(event?.staff || '').trim() || null,
            createdAt: String(event?.createdAt || '').trim() || null,
          }))
          .filter((event) => event.stageKey && event.stageLabel)
      : [];

    const existing = db.prepare(`
      SELECT publicToken, currentStageKey, lastEventAt
      FROM order_trackers
      WHERE shop = ? AND orderId = ?
    `).get(String(shop), normalizedOrderId);

    const publicToken = existing?.publicToken || generatePublicToken();

    const countRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM order_tracker_events
      WHERE shop = ? AND orderId = ?
    `).get(String(shop), normalizedOrderId);
    const existingEventCount = Number(countRow?.count || 0);
    const hasEvents = existingEventCount > 0;
    const shouldSeedLegacyEvents = safeLegacyEvents.length > 0 && (
      !hasEvents ||
      (existingEventCount === 1 && existing?.currentStageKey === 'received')
    );

    const insertOrUpdateStmt = db.prepare(`
      INSERT INTO order_trackers (
        shop, orderId, barcode, orderNumber, publicToken,
        currentStageKey, currentStageLabel, currentStageDescription,
        currentStageTone, currentStageProgress, currentStageIsTerminal,
        workflowStatus, orderCreatedAt, lineItemsJson, updatedAt, lastEventAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop, orderId) DO UPDATE SET
        barcode = excluded.barcode,
        orderNumber = excluded.orderNumber,
        currentStageKey = excluded.currentStageKey,
        currentStageLabel = excluded.currentStageLabel,
        currentStageDescription = excluded.currentStageDescription,
        currentStageTone = excluded.currentStageTone,
        currentStageProgress = excluded.currentStageProgress,
        currentStageIsTerminal = excluded.currentStageIsTerminal,
        workflowStatus = excluded.workflowStatus,
        orderCreatedAt = COALESCE(order_trackers.orderCreatedAt, excluded.orderCreatedAt),
        lineItemsJson = excluded.lineItemsJson,
        updatedAt = excluded.updatedAt,
        lastEventAt = excluded.lastEventAt
    `);

    const insertEventStmt = db.prepare(`
      INSERT INTO order_tracker_events (
        shop, orderId, stageKey, stageLabel, stageDescription, sourceTag, staff, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      let lastEventAt = existing?.lastEventAt || nowIso;
      let priorStageKey = existing?.currentStageKey || 'received';

      if (!hasEvents) {
        const initialCreatedAt = orderCreatedAt || nowIso;
        insertEventStmt.run(
          String(shop),
          normalizedOrderId,
          'received',
          'Order received',
          'We have your order and it is in the queue.',
          null,
          null,
          initialCreatedAt
        );
        lastEventAt = initialCreatedAt;
      }

      if (shouldSeedLegacyEvents) {
        safeLegacyEvents.forEach((event) => {
          const eventCreatedAt = event.createdAt || nowIso;
          insertEventStmt.run(
            String(shop),
            normalizedOrderId,
            event.stageKey,
            event.stageLabel,
            event.stageDescription,
            event.sourceTag,
            event.staff,
            eventCreatedAt
          );
          priorStageKey = event.stageKey;
          lastEventAt = eventCreatedAt;
        });
      }

      if (
        appendEventIfStageChanged &&
        stageKey !== 'received' &&
        stageKey !== priorStageKey
      ) {
        insertEventStmt.run(
          String(shop),
          normalizedOrderId,
          stageKey,
          stageLabel,
          stageDescription,
          sourceTag ? String(sourceTag) : null,
          normalizedStaff,
          nowIso
        );
        lastEventAt = nowIso;
      }

      insertOrUpdateStmt.run(
        String(shop),
        normalizedOrderId,
        normalizedBarcode,
        normalizedOrderNumber,
        publicToken,
        stageKey,
        stageLabel,
        stageDescription,
        stageTone,
        stageProgress,
        stageIsTerminal,
        normalizedWorkflowStatus,
        orderCreatedAt || null,
        serializedLineItems,
        nowIso,
        lastEventAt
      );
    });

    tx();

    return {
      publicToken,
      lastEventAt: existing?.lastEventAt || nowIso,
    };
  },

  upsertAwaitingPartsItems({
    shop,
    orderId,
    orderNumber,
    reportedBy,
    items = [],
    createdAt,
  }) {
    const normalizedOrderId = String(orderId || '').trim();
    const normalizedOrderNumber = String(orderNumber || '').trim();
    if (!shop || !normalizedOrderId || !normalizedOrderNumber) {
      return { openItemCount: 0 };
    }

    const nowIso = createdAt || new Date().toISOString();
    const normalizedItems = Object.values((items || []).reduce((acc, item) => {
      const partSku = normalizeBarcode(item?.partSku || item?.sku);
      if (!partSku) return acc;

      const key = partSku;
      const quantity = Math.max(1, Number(item?.quantity) || 1);
      if (!acc[key]) {
        acc[key] = {
          partSku,
          partTypeRaw: String(item?.partTypeRaw || item?.type || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN',
          partTypeGroup: String(item?.partTypeGroup || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN',
          quantity: 0,
        };
      }

      acc[key].quantity += quantity;
      return acc;
    }, {}));

    const existingOpenRows = db.prepare(`
      SELECT id, partSku
      FROM awaiting_parts_items
      WHERE shop = ? AND orderId = ? AND resolvedAt IS NULL
    `).all(String(shop), normalizedOrderId);

    const existingBySku = new Map(
      existingOpenRows.map((row) => [String(row.partSku || '').trim().toUpperCase(), row])
    );
    const nextSkuSet = new Set(normalizedItems.map((item) => item.partSku));

    const insertStmt = db.prepare(`
      INSERT INTO awaiting_parts_items (
        shop, orderId, orderNumber, partSku, partTypeRaw, partTypeGroup,
        quantity, reportedBy, createdAt, updatedAt, resolvedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `);

    const updateStmt = db.prepare(`
      UPDATE awaiting_parts_items
      SET orderNumber = ?, partTypeRaw = ?, partTypeGroup = ?, quantity = ?, reportedBy = ?, updatedAt = ?
      WHERE id = ?
    `);

    const resolveStmt = db.prepare(`
      UPDATE awaiting_parts_items
      SET resolvedAt = ?, updatedAt = ?
      WHERE id = ?
    `);

    const tx = db.transaction(() => {
      normalizedItems.forEach((item) => {
        const existing = existingBySku.get(item.partSku);
        if (existing) {
          updateStmt.run(
            normalizedOrderNumber,
            item.partTypeRaw,
            item.partTypeGroup,
            item.quantity,
            reportedBy ? String(reportedBy) : null,
            nowIso,
            existing.id
          );
          return;
        }

        insertStmt.run(
          String(shop),
          normalizedOrderId,
          normalizedOrderNumber,
          item.partSku,
          item.partTypeRaw,
          item.partTypeGroup,
          item.quantity,
          reportedBy ? String(reportedBy) : null,
          nowIso,
          nowIso
        );
      });

      existingOpenRows.forEach((row) => {
        const partSku = String(row.partSku || '').trim().toUpperCase();
        if (nextSkuSet.has(partSku)) return;
        resolveStmt.run(nowIso, nowIso, row.id);
      });
    });

    tx();

    return { openItemCount: normalizedItems.length };
  },

  resolveAwaitingPartsForOrder({ shop, orderId, resolvedAt }) {
    const normalizedOrderId = String(orderId || '').trim();
    if (!shop || !normalizedOrderId) {
      return 0;
    }

    const nowIso = resolvedAt || new Date().toISOString();
    const result = db.prepare(`
      UPDATE awaiting_parts_items
      SET resolvedAt = ?, updatedAt = ?
      WHERE shop = ? AND orderId = ? AND resolvedAt IS NULL
    `).run(nowIso, nowIso, String(shop), normalizedOrderId);

    return Number(result?.changes || 0);
  },

  getOpenAwaitingPartsItemsForOrder({ shop, orderId }) {
    const normalizedOrderId = String(orderId || '').trim();
    if (!shop || !normalizedOrderId) {
      return [];
    }

    const rows = db.prepare(`
      SELECT partSku, quantity
      FROM awaiting_parts_items
      WHERE shop = ? AND orderId = ? AND resolvedAt IS NULL
      ORDER BY partSku ASC
    `).all(String(shop), normalizedOrderId);

    return rows.map((row) => ({
      partSku: normalizeBarcode(row?.partSku),
      quantity: Math.max(1, Number(row?.quantity) || 1),
    })).filter((row) => row.partSku);
  },

  getOpenAwaitingPartsSkusForOrder({ shop, orderId }) {
    return this.getOpenAwaitingPartsItemsForOrder({ shop, orderId })
      .map((item) => item.partSku);
  },

  getPrintQueueSettings({ shop } = {}) {
    const normalizedShop = String(shop || '').trim();
    if (!normalizedShop) {
      return normalizePrintQueueSettings(null);
    }

    const row = db.prepare(`
      SELECT *
      FROM print_queue_settings
      WHERE shop = ?
      LIMIT 1
    `).get(normalizedShop);

    return normalizePrintQueueSettings(row);
  },

  updatePrintQueueSettings({ shop, driveFolderIds = [], stlExtensions = 'stl,3mf', updatedBy = null } = {}) {
    const normalizedShop = String(shop || '').trim();
    if (!normalizedShop) {
      return normalizePrintQueueSettings(null);
    }

    const normalizedFolderIds = Array.from(new Set((Array.isArray(driveFolderIds) ? driveFolderIds : [])
      .map((folderId) => String(folderId || '').trim())
      .filter(Boolean)));
    const normalizedExtensions = String(stlExtensions || 'stl,3mf')
      .split(',')
      .map((extension) => extension.trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean)
      .join(',') || 'stl,3mf';
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO print_queue_settings (
        shop, driveFolderIdsJson, stlExtensions, updatedBy, updatedAt
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(shop) DO UPDATE SET
        driveFolderIdsJson = excluded.driveFolderIdsJson,
        stlExtensions = excluded.stlExtensions,
        updatedBy = excluded.updatedBy,
        updatedAt = excluded.updatedAt
    `).run(
      normalizedShop,
      JSON.stringify(normalizedFolderIds),
      normalizedExtensions,
      updatedBy ? String(updatedBy).trim() : null,
      nowIso
    );

    return this.getPrintQueueSettings({ shop: normalizedShop });
  },

  getPrintPartOrientation({ shop, sku } = {}) {
    const normalizedShop = String(shop || '').trim();
    const normalizedSku = normalizeBarcode(sku);
    if (!normalizedShop || !normalizedSku) return null;

    const row = db.prepare(`
      SELECT *
      FROM print_part_orientations
      WHERE shop = ?
        AND sku = ?
      LIMIT 1
    `).get(normalizedShop, normalizedSku);

    return normalizePrintPartOrientationRecord(row);
  },

  getPrintPartOrientationsForSkus({ shop, skus = [] } = {}) {
    const normalizedShop = String(shop || '').trim();
    const normalizedSkus = Array.from(new Set((Array.isArray(skus) ? skus : [])
      .map(normalizeBarcode)
      .filter(Boolean)));
    if (!normalizedShop || normalizedSkus.length === 0) return {};

    const placeholders = normalizedSkus.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT *
      FROM print_part_orientations
      WHERE shop = ?
        AND sku IN (${placeholders})
    `).all(normalizedShop, ...normalizedSkus);

    return rows.reduce((acc, row) => {
      const record = normalizePrintPartOrientationRecord(row);
      if (record?.sku) acc[record.sku] = record;
      return acc;
    }, {});
  },

  listPrintPartOrientations({ shop, limit = 50 } = {}) {
    const normalizedShop = String(shop || '').trim();
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    if (!normalizedShop) return [];

    return db.prepare(`
      SELECT *
      FROM print_part_orientations
      WHERE shop = ?
      ORDER BY updatedAt DESC
      LIMIT ?
    `).all(normalizedShop, safeLimit).map(normalizePrintPartOrientationRecord).filter(Boolean);
  },

  savePrintPartOrientation({
    shop,
    sku,
    driveFile = null,
    orientation = {},
    lockMode = 'LOCKED_XY_ROTATION_FREE_TRANSLATION',
    updatedBy = null,
  } = {}) {
    const normalizedShop = String(shop || '').trim();
    const normalizedSku = normalizeBarcode(sku);
    if (!normalizedShop || !normalizedSku) return null;

    const normalizedOrientation = normalizeOrientationValue(orientation);
    const normalizedLockMode = String(lockMode || 'LOCKED_XY_ROTATION_FREE_TRANSLATION').trim()
      || 'LOCKED_XY_ROTATION_FREE_TRANSLATION';
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO print_part_orientations (
        shop, sku, driveFileId, driveFileName, driveModifiedTime, driveSize,
        orientationJson, lockMode, updatedBy, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop, sku) DO UPDATE SET
        driveFileId = excluded.driveFileId,
        driveFileName = excluded.driveFileName,
        driveModifiedTime = excluded.driveModifiedTime,
        driveSize = excluded.driveSize,
        orientationJson = excluded.orientationJson,
        lockMode = excluded.lockMode,
        updatedBy = excluded.updatedBy,
        updatedAt = excluded.updatedAt
    `).run(
      normalizedShop,
      normalizedSku,
      String(driveFile?.id || '').trim(),
      String(driveFile?.name || '').trim(),
      String(driveFile?.modifiedTime || '').trim(),
      String(driveFile?.size || '').trim(),
      JSON.stringify(normalizedOrientation),
      normalizedLockMode,
      updatedBy ? String(updatedBy).trim() : null,
      nowIso
    );

    return this.getPrintPartOrientation({ shop: normalizedShop, sku: normalizedSku });
  },

  getOpenAwaitingPartsItemsForSkus({ shop, skus = [] } = {}) {
    const normalizedShop = String(shop || '').trim();
    const normalizedSkus = Array.from(new Set((Array.isArray(skus) ? skus : [])
      .map(normalizeBarcode)
      .filter(Boolean)));

    if (!normalizedShop || normalizedSkus.length === 0) {
      return [];
    }

    const placeholders = normalizedSkus.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT
        api.partSku AS partSku,
        api.partTypeRaw AS partTypeRaw,
        api.partTypeGroup AS partTypeGroup,
        api.orderId AS orderId,
        api.orderNumber AS orderNumber,
        api.quantity AS quantity,
        api.reportedBy AS reportedBy,
        api.createdAt AS createdAt,
        api.updatedAt AS updatedAt
      FROM awaiting_parts_items api
      INNER JOIN order_trackers ot
        ON ot.shop = api.shop
       AND ot.orderId = api.orderId
      WHERE api.shop = ?
        AND api.resolvedAt IS NULL
        AND api.partSku IN (${placeholders})
        AND ot.currentStageKey = 'awaiting_parts'
        AND COALESCE(UPPER(ot.workflowStatus), '') != 'CANCELLED'
      ORDER BY api.partSku ASC, api.createdAt ASC, api.orderNumber ASC
    `).all(normalizedShop, ...normalizedSkus);

    return rows.map((row) => ({
      partSku: normalizeBarcode(row.partSku),
      partTypeRaw: String(row.partTypeRaw || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN',
      partTypeGroup: String(row.partTypeGroup || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN',
      orderId: String(row.orderId || '').trim(),
      orderNumber: String(row.orderNumber || '').trim(),
      quantity: Math.max(1, Number(row.quantity) || 1),
      reportedBy: String(row.reportedBy || '').trim(),
      createdAt: row.createdAt || null,
      updatedAt: row.updatedAt || null,
    })).filter((row) => row.partSku && row.orderId);
  },

  addPrintQueueItems({ shop, items = [], createdBy = null }) {
    const normalizedShop = String(shop || '').trim();
    if (!normalizedShop) return [];

    const nowIso = new Date().toISOString();
    const safeCreatedBy = createdBy ? String(createdBy).trim() : null;
    const normalizedItems = (Array.isArray(items) ? items : [])
      .map((item) => {
        const sourceType = String(item?.sourceType || 'catalog').trim().toLowerCase() === 'custom'
          ? 'custom'
          : 'catalog';
        const sku = normalizeBarcode(item?.sku);
        const rootSku = normalizeBarcode(item?.rootSku || sku);
        const parentSku = normalizeBarcode(item?.parentSku);
        const title = String(item?.title || sku || 'Custom print file').trim();
        const location = String(item?.location || '').trim();
        const quantity = Math.max(1, Math.floor(Number(item?.quantity) || 1));
        const rsq = Number(item?.rsq) > 0 ? Math.floor(Number(item.rsq)) : null;
        const stageKey = String(item?.stageKey || 'needs_printed').trim().toLowerCase();
        const childItems = Array.isArray(item?.childItems)
          ? item.childItems.map((childItem) => ({
              sku: normalizeBarcode(childItem?.sku),
              parentSku: normalizeBarcode(childItem?.parentSku),
              title: String(childItem?.title || childItem?.sku || '').trim(),
              typeRaw: String(childItem?.typeRaw || 'UNKNOWN').trim().toUpperCase(),
              location: String(childItem?.location || '').trim(),
              quantity: Math.max(1, Math.floor(Number(childItem?.quantity) || 1)),
              rsq: Number(childItem?.rsq) > 0 ? Math.floor(Number(childItem.rsq)) : null,
              quantityMultiplier: Math.max(1, Number(childItem?.quantityMultiplier) || 1),
              notes: String(childItem?.notes || '').trim(),
            })).filter((childItem) => childItem.sku)
          : [];

        return {
          sourceType,
          sku,
          rootSku,
          parentSku,
          title,
          typeRaw: String(item?.typeRaw || (sourceType === 'custom' ? 'CUSTOM' : 'UNKNOWN')).trim().toUpperCase(),
          location,
          quantity,
          rsq,
          stageKey,
          childItems,
          customFileName: String(item?.customFileName || '').trim(),
          customFileUrl: String(item?.customFileUrl || '').trim(),
          notes: String(item?.notes || '').trim(),
        };
      })
      .filter((item) => item.title && item.quantity > 0);

    if (normalizedItems.length === 0) return [];

    const insertStmt = db.prepare(`
      INSERT INTO print_queue_items (
        shop, sourceType, sku, rootSku, parentSku, title, typeRaw, location, quantity, rsq,
        stageKey, childItemsJson, customFileName, customFileUrl, notes, createdBy, createdAt, updatedAt, completedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const getStmt = db.prepare(`
      SELECT *
      FROM print_queue_items
      WHERE id = ?
    `);
    const insertedRows = [];

    const tx = db.transaction(() => {
      normalizedItems.forEach((item) => {
        const completedAt = item.stageKey === 'complete' ? nowIso : null;
        const result = insertStmt.run(
          normalizedShop,
          item.sourceType,
          item.sku || null,
          item.rootSku || null,
          item.parentSku || null,
          item.title,
          item.typeRaw,
          item.location || null,
          item.quantity,
          item.rsq,
          item.stageKey,
          JSON.stringify(item.childItems || []),
          item.customFileName || null,
          item.customFileUrl || null,
          item.notes || null,
          safeCreatedBy,
          nowIso,
          nowIso,
          completedAt
        );

        insertedRows.push(buildPrintQueueItemRecord(getStmt.get(Number(result.lastInsertRowid))));
      });
    });

    tx();
    return insertedRows.filter(Boolean);
  },

  getPrintQueueItems({ shop, completeLimit = 80 } = {}) {
    const normalizedShop = String(shop || '').trim();
    if (!normalizedShop) return [];

    const openRows = db.prepare(`
      SELECT *
      FROM print_queue_items
      WHERE shop = ?
        AND putAwayAt IS NULL
        AND removedAt IS NULL
        AND completedAt IS NULL
      ORDER BY updatedAt DESC, id DESC
    `).all(normalizedShop);

    const completedRows = db.prepare(`
      SELECT *
      FROM print_queue_items
      WHERE shop = ?
        AND putAwayAt IS NULL
        AND removedAt IS NULL
        AND completedAt IS NOT NULL
      ORDER BY completedAt DESC, id DESC
      LIMIT ?
    `).all(normalizedShop, Math.max(0, Math.floor(Number(completeLimit) || 0)));

    return [...openRows, ...completedRows].map(buildPrintQueueItemRecord).filter(Boolean);
  },

  getActivePrintQueueItems({ shop } = {}) {
    const normalizedShop = String(shop || '').trim();
    if (!normalizedShop) return [];

    const rows = db.prepare(`
      SELECT *
      FROM print_queue_items
      WHERE shop = ?
        AND putAwayAt IS NULL
        AND removedAt IS NULL
      ORDER BY updatedAt DESC, id DESC
    `).all(normalizedShop);

    return rows.map(buildPrintQueueItemRecord).filter(Boolean);
  },

  updatePrintQueueItemStage({ shop, id, stageKey }) {
    const normalizedShop = String(shop || '').trim();
    const normalizedId = Number(id);
    const normalizedStageKey = String(stageKey || '').trim().toLowerCase();
    if (!normalizedShop || !Number.isInteger(normalizedId) || normalizedId <= 0 || !normalizedStageKey) {
      return null;
    }

    const nowIso = new Date().toISOString();
    const completedAt = normalizedStageKey === 'complete' ? nowIso : null;
    const result = db.prepare(`
      UPDATE print_queue_items
      SET stageKey = ?,
          updatedAt = ?,
          completedAt = ?
      WHERE shop = ?
        AND id = ?
        AND removedAt IS NULL
    `).run(normalizedStageKey, nowIso, completedAt, normalizedShop, normalizedId);

    if (Number(result?.changes || 0) === 0) {
      return null;
    }

    const row = db.prepare(`
      SELECT *
      FROM print_queue_items
      WHERE shop = ?
        AND id = ?
        AND removedAt IS NULL
      LIMIT 1
    `).get(normalizedShop, normalizedId);

    return buildPrintQueueItemRecord(row);
  },

  putAwayPrintQueueItem({ shop, id, putAwayAt = null }) {
    const normalizedShop = String(shop || '').trim();
    const normalizedId = Number(id);
    if (!normalizedShop || !Number.isInteger(normalizedId) || normalizedId <= 0) {
      return { item: null, reason: 'not_found' };
    }

    const existingRow = db.prepare(`
      SELECT *
      FROM print_queue_items
      WHERE shop = ?
        AND id = ?
        AND removedAt IS NULL
      LIMIT 1
    `).get(normalizedShop, normalizedId);
    const existingItem = buildPrintQueueItemRecord(existingRow);
    if (!existingItem) {
      return { item: null, reason: 'not_found' };
    }

    if (existingItem.stageKey !== 'complete') {
      return { item: existingItem, reason: 'not_complete' };
    }

    if (existingItem.putAwayAt) {
      return { item: existingItem, reason: null };
    }

    const nowIso = putAwayAt || new Date().toISOString();
    db.prepare(`
      UPDATE print_queue_items
      SET putAwayAt = ?,
          updatedAt = ?
      WHERE shop = ?
        AND id = ?
        AND removedAt IS NULL
    `).run(nowIso, nowIso, normalizedShop, normalizedId);

    const updatedRow = db.prepare(`
      SELECT *
      FROM print_queue_items
      WHERE shop = ?
        AND id = ?
        AND removedAt IS NULL
      LIMIT 1
    `).get(normalizedShop, normalizedId);

    return {
      item: buildPrintQueueItemRecord(updatedRow),
      reason: null,
    };
  },

  removePrintQueueItem({ shop, id, removedBy = null, removedAt = null } = {}) {
    const normalizedShop = String(shop || '').trim();
    const normalizedId = Number(id);
    if (!normalizedShop || !Number.isInteger(normalizedId) || normalizedId <= 0) {
      return { item: null, reason: 'not_found' };
    }

    const existingRow = db.prepare(`
      SELECT *
      FROM print_queue_items
      WHERE shop = ?
        AND id = ?
        AND removedAt IS NULL
      LIMIT 1
    `).get(normalizedShop, normalizedId);
    const existingItem = buildPrintQueueItemRecord(existingRow);
    if (!existingItem) {
      return { item: null, reason: 'not_found' };
    }

    const nowIso = removedAt || new Date().toISOString();
    const safeRemovedBy = removedBy ? String(removedBy).trim() : null;
    db.prepare(`
      UPDATE print_queue_items
      SET removedAt = ?,
          removedBy = ?,
          updatedAt = ?
      WHERE shop = ?
        AND id = ?
        AND removedAt IS NULL
    `).run(nowIso, safeRemovedBy, nowIso, normalizedShop, normalizedId);

    const updatedRow = db.prepare(`
      SELECT *
      FROM print_queue_items
      WHERE shop = ?
        AND id = ?
      LIMIT 1
    `).get(normalizedShop, normalizedId);

    return {
      item: buildPrintQueueItemRecord(updatedRow),
      reason: null,
    };
  },

  getAwaitingPartsSummary({ shop, typeGroup } = {}) {
    if (!shop) {
      return { filters: [], items: [] };
    }

    const params = [String(shop)];
    let typeClause = '';
    const normalizedTypeGroup = String(typeGroup || '').trim().toUpperCase();
    if (normalizedTypeGroup) {
      typeClause = ' AND api.partTypeGroup = ?';
      params.push(normalizedTypeGroup);
    }

    const filters = db.prepare(`
      SELECT
        api.partTypeGroup AS typeGroup,
        COUNT(*) AS openEntryCount,
        COUNT(DISTINCT api.partSku) AS distinctSkuCount,
        COUNT(DISTINCT api.orderId) AS openOrderCount
      FROM awaiting_parts_items api
      INNER JOIN order_trackers ot
        ON ot.shop = api.shop
       AND ot.orderId = api.orderId
      WHERE api.shop = ?
        AND api.resolvedAt IS NULL
        AND ot.currentStageKey = 'awaiting_parts'
        AND COALESCE(UPPER(ot.workflowStatus), '') != 'CANCELLED'
      GROUP BY api.partTypeGroup
      ORDER BY api.partTypeGroup ASC
    `).all(String(shop)).map((row) => ({
      typeGroup: String(row.typeGroup || 'UNKNOWN').trim() || 'UNKNOWN',
      openEntryCount: Number(row.openEntryCount || 0),
      distinctSkuCount: Number(row.distinctSkuCount || 0),
      openOrderCount: Number(row.openOrderCount || 0),
    }));

    const summaryRows = db.prepare(`
      SELECT
        api.partSku AS partSku,
        api.partTypeRaw AS partTypeRaw,
        api.partTypeGroup AS partTypeGroup,
        SUM(api.quantity) AS totalQuantity,
        COUNT(DISTINCT api.orderId) AS openOrderCount,
        MIN(api.createdAt) AS oldestOpenAt,
        MAX(api.updatedAt) AS latestReportedAt
      FROM awaiting_parts_items api
      INNER JOIN order_trackers ot
        ON ot.shop = api.shop
       AND ot.orderId = api.orderId
      WHERE api.shop = ?
        AND api.resolvedAt IS NULL
        AND ot.currentStageKey = 'awaiting_parts'
        AND COALESCE(UPPER(ot.workflowStatus), '') != 'CANCELLED'${typeClause}
      GROUP BY api.partSku, api.partTypeRaw, api.partTypeGroup
    `).all(...params);

    const orderDetailStmt = db.prepare(`
      SELECT
        api.orderId AS orderId,
        api.orderNumber AS orderNumber,
        api.quantity AS quantity,
        api.reportedBy AS reportedBy,
        api.createdAt AS createdAt,
        api.updatedAt AS updatedAt
      FROM awaiting_parts_items api
      INNER JOIN order_trackers ot
        ON ot.shop = api.shop
       AND ot.orderId = api.orderId
      WHERE api.shop = ?
        AND api.resolvedAt IS NULL
        AND api.partSku = ?
        AND api.partTypeGroup = ?
        AND ot.currentStageKey = 'awaiting_parts'
        AND COALESCE(UPPER(ot.workflowStatus), '') != 'CANCELLED'
      ORDER BY api.createdAt ASC, api.orderNumber ASC
    `);

    const items = summaryRows.map((row) => {
      const orders = orderDetailStmt.all(
        String(shop),
        String(row.partSku || '').trim().toUpperCase(),
        String(row.partTypeGroup || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN'
      ).map((orderRow) => ({
        orderId: String(orderRow.orderId || '').trim(),
        orderNumber: String(orderRow.orderNumber || '').trim(),
        quantity: Number(orderRow.quantity || 0),
        reportedBy: String(orderRow.reportedBy || '').trim(),
        createdAt: orderRow.createdAt || null,
        updatedAt: orderRow.updatedAt || null,
      }));

      return {
        partSku: String(row.partSku || '').trim().toUpperCase(),
        partTypeRaw: String(row.partTypeRaw || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN',
        partTypeGroup: String(row.partTypeGroup || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN',
        totalQuantity: Number(row.totalQuantity || 0),
        openOrderCount: Number(row.openOrderCount || 0),
        oldestOpenAt: row.oldestOpenAt || null,
        latestReportedAt: row.latestReportedAt || null,
        orders,
      };
    }).sort((a, b) => {
      const orderDiff = b.openOrderCount - a.openOrderCount;
      if (orderDiff !== 0) return orderDiff;

      const qtyDiff = b.totalQuantity - a.totalQuantity;
      if (qtyDiff !== 0) return qtyDiff;

      const aOldest = a.oldestOpenAt || '';
      const bOldest = b.oldestOpenAt || '';
      const oldestDiff = aOldest.localeCompare(bOldest);
      if (oldestDiff !== 0) return oldestDiff;

      return a.partSku.localeCompare(b.partSku);
    }).map((item, index) => ({
      ...item,
      priorityRank: index + 1,
    }));

    return {
      filters,
      items,
    };
  },

  getOrderTrackerByToken(publicToken) {
    const token = String(publicToken || '').trim();
    if (!token) return null;

    const tracker = db.prepare(`
      SELECT *
      FROM order_trackers
      WHERE publicToken = ?
      LIMIT 1
    `).get(token);

    return buildOrderTrackerRecord(tracker);
  },

  getOrderTrackerByOrderId(orderId) {
    const normalizedOrderId = String(orderId || '').trim();
    if (!normalizedOrderId) return null;

    const tracker = db.prepare(`
      SELECT *
      FROM order_trackers
      WHERE orderId = ?
      LIMIT 1
    `).get(normalizedOrderId);

    return buildOrderTrackerRecord(tracker);
  },

  getLatestOrderTrackerStaffByStage({ shop, orderId, stageKey }) {
    const normalizedShop = String(shop || '').trim();
    const normalizedOrderId = String(orderId || '').trim();
    const normalizedStageKey = String(stageKey || '').trim();
    if (!normalizedShop || !normalizedOrderId || !normalizedStageKey) return null;

    const row = db.prepare(`
      SELECT staff
      FROM order_tracker_events
      WHERE shop = ?
        AND orderId = ?
        AND stageKey = ?
        AND staff IS NOT NULL
        AND TRIM(staff) != ''
      ORDER BY createdAt DESC, id DESC
      LIMIT 1
    `).get(normalizedShop, normalizedOrderId, normalizedStageKey);

    return row?.staff || null;
  },
};
