// sessionsStore.js (better-sqlite3 version)
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dbPath = path.resolve(__dirname, './db/sessions.db');

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
    createdAt TEXT NOT NULL
  )
`).run();

db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_order_tracker_events_shop_order_createdAt
  ON order_tracker_events (shop, orderId, createdAt ASC, id ASC)
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
    const safeLegacyEvents = Array.isArray(legacyEvents)
      ? legacyEvents
          .map((event) => ({
            stageKey: String(event?.stageKey || '').trim(),
            stageLabel: String(event?.stageLabel || '').trim(),
            stageDescription: String(event?.stageDescription || '').trim(),
            sourceTag: String(event?.sourceTag || '').trim() || null,
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
        shop, orderId, stageKey, stageLabel, stageDescription, sourceTag, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
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

  getOrderTrackerByToken(publicToken) {
    const token = String(publicToken || '').trim();
    if (!token) return null;

    const tracker = db.prepare(`
      SELECT *
      FROM order_trackers
      WHERE publicToken = ?
      LIMIT 1
    `).get(token);

    if (!tracker) return null;

    const events = db.prepare(`
      SELECT stageKey, stageLabel, stageDescription, sourceTag, createdAt
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
  },
};
