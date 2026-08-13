const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function resolveMaintenanceDbPath() {
  const configuredPath = String(process.env.SESSION_DB || '').trim();
  if (!configuredPath) return path.resolve(__dirname, './db/sessions.db');
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(__dirname, configuredPath);
}

const dbPath = resolveMaintenanceDbPath();
if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const db = new Database(dbPath);

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeInt(value, fallback = 0) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeBool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function stringifyJson(value, fallback = []) {
  return JSON.stringify(value === undefined ? fallback : value);
}

function runSchema(sql) {
  db.prepare(sql).run();
}

const CREATE_SCHEDULED_INSTANCES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS maintenance_scheduled_instances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    templateId INTEGER NOT NULL,
    assetId INTEGER NOT NULL,
    frequencyId INTEGER NOT NULL,
    dueDate TEXT NOT NULL,
    sourceType TEXT NOT NULL DEFAULT 'preventive',
    status TEXT NOT NULL DEFAULT 'scheduled',
    taskTitleSnapshot TEXT NOT NULL,
    equipmentNameSnapshot TEXT NOT NULL,
    assignedToSnapshot TEXT,
    frequencyKeySnapshot TEXT,
    frequencyLabelSnapshot TEXT,
    frequencyColorSnapshot TEXT,
    instructionsSnapshot TEXT,
    checklistSnapshotJson TEXT NOT NULL DEFAULT '[]',
    documentsSnapshotJson TEXT NOT NULL DEFAULT '[]',
    estimatedMinutesSnapshot INTEGER,
    completionNotesRequired INTEGER NOT NULL DEFAULT 0,
    evidenceRequired INTEGER NOT NULL DEFAULT 0,
    generatedAt TEXT NOT NULL,
    startedAt TEXT,
    completedAt TEXT,
    skippedAt TEXT,
    skippedBy TEXT,
    skipReason TEXT,
    completionRecordId INTEGER,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    UNIQUE (shop, templateId, assetId, dueDate)
  )
`;

runSchema(`
  CREATE TABLE IF NOT EXISTS maintenance_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    name TEXT NOT NULL,
    equipmentType TEXT,
    uniqueIdentifier TEXT,
    manufacturer TEXT,
    model TEXT,
    serialNumber TEXT,
    location TEXT,
    description TEXT,
    photoUrl TEXT,
    availabilityStatus TEXT NOT NULL DEFAULT 'available',
    availabilityFaultId INTEGER,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    archivedAt TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);

runSchema(`
  CREATE INDEX IF NOT EXISTS idx_maintenance_assets_shop_active
  ON maintenance_assets (shop, archivedAt, active, equipmentType, name)
`);

runSchema(`
  CREATE TABLE IF NOT EXISTS maintenance_frequencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    scheduleType TEXT NOT NULL,
    intervalValue INTEGER,
    color TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    sortOrder INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    UNIQUE (shop, key)
  )
`);

runSchema(`
  CREATE TABLE IF NOT EXISTS maintenance_task_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    assetId INTEGER NOT NULL DEFAULT 0,
    targetScope TEXT NOT NULL DEFAULT 'asset',
    targetEquipmentType TEXT,
    title TEXT NOT NULL,
    assignedTo TEXT,
    frequencyId INTEGER NOT NULL,
    scheduleDaysOfWeekJson TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
    scheduleDayOfWeek INTEGER NOT NULL DEFAULT 1,
    scheduleDayOfMonth INTEGER NOT NULL DEFAULT 1,
    instructions TEXT,
    checklistJson TEXT NOT NULL DEFAULT '[]',
    documentsJson TEXT NOT NULL DEFAULT '[]',
    estimatedMinutes INTEGER,
    completionNotesRequired INTEGER NOT NULL DEFAULT 0,
    evidenceRequired INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    archivedAt TEXT,
    createdBy TEXT,
    updatedBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);

runSchema(`
  CREATE INDEX IF NOT EXISTS idx_maintenance_templates_shop_asset
  ON maintenance_task_templates (shop, assetId, archivedAt, active, frequencyId)
`);

runSchema(CREATE_SCHEDULED_INSTANCES_TABLE_SQL);

runSchema(`
  CREATE INDEX IF NOT EXISTS idx_maintenance_instances_shop_due
  ON maintenance_scheduled_instances (shop, dueDate, status, assetId)
`);

runSchema(`
  CREATE TABLE IF NOT EXISTS maintenance_completion_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    scheduledInstanceId INTEGER NOT NULL,
    templateId INTEGER NOT NULL,
    assetId INTEGER NOT NULL,
    dueDate TEXT NOT NULL,
    completedBy TEXT,
    startedAt TEXT,
    completedAt TEXT NOT NULL,
    timeliness TEXT NOT NULL,
    equipmentNameSnapshot TEXT,
    taskTitleSnapshot TEXT,
    frequencyLabelSnapshot TEXT,
    instructionsSnapshot TEXT,
    checklistResponsesJson TEXT NOT NULL DEFAULT '[]',
    documentsSnapshotJson TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    problemsFound TEXT,
    correctiveActionTaken TEXT,
    evidenceJson TEXT NOT NULL DEFAULT '[]',
    faultsJson TEXT NOT NULL DEFAULT '[]',
    createdAt TEXT NOT NULL,
    UNIQUE (shop, scheduledInstanceId)
  )
`);

runSchema(`
  CREATE INDEX IF NOT EXISTS idx_maintenance_completion_shop_due
  ON maintenance_completion_records (shop, dueDate, assetId, completedAt)
`);

runSchema(`
  CREATE TABLE IF NOT EXISTS maintenance_faults (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    faultRef TEXT NOT NULL UNIQUE,
    assetId INTEGER,
    scheduledInstanceId INTEGER,
    completionRecordId INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    equipmentImpact TEXT NOT NULL DEFAULT 'none',
    reportedBy TEXT,
    assignedTo TEXT,
    targetResolutionDate TEXT,
    correctiveAction TEXT,
    resolutionNotes TEXT,
    resolvedAt TEXT,
    resolvedBy TEXT,
    attachmentsJson TEXT NOT NULL DEFAULT '[]',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);

runSchema(`
  CREATE INDEX IF NOT EXISTS idx_maintenance_faults_shop_status
  ON maintenance_faults (shop, status, severity, assetId, createdAt DESC)
`);

runSchema(`
  CREATE TABLE IF NOT EXISTS maintenance_fault_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    faultId INTEGER NOT NULL,
    action TEXT NOT NULL,
    user TEXT,
    beforeJson TEXT,
    afterJson TEXT,
    notes TEXT,
    createdAt TEXT NOT NULL
  )
`);

runSchema(`
  CREATE INDEX IF NOT EXISTS idx_maintenance_fault_events_fault
  ON maintenance_fault_events (shop, faultId, createdAt ASC, id ASC)
`);

runSchema(`
  CREATE TABLE IF NOT EXISTS maintenance_corrective_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    faultId INTEGER,
    assetId INTEGER,
    title TEXT NOT NULL,
    instructions TEXT,
    checklistJson TEXT NOT NULL DEFAULT '[]',
    documentsJson TEXT NOT NULL DEFAULT '[]',
    priority TEXT,
    assignedTo TEXT,
    targetDate TEXT,
    evidenceRequired INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    completedBy TEXT,
    completedAt TEXT,
    completionNotes TEXT,
    partsReplaced TEXT,
    evidenceJson TEXT NOT NULL DEFAULT '[]',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);

runSchema(`
  CREATE INDEX IF NOT EXISTS idx_maintenance_corrective_shop_status
  ON maintenance_corrective_tasks (shop, status, assetId, targetDate)
`);

runSchema(`
  CREATE TABLE IF NOT EXISTS maintenance_equipment_status_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    assetId INTEGER NOT NULL,
    previousStatus TEXT,
    newStatus TEXT NOT NULL,
    user TEXT,
    faultId INTEGER,
    notes TEXT,
    createdAt TEXT NOT NULL
  )
`);

runSchema(`
  CREATE INDEX IF NOT EXISTS idx_maintenance_status_events_asset
  ON maintenance_equipment_status_events (shop, assetId, createdAt DESC)
`);

runSchema(`
  CREATE TABLE IF NOT EXISTS maintenance_notification_settings (
    shop TEXT PRIMARY KEY,
    googleChatEnabled INTEGER NOT NULL DEFAULT 0,
    googleChatWebhookUrl TEXT,
    googleChatDestinationName TEXT,
    dailyCompletionEnabled INTEGER NOT NULL DEFAULT 1,
    updatedBy TEXT,
    updatedAt TEXT NOT NULL
  )
`);

runSchema(`
  CREATE TABLE IF NOT EXISTS maintenance_notification_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    eventType TEXT NOT NULL,
    assetId INTEGER,
    eventDate TEXT,
    cycle INTEGER NOT NULL DEFAULT 1,
    payloadJson TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    UNIQUE (shop, eventType, assetId, eventDate, cycle)
  )
`);

runSchema(`
  CREATE TABLE IF NOT EXISTS maintenance_notification_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    eventId INTEGER NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    httpStatus INTEGER,
    responseBody TEXT,
    errorMessage TEXT,
    retryCount INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  )
`);

function getTableColumns(tableName) {
  return new Set(
    db.prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .map((column) => column.name)
  );
}

function addColumnIfMissing(tableName, columnName, sql) {
  if (getTableColumns(tableName).has(columnName)) return;
  runSchema(sql);
}

function scheduledInstanceUniqueKeyIncludesAsset() {
  const sql = normalizeText(db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'maintenance_scheduled_instances'
    LIMIT 1
  `).get()?.sql);
  return /UNIQUE\s*\(\s*shop\s*,\s*templateId\s*,\s*assetId\s*,\s*dueDate\s*\)/i.test(sql);
}

function migrateScheduledInstanceUniqueKey() {
  if (scheduledInstanceUniqueKeyIncludesAsset()) return;

  const tx = db.transaction(() => {
    runSchema('ALTER TABLE maintenance_scheduled_instances RENAME TO maintenance_scheduled_instances_old_unique_key');
    const oldColumns = getTableColumns('maintenance_scheduled_instances_old_unique_key');
    const optionalColumn = (columnName) => oldColumns.has(columnName) ? columnName : `NULL AS ${columnName}`;
    runSchema(CREATE_SCHEDULED_INSTANCES_TABLE_SQL);
    db.prepare(`
      INSERT OR IGNORE INTO maintenance_scheduled_instances (
        id, shop, templateId, assetId, frequencyId, dueDate, sourceType, status,
        taskTitleSnapshot, equipmentNameSnapshot, assignedToSnapshot, frequencyKeySnapshot, frequencyLabelSnapshot,
        frequencyColorSnapshot, instructionsSnapshot, checklistSnapshotJson, documentsSnapshotJson,
        estimatedMinutesSnapshot, completionNotesRequired, evidenceRequired, generatedAt,
        startedAt, completedAt, skippedAt, skippedBy, skipReason, completionRecordId, createdAt, updatedAt
      )
      SELECT
        id, shop, templateId, assetId, frequencyId, dueDate, sourceType, status,
        taskTitleSnapshot, equipmentNameSnapshot, ${optionalColumn('assignedToSnapshot')}, frequencyKeySnapshot, frequencyLabelSnapshot,
        frequencyColorSnapshot, instructionsSnapshot, checklistSnapshotJson, documentsSnapshotJson,
        estimatedMinutesSnapshot, completionNotesRequired, evidenceRequired, generatedAt,
        startedAt, completedAt, ${optionalColumn('skippedAt')}, ${optionalColumn('skippedBy')}, ${optionalColumn('skipReason')},
        completionRecordId, createdAt, updatedAt
      FROM maintenance_scheduled_instances_old_unique_key
      ORDER BY id ASC
    `).run();
    runSchema('DROP TABLE maintenance_scheduled_instances_old_unique_key');
    runSchema(`
      CREATE INDEX IF NOT EXISTS idx_maintenance_instances_shop_due
      ON maintenance_scheduled_instances (shop, dueDate, status, assetId)
    `);
  });

  tx();
}

function runMaintenanceSchemaMigrations() {
  addColumnIfMissing(
    'maintenance_task_templates',
    'targetScope',
    "ALTER TABLE maintenance_task_templates ADD COLUMN targetScope TEXT NOT NULL DEFAULT 'asset'"
  );
  addColumnIfMissing(
    'maintenance_task_templates',
    'targetEquipmentType',
    'ALTER TABLE maintenance_task_templates ADD COLUMN targetEquipmentType TEXT'
  );
  addColumnIfMissing(
    'maintenance_task_templates',
    'assignedTo',
    'ALTER TABLE maintenance_task_templates ADD COLUMN assignedTo TEXT'
  );
  addColumnIfMissing(
    'maintenance_task_templates',
    'scheduleDaysOfWeekJson',
    "ALTER TABLE maintenance_task_templates ADD COLUMN scheduleDaysOfWeekJson TEXT NOT NULL DEFAULT '[1,2,3,4,5]'"
  );
  addColumnIfMissing(
    'maintenance_task_templates',
    'scheduleDayOfWeek',
    'ALTER TABLE maintenance_task_templates ADD COLUMN scheduleDayOfWeek INTEGER NOT NULL DEFAULT 1'
  );
  addColumnIfMissing(
    'maintenance_task_templates',
    'scheduleDayOfMonth',
    'ALTER TABLE maintenance_task_templates ADD COLUMN scheduleDayOfMonth INTEGER NOT NULL DEFAULT 1'
  );
  runSchema(`
    CREATE INDEX IF NOT EXISTS idx_maintenance_templates_shop_target
    ON maintenance_task_templates (shop, targetScope, targetEquipmentType, archivedAt, active, frequencyId)
  `);
  db.prepare(`
    UPDATE maintenance_task_templates
    SET scheduleDayOfWeek = 1
    WHERE scheduleDayOfWeek IS NULL
      OR scheduleDayOfWeek < 0
      OR scheduleDayOfWeek > 6
  `).run();
  db.prepare(`
    UPDATE maintenance_task_templates
    SET scheduleDayOfMonth = 1
    WHERE scheduleDayOfMonth IS NULL
      OR scheduleDayOfMonth < 1
      OR scheduleDayOfMonth > 31
  `).run();
  db.prepare(`
    UPDATE maintenance_task_templates
    SET targetEquipmentType = (
      SELECT a.equipmentType
      FROM maintenance_assets a
      WHERE a.shop = maintenance_task_templates.shop
        AND a.id = maintenance_task_templates.assetId
      LIMIT 1
    )
    WHERE assetId > 0
      AND (targetEquipmentType IS NULL OR TRIM(targetEquipmentType) = '')
  `).run();
  migrateScheduledInstanceUniqueKey();
  addColumnIfMissing(
    'maintenance_scheduled_instances',
    'skippedAt',
    'ALTER TABLE maintenance_scheduled_instances ADD COLUMN skippedAt TEXT'
  );
  addColumnIfMissing(
    'maintenance_scheduled_instances',
    'skippedBy',
    'ALTER TABLE maintenance_scheduled_instances ADD COLUMN skippedBy TEXT'
  );
  addColumnIfMissing(
    'maintenance_scheduled_instances',
    'skipReason',
    'ALTER TABLE maintenance_scheduled_instances ADD COLUMN skipReason TEXT'
  );
  addColumnIfMissing(
    'maintenance_scheduled_instances',
    'assignedToSnapshot',
    'ALTER TABLE maintenance_scheduled_instances ADD COLUMN assignedToSnapshot TEXT'
  );
}

runMaintenanceSchemaMigrations();

function normalizeAvailabilityStatus(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/[\s_]+/g, '_');
  if (normalized === 'restricted_use' || normalized === 'restricted') return 'restricted_use';
  if (normalized === 'out_of_service' || normalized === 'out') return 'out_of_service';
  return 'available';
}

function normalizeTemplateScope(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/[\s-]+/g, '_');
  return normalized === 'asset' ? 'asset' : 'equipment_type';
}

function normalizeWeekday(value, fallback = 1) {
  if (value === null || value === undefined || value === '') return fallback;
  const raw = String(value).trim();
  if (!raw) return fallback;
  const parsed = Math.floor(Number(raw));
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 6 ? parsed : fallback;
}

function normalizeMonthDay(value, fallback = 1) {
  if (value === null || value === undefined || value === '') return fallback;
  const raw = String(value).trim();
  if (!raw) return fallback;
  const parsed = Math.floor(Number(raw));
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(31, Math.max(1, parsed));
}

function normalizeWeekdays(value, fallback = [1, 2, 3, 4, 5]) {
  let rawItems = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (trimmed.startsWith('[')) {
      rawItems = safeJsonParse(trimmed, []);
    } else {
      rawItems = trimmed.split(',');
    }
  }

  const dayOrder = [1, 2, 3, 4, 5, 6, 0];
  const selected = new Set(
    (Array.isArray(rawItems) ? rawItems : [])
      .map((item) => Math.floor(Number(item)))
      .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6)
  );
  const normalized = dayOrder.filter((day) => selected.has(day));
  return normalized.length ? normalized : fallback;
}

function normalizeFaultSeverity(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (['low', 'medium', 'high', 'critical'].includes(normalized)) return normalized;
  return 'medium';
}

function normalizeFaultStatus(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/[\s_]+/g, '_');
  const allowed = new Set([
    'reported',
    'acknowledged',
    'investigating',
    'awaiting_parts',
    'corrective_maintenance_required',
    'in_progress',
    'resolved',
    'closed',
  ]);
  return allowed.has(normalized) ? normalized : 'reported';
}

function normalizeCorrectiveStatus(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/[\s_]+/g, '_');
  if (['open', 'in_progress', 'completed', 'cancelled'].includes(normalized)) return normalized;
  return 'open';
}

function normalizeAsset(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    shop: normalizeText(row.shop),
    name: normalizeText(row.name),
    equipmentType: normalizeText(row.equipmentType),
    uniqueIdentifier: normalizeText(row.uniqueIdentifier),
    manufacturer: normalizeText(row.manufacturer),
    model: normalizeText(row.model),
    serialNumber: normalizeText(row.serialNumber),
    location: normalizeText(row.location),
    description: normalizeText(row.description),
    photoUrl: normalizeText(row.photoUrl),
    availabilityStatus: normalizeAvailabilityStatus(row.availabilityStatus),
    availabilityFaultId: row.availabilityFaultId ? Number(row.availabilityFaultId) : null,
    notes: normalizeText(row.notes),
    active: Boolean(row.active),
    archivedAt: row.archivedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function normalizeFrequency(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    shop: normalizeText(row.shop),
    key: normalizeText(row.key),
    label: normalizeText(row.label),
    scheduleType: normalizeText(row.scheduleType),
    intervalValue: row.intervalValue ? Number(row.intervalValue) : null,
    color: normalizeText(row.color) || '#6ba6ff',
    active: Boolean(row.active),
    sortOrder: Number(row.sortOrder || 0),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function normalizeTemplate(row) {
  if (!row) return null;
  const targetEquipmentType = normalizeText(row.targetEquipmentType) || normalizeText(row.equipmentType);
  const targetScope = normalizeTemplateScope(row.targetScope || (targetEquipmentType ? 'equipment_type' : 'asset'));
  return {
    id: Number(row.id),
    shop: normalizeText(row.shop),
    assetId: row.assetId ? Number(row.assetId) : null,
    targetScope,
    targetEquipmentType,
    targetAssetCount: Number(row.targetAssetCount || 0),
    title: normalizeText(row.title),
    assignedTo: normalizeText(row.assignedTo),
    frequencyId: Number(row.frequencyId),
    scheduleDaysOfWeek: normalizeWeekdays(row.scheduleDaysOfWeekJson, [1, 2, 3, 4, 5]),
    scheduleDayOfWeek: normalizeWeekday(row.scheduleDayOfWeek, 1),
    scheduleDayOfMonth: normalizeMonthDay(row.scheduleDayOfMonth, 1),
    instructions: normalizeText(row.instructions),
    checklist: safeJsonParse(row.checklistJson || '[]', []),
    documents: safeJsonParse(row.documentsJson || '[]', []),
    estimatedMinutes: row.estimatedMinutes ? Number(row.estimatedMinutes) : null,
    completionNotesRequired: Boolean(row.completionNotesRequired),
    evidenceRequired: Boolean(row.evidenceRequired),
    active: Boolean(row.active),
    archivedAt: row.archivedAt || null,
    createdBy: normalizeText(row.createdBy),
    updatedBy: normalizeText(row.updatedBy),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    assetName: normalizeText(row.assetName),
    equipmentType: normalizeText(row.equipmentType),
    frequencyKey: normalizeText(row.frequencyKey),
    frequencyLabel: normalizeText(row.frequencyLabel),
    frequencyColor: normalizeText(row.frequencyColor),
    frequencyScheduleType: normalizeText(row.frequencyScheduleType || row.scheduleType),
  };
}

function normalizeScheduledInstance(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    shop: normalizeText(row.shop),
    templateId: Number(row.templateId),
    assetId: Number(row.assetId),
    frequencyId: Number(row.frequencyId),
    dueDate: normalizeText(row.dueDate),
    sourceType: normalizeText(row.sourceType) || 'preventive',
    status: normalizeText(row.status) || 'scheduled',
    taskTitle: normalizeText(row.taskTitleSnapshot),
    equipmentName: normalizeText(row.equipmentNameSnapshot),
    assignedTo: normalizeText(row.assignedToSnapshot || row.resolvedAssignedTo),
    equipmentType: normalizeText(row.equipmentType),
    assetAvailabilityStatus: normalizeAvailabilityStatus(row.assetAvailabilityStatus),
    frequencyKey: normalizeText(row.frequencyKeySnapshot),
    frequencyLabel: normalizeText(row.frequencyLabelSnapshot),
    frequencyColor: normalizeText(row.frequencyColorSnapshot),
    instructions: normalizeText(row.instructionsSnapshot),
    checklist: safeJsonParse(row.checklistSnapshotJson || '[]', []),
    documents: safeJsonParse(row.documentsSnapshotJson || '[]', []),
    estimatedMinutes: row.estimatedMinutesSnapshot ? Number(row.estimatedMinutesSnapshot) : null,
    completionNotesRequired: Boolean(row.completionNotesRequired),
    evidenceRequired: Boolean(row.evidenceRequired),
    generatedAt: row.generatedAt || null,
    startedAt: row.startedAt || null,
    completedAt: row.completedAt || null,
    skippedAt: row.skippedAt || null,
    skippedBy: normalizeText(row.skippedBy),
    skipReason: normalizeText(row.skipReason),
    completionRecordId: row.completionRecordId ? Number(row.completionRecordId) : null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function normalizeCompletion(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    shop: normalizeText(row.shop),
    scheduledInstanceId: Number(row.scheduledInstanceId),
    templateId: Number(row.templateId),
    assetId: Number(row.assetId),
    dueDate: normalizeText(row.dueDate),
    completedBy: normalizeText(row.completedBy),
    startedAt: row.startedAt || null,
    completedAt: row.completedAt || null,
    timeliness: normalizeText(row.timeliness),
    equipmentName: normalizeText(row.equipmentNameSnapshot),
    taskTitle: normalizeText(row.taskTitleSnapshot),
    frequencyLabel: normalizeText(row.frequencyLabelSnapshot),
    instructions: normalizeText(row.instructionsSnapshot),
    checklistResponses: safeJsonParse(row.checklistResponsesJson || '[]', []),
    documents: safeJsonParse(row.documentsSnapshotJson || '[]', []),
    notes: normalizeText(row.notes),
    problemsFound: normalizeText(row.problemsFound),
    correctiveActionTaken: normalizeText(row.correctiveActionTaken),
    evidence: safeJsonParse(row.evidenceJson || '[]', []),
    faults: safeJsonParse(row.faultsJson || '[]', []),
    createdAt: row.createdAt || null,
  };
}

function normalizeFault(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    shop: normalizeText(row.shop),
    faultRef: normalizeText(row.faultRef),
    assetId: row.assetId ? Number(row.assetId) : null,
    scheduledInstanceId: row.scheduledInstanceId ? Number(row.scheduledInstanceId) : null,
    completionRecordId: row.completionRecordId ? Number(row.completionRecordId) : null,
    title: normalizeText(row.title),
    description: normalizeText(row.description),
    severity: normalizeFaultSeverity(row.severity),
    status: normalizeFaultStatus(row.status),
    equipmentImpact: normalizeText(row.equipmentImpact) || 'none',
    reportedBy: normalizeText(row.reportedBy),
    assignedTo: normalizeText(row.assignedTo),
    targetResolutionDate: row.targetResolutionDate || null,
    correctiveAction: normalizeText(row.correctiveAction),
    resolutionNotes: normalizeText(row.resolutionNotes),
    resolvedAt: row.resolvedAt || null,
    resolvedBy: normalizeText(row.resolvedBy),
    attachments: safeJsonParse(row.attachmentsJson || '[]', []),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    assetName: normalizeText(row.assetName),
    equipmentType: normalizeText(row.equipmentType),
  };
}

function normalizeFaultEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    shop: normalizeText(row.shop),
    faultId: Number(row.faultId),
    action: normalizeText(row.action),
    user: normalizeText(row.user),
    before: safeJsonParse(row.beforeJson || '{}', {}),
    after: safeJsonParse(row.afterJson || '{}', {}),
    notes: normalizeText(row.notes),
    createdAt: row.createdAt || null,
  };
}

function normalizeCorrectiveTask(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    shop: normalizeText(row.shop),
    faultId: row.faultId ? Number(row.faultId) : null,
    assetId: row.assetId ? Number(row.assetId) : null,
    title: normalizeText(row.title),
    instructions: normalizeText(row.instructions),
    checklist: safeJsonParse(row.checklistJson || '[]', []),
    documents: safeJsonParse(row.documentsJson || '[]', []),
    priority: normalizeText(row.priority),
    assignedTo: normalizeText(row.assignedTo),
    targetDate: row.targetDate || null,
    evidenceRequired: Boolean(row.evidenceRequired),
    notes: normalizeText(row.notes),
    status: normalizeCorrectiveStatus(row.status),
    completedBy: normalizeText(row.completedBy),
    completedAt: row.completedAt || null,
    completionNotes: normalizeText(row.completionNotes),
    partsReplaced: normalizeText(row.partsReplaced),
    evidence: safeJsonParse(row.evidenceJson || '[]', []),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    assetName: normalizeText(row.assetName),
    faultRef: normalizeText(row.faultRef),
  };
}

function normalizeNotificationSettings(row) {
  return {
    googleChatEnabled: Boolean(row?.googleChatEnabled),
    googleChatDestinationName: normalizeText(row?.googleChatDestinationName),
    dailyCompletionEnabled: row ? Boolean(row.dailyCompletionEnabled) : true,
    hasGoogleChatWebhook: Boolean(normalizeText(row?.googleChatWebhookUrl)),
    updatedBy: normalizeText(row?.updatedBy),
    updatedAt: row?.updatedAt || null,
  };
}

function normalizeNotificationEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    shop: normalizeText(row.shop),
    eventType: normalizeText(row.eventType),
    assetId: row.assetId ? Number(row.assetId) : null,
    eventDate: row.eventDate || null,
    cycle: Number(row.cycle || 1),
    payload: safeJsonParse(row.payloadJson || '{}', {}),
    status: normalizeText(row.status),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function normalizeChecklistItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const text = normalizeText(item?.text || item?.label || item);
      if (!text) return null;
      return {
        id: normalizeText(item?.id) || `item_${index + 1}`,
        text,
        mandatory: item?.mandatory === false ? false : true,
        sortOrder: Number.isFinite(Number(item?.sortOrder)) ? Number(item.sortOrder) : index,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

function normalizeDocuments(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const url = normalizeText(item?.url || item?.href);
      const label = normalizeText(item?.label || item?.name || url);
      if (!url && !label) return null;
      return {
        id: normalizeText(item?.id) || `doc_${index + 1}`,
        label,
        originalName: normalizeText(item?.originalName),
        url,
        type: normalizeText(item?.type || 'link').toLowerCase(),
        mimeType: normalizeText(item?.mimeType),
        size: Number.isFinite(Number(item?.size)) ? Number(item.size) : 0,
        uploadedBy: normalizeText(item?.uploadedBy),
        uploadedAt: normalizeText(item?.uploadedAt),
        sortOrder: Number.isFinite(Number(item?.sortOrder)) ? Number(item.sortOrder) : index,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

function normalizeEvidence(items = []) {
  return normalizeDocuments(items);
}

function getAssetRow(shop, id) {
  return db.prepare(`
    SELECT *
    FROM maintenance_assets
    WHERE shop = ? AND id = ?
    LIMIT 1
  `).get(shop, Number(id));
}

function getFrequencyRow(shop, id) {
  return db.prepare(`
    SELECT *
    FROM maintenance_frequencies
    WHERE shop = ? AND id = ?
    LIMIT 1
  `).get(shop, Number(id));
}

function getTemplateRow(shop, id) {
  return db.prepare(`
    SELECT t.*,
           a.name AS assetName,
           COALESCE(NULLIF(t.targetEquipmentType, ''), a.equipmentType, '') AS equipmentType,
           (
             SELECT COUNT(*)
             FROM maintenance_assets targetAsset
             WHERE targetAsset.shop = t.shop
               AND targetAsset.archivedAt IS NULL
               AND targetAsset.active = 1
               AND targetAsset.equipmentType = COALESCE(NULLIF(t.targetEquipmentType, ''), a.equipmentType, '')
           ) AS targetAssetCount,
           f.key AS frequencyKey, f.label AS frequencyLabel, f.color AS frequencyColor, f.scheduleType AS frequencyScheduleType
    FROM maintenance_task_templates t
    LEFT JOIN maintenance_assets a ON a.shop = t.shop AND a.id = t.assetId
    JOIN maintenance_frequencies f ON f.shop = t.shop AND f.id = t.frequencyId
    WHERE t.shop = ? AND t.id = ?
    LIMIT 1
  `).get(shop, Number(id));
}

function insertFaultEvent({ shop, faultId, action, user, before = null, after = null, notes = null }) {
  db.prepare(`
    INSERT INTO maintenance_fault_events (shop, faultId, action, user, beforeJson, afterJson, notes, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    shop,
    faultId,
    action,
    user ? normalizeText(user) : null,
    before ? stringifyJson(before, {}) : null,
    after ? stringifyJson(after, {}) : null,
    notes ? normalizeText(notes) : null,
    nowIso()
  );
}

function updateAssetAvailability({ shop, assetId, nextStatus, user = null, faultId = null, notes = null }) {
  const asset = normalizeAsset(getAssetRow(shop, assetId));
  if (!asset) return null;
  const status = normalizeAvailabilityStatus(nextStatus);
  if (asset.availabilityStatus === status && Number(asset.availabilityFaultId || 0) === Number(faultId || 0)) {
    return asset;
  }

  const timestamp = nowIso();
  db.prepare(`
    UPDATE maintenance_assets
    SET availabilityStatus = ?,
        availabilityFaultId = ?,
        updatedAt = ?
    WHERE shop = ? AND id = ?
  `).run(status, faultId || null, timestamp, shop, assetId);

  db.prepare(`
    INSERT INTO maintenance_equipment_status_events (
      shop, assetId, previousStatus, newStatus, user, faultId, notes, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    shop,
    assetId,
    asset.availabilityStatus,
    status,
    user ? normalizeText(user) : null,
    faultId || null,
    notes ? normalizeText(notes) : null,
    timestamp
  );

  return normalizeAsset(getAssetRow(shop, assetId));
}

function buildFaultRef(id) {
  return `FLT-${String(Number(id) || 0).padStart(5, '0')}`;
}

function parseScheduledInstance(row) {
  return normalizeScheduledInstance(row);
}

function getSeedTemplateTitleForType(equipmentType, frequencyKey) {
  const type = normalizeText(equipmentType) || 'Equipment';
  if (/workshop|shop floor/i.test(type)) {
    if (frequencyKey === 'daily') return 'Daily shop floor reset';
    if (frequencyKey === 'weekly') return 'Weekly shop floor inspection';
    if (frequencyKey === 'monthly') return 'Monthly shop floor review';
  }
  return `${type} ${normalizeText(frequencyKey) || 'scheduled'} placeholder maintenance`;
}

function isSeededPlaceholderTemplate(row) {
  const assetName = normalizeText(row.assetName);
  const title = normalizeText(row.title);
  const frequencyKey = normalizeText(row.frequencyKey);
  const instructions = normalizeText(row.instructions);
  const placeholderInstruction = instructions === 'Placeholder preventative maintenance task. Replace with the approved manufacturer or internal procedure before operational use.' ||
    instructions === 'Placeholder workshop housekeeping task. Replace with approved site instructions.';
  if (!assetName || !frequencyKey || !placeholderInstruction) return false;
  return title === `${assetName} ${frequencyKey} placeholder maintenance` ||
    title === getSeedTemplateTitleForType(row.equipmentType, frequencyKey);
}

function migrateSeededAssetTemplatesToTypeTemplates({ shop, user = 'System' } = {}) {
  const normalizedShop = normalizeText(shop);
  if (!normalizedShop) return;
  const rows = db.prepare(`
    SELECT t.*, a.name AS assetName, a.equipmentType, f.key AS frequencyKey
    FROM maintenance_task_templates t
    JOIN maintenance_assets a ON a.shop = t.shop AND a.id = t.assetId
    JOIN maintenance_frequencies f ON f.shop = t.shop AND f.id = t.frequencyId
    WHERE t.shop = ?
      AND t.archivedAt IS NULL
      AND COALESCE(NULLIF(t.targetScope, ''), 'asset') = 'asset'
  `).all(normalizedShop).filter(isSeededPlaceholderTemplate);

  const groups = new Map();
  rows.forEach((row) => {
    const equipmentType = normalizeText(row.equipmentType);
    if (!equipmentType) return;
    const key = `${equipmentType}\u0000${row.frequencyId}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  });

  const timestamp = nowIso();
  const actor = normalizeText(user) || 'System';
  const tx = db.transaction(() => {
    groups.forEach((group) => {
      const sorted = group.sort((left, right) => Number(left.id) - Number(right.id));
      const keep = sorted[0];
      const duplicateIds = sorted.slice(1).map((row) => Number(row.id)).filter((id) => id > 0);
      const equipmentType = normalizeText(keep.equipmentType);
      const title = getSeedTemplateTitleForType(equipmentType, keep.frequencyKey);

      db.prepare(`
        UPDATE maintenance_task_templates
        SET assetId = 0,
            targetScope = 'equipment_type',
            targetEquipmentType = ?,
            title = ?,
            updatedBy = ?,
            updatedAt = ?
        WHERE shop = ? AND id = ?
      `).run(equipmentType, title, actor, timestamp, normalizedShop, keep.id);

      db.prepare(`
        UPDATE maintenance_scheduled_instances
        SET taskTitleSnapshot = ?,
            updatedAt = ?
        WHERE shop = ?
          AND templateId = ?
          AND status = 'scheduled'
          AND completionRecordId IS NULL
      `).run(title, timestamp, normalizedShop, keep.id);

      if (!duplicateIds.length) return;
      duplicateIds.forEach((id) => {
        db.prepare(`
          UPDATE maintenance_task_templates
          SET archivedAt = COALESCE(archivedAt, ?),
              active = 0,
              updatedBy = ?,
              updatedAt = ?
          WHERE shop = ? AND id = ?
        `).run(timestamp, actor, timestamp, normalizedShop, id);
        db.prepare(`
          DELETE FROM maintenance_scheduled_instances
          WHERE shop = ?
            AND templateId = ?
            AND status = 'scheduled'
            AND completionRecordId IS NULL
        `).run(normalizedShop, id);
      });
    });
  });

  tx();
}

module.exports = {
  ensureInitialMaintenanceSeedData({ shop, user = 'System' } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return;
    const timestamp = nowIso();

    const tx = db.transaction(() => {
      const frequencyCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM maintenance_frequencies
        WHERE shop = ?
      `).get(normalizedShop)?.count || 0;

      if (frequencyCount === 0) {
        [
          { key: 'daily', label: 'Daily', scheduleType: 'daily', intervalValue: 1, color: '#31c48d', sortOrder: 10 },
          { key: 'weekly', label: 'Weekly', scheduleType: 'weekly', intervalValue: 1, color: '#3b82f6', sortOrder: 20 },
          { key: 'monthly', label: 'Monthly', scheduleType: 'monthly', intervalValue: 1, color: '#f59e0b', sortOrder: 30 },
        ].forEach((frequency) => {
          db.prepare(`
            INSERT INTO maintenance_frequencies (
              shop, key, label, scheduleType, intervalValue, color, active, sortOrder, createdAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
          `).run(
            normalizedShop,
            frequency.key,
            frequency.label,
            frequency.scheduleType,
            frequency.intervalValue,
            frequency.color,
            frequency.sortOrder,
            timestamp,
            timestamp
          );
        });
      }

      const assetCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM maintenance_assets
        WHERE shop = ?
      `).get(normalizedShop)?.count || 0;

      if (assetCount === 0) {
        [
          ['Fuse 1+ #1', 'Fuse 1+', 'FUSE-1-01', 'Workshop'],
          ['Fuse 1+ #2', 'Fuse 1+', 'FUSE-1-02', 'Workshop'],
          ['Fuse 1+ #3', 'Fuse 1+', 'FUSE-1-03', 'Workshop'],
          ['Fuse 1+ #4', 'Fuse 1+', 'FUSE-1-04', 'Workshop'],
          ['Fuse Blast #1', 'Fuse Blast', 'FUSE-BLAST-01', 'Workshop'],
          ['Fuse Blast #2', 'Fuse Blast', 'FUSE-BLAST-02', 'Workshop'],
          ['Haas VF2', 'CNC Mill', 'HAAS-VF2', 'Machine Shop'],
          ['Manual Blaster #1', 'Manual Blaster', 'BLASTER-01', 'Finishing'],
          ['Manual Blaster #2', 'Manual Blaster', 'BLASTER-02', 'Finishing'],
          ['General Workshop / Shop Floor', 'Workshop Area', 'SHOP-FLOOR', 'Workshop'],
        ].forEach(([name, type, identifier, location]) => {
          db.prepare(`
            INSERT INTO maintenance_assets (
              shop, name, equipmentType, uniqueIdentifier, location, description, availabilityStatus,
              active, createdAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, 'available', 1, ?, ?)
          `).run(
            normalizedShop,
            name,
            type,
            identifier,
            location,
            'Initial configurable asset. Replace details with approved workshop information.',
            timestamp,
            timestamp
          );
        });
      }

      const templateCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM maintenance_task_templates
        WHERE shop = ?
      `).get(normalizedShop)?.count || 0;

      if (templateCount === 0) {
        const frequencies = db.prepare(`
          SELECT *
          FROM maintenance_frequencies
          WHERE shop = ?
        `).all(normalizedShop);
        const frequencyByKey = new Map(frequencies.map((frequency) => [frequency.key, frequency]));
        const equipmentTypes = db.prepare(`
          SELECT equipmentType, MIN(name) AS sampleAssetName
          FROM maintenance_assets
          WHERE shop = ?
            AND archivedAt IS NULL
            AND active = 1
            AND COALESCE(TRIM(equipmentType), '') != ''
          GROUP BY equipmentType
          ORDER BY equipmentType ASC
        `).all(normalizedShop);

        const insertTemplate = db.prepare(`
          INSERT INTO maintenance_task_templates (
            shop, assetId, targetScope, targetEquipmentType, title, frequencyId, scheduleDayOfWeek, scheduleDayOfMonth,
            instructions, checklistJson, documentsJson,
            estimatedMinutes, completionNotesRequired, evidenceRequired, active,
            createdBy, updatedBy, createdAt, updatedAt
          ) VALUES (?, 0, 'equipment_type', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        `);

        equipmentTypes.forEach((item) => {
          const equipmentType = normalizeText(item.equipmentType);
          if (!equipmentType) return;
          const isWorkshop = /workshop|shop floor/i.test(equipmentType);
          const baseInstructions = isWorkshop
            ? 'Placeholder workshop housekeeping task. Replace with approved site instructions.'
            : 'Placeholder preventative maintenance task. Replace with the approved manufacturer or internal procedure before operational use.';
          const checklist = normalizeChecklistItems([
            { text: 'Read and follow the approved local procedure', mandatory: true },
            { text: 'Record any abnormal condition as a fault', mandatory: true },
          ]);

          [
            ['daily', 10],
            ['weekly', 20],
            ['monthly', 30],
          ].forEach(([frequencyKey, estimatedMinutes]) => {
            const frequency = frequencyByKey.get(frequencyKey);
            if (!frequency) return;
            insertTemplate.run(
              normalizedShop,
              equipmentType,
              getSeedTemplateTitleForType(equipmentType, frequencyKey),
              frequency.id,
              1,
              1,
              baseInstructions,
              stringifyJson(checklist),
              '[]',
              estimatedMinutes,
              0,
              0,
              user,
              user,
              timestamp,
              timestamp
            );
          });
        });
      }
    });

    tx();
    migrateSeededAssetTemplatesToTypeTemplates({ shop: normalizedShop, user });
  },

  listAssets({ shop, includeArchived = false } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return [];
    const archivedClause = includeArchived ? '' : 'AND archivedAt IS NULL';
    return db.prepare(`
      SELECT *
      FROM maintenance_assets
      WHERE shop = ?
        ${archivedClause}
      ORDER BY archivedAt IS NOT NULL ASC, active DESC, equipmentType ASC, name ASC
    `).all(normalizedShop).map(normalizeAsset).filter(Boolean);
  },

  getAsset({ shop, id } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedId = normalizeInt(id);
    if (!normalizedShop || normalizedId <= 0) return null;
    return normalizeAsset(getAssetRow(normalizedShop, normalizedId));
  },

  saveAsset({ shop, asset = {}, user = null } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return null;
    const timestamp = nowIso();
    const id = normalizeInt(asset.id);
    const values = {
      name: normalizeText(asset.name) || 'Untitled Equipment',
      equipmentType: normalizeText(asset.equipmentType),
      uniqueIdentifier: normalizeText(asset.uniqueIdentifier),
      manufacturer: normalizeText(asset.manufacturer),
      model: normalizeText(asset.model),
      serialNumber: normalizeText(asset.serialNumber),
      location: normalizeText(asset.location),
      description: normalizeText(asset.description),
      photoUrl: normalizeText(asset.photoUrl),
      availabilityStatus: normalizeAvailabilityStatus(asset.availabilityStatus),
      notes: normalizeText(asset.notes),
      active: normalizeBool(asset.active !== false),
    };

    if (id > 0) {
      const existing = this.getAsset({ shop: normalizedShop, id });
      if (!existing) return null;
      db.prepare(`
        UPDATE maintenance_assets
        SET name = ?, equipmentType = ?, uniqueIdentifier = ?, manufacturer = ?, model = ?,
            serialNumber = ?, location = ?, description = ?, photoUrl = ?, availabilityStatus = ?,
            notes = ?, active = ?, updatedAt = ?
        WHERE shop = ? AND id = ?
      `).run(
        values.name,
        values.equipmentType,
        values.uniqueIdentifier,
        values.manufacturer,
        values.model,
        values.serialNumber,
        values.location,
        values.description,
        values.photoUrl,
        values.availabilityStatus,
        values.notes,
        values.active,
        timestamp,
        normalizedShop,
        id
      );
      if (existing.availabilityStatus !== values.availabilityStatus) {
        db.prepare(`
          INSERT INTO maintenance_equipment_status_events (
            shop, assetId, previousStatus, newStatus, user, notes, createdAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalizedShop,
          id,
          existing.availabilityStatus,
          values.availabilityStatus,
          user ? normalizeText(user) : null,
          'Availability changed from asset editor',
          timestamp
        );
      }
      return this.getAsset({ shop: normalizedShop, id });
    }

    const result = db.prepare(`
      INSERT INTO maintenance_assets (
        shop, name, equipmentType, uniqueIdentifier, manufacturer, model, serialNumber,
        location, description, photoUrl, availabilityStatus, notes, active, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedShop,
      values.name,
      values.equipmentType,
      values.uniqueIdentifier,
      values.manufacturer,
      values.model,
      values.serialNumber,
      values.location,
      values.description,
      values.photoUrl,
      values.availabilityStatus,
      values.notes,
      values.active,
      timestamp,
      timestamp
    );
    return this.getAsset({ shop: normalizedShop, id: result.lastInsertRowid });
  },

  archiveAsset({ shop, id } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedId = normalizeInt(id);
    if (!normalizedShop || normalizedId <= 0) return null;
    db.prepare(`
      UPDATE maintenance_assets
      SET archivedAt = COALESCE(archivedAt, ?),
          active = 0,
          updatedAt = ?
      WHERE shop = ? AND id = ?
    `).run(nowIso(), nowIso(), normalizedShop, normalizedId);
    return this.getAsset({ shop: normalizedShop, id: normalizedId });
  },

  duplicateAsset({ shop, id, user = null } = {}) {
    const existing = this.getAsset({ shop, id });
    if (!existing) return null;
    return this.saveAsset({
      shop,
      user,
      asset: {
        ...existing,
        id: null,
        name: `${existing.name} Copy`,
        uniqueIdentifier: existing.uniqueIdentifier ? `${existing.uniqueIdentifier}-COPY` : '',
        serialNumber: '',
        active: true,
        availabilityStatus: 'available',
      },
    });
  },

  listFrequencies({ shop, includeInactive = true } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return [];
    const activeClause = includeInactive ? '' : 'AND active = 1';
    return db.prepare(`
      SELECT *
      FROM maintenance_frequencies
      WHERE shop = ?
        ${activeClause}
      ORDER BY sortOrder ASC, label ASC
    `).all(normalizedShop).map(normalizeFrequency).filter(Boolean);
  },

  saveFrequency({ shop, frequency = {} } = {}) {
    const normalizedShop = normalizeText(shop);
    const key = normalizeText(frequency.key).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    if (!normalizedShop || !key) return null;
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO maintenance_frequencies (
        shop, key, label, scheduleType, intervalValue, color, active, sortOrder, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop, key) DO UPDATE SET
        label = excluded.label,
        scheduleType = excluded.scheduleType,
        intervalValue = excluded.intervalValue,
        color = excluded.color,
        active = excluded.active,
        sortOrder = excluded.sortOrder,
        updatedAt = excluded.updatedAt
    `).run(
      normalizedShop,
      key,
      normalizeText(frequency.label) || key,
      normalizeText(frequency.scheduleType) || 'daily',
      frequency.intervalValue ? normalizeInt(frequency.intervalValue) : null,
      normalizeText(frequency.color) || '#6ba6ff',
      normalizeBool(frequency.active !== false),
      normalizeInt(frequency.sortOrder),
      timestamp,
      timestamp
    );
    return db.prepare(`
      SELECT *
      FROM maintenance_frequencies
      WHERE shop = ? AND key = ?
    `).get(normalizedShop, key);
  },

  listTemplates({ shop, includeArchived = false } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return [];
    const archivedClause = includeArchived ? '' : 'AND t.archivedAt IS NULL';
    return db.prepare(`
      SELECT t.*,
             a.name AS assetName,
             COALESCE(NULLIF(t.targetEquipmentType, ''), a.equipmentType, '') AS equipmentType,
             (
               SELECT COUNT(*)
               FROM maintenance_assets targetAsset
               WHERE targetAsset.shop = t.shop
                 AND targetAsset.archivedAt IS NULL
                 AND targetAsset.active = 1
                 AND targetAsset.equipmentType = COALESCE(NULLIF(t.targetEquipmentType, ''), a.equipmentType, '')
             ) AS targetAssetCount,
             f.key AS frequencyKey, f.label AS frequencyLabel, f.color AS frequencyColor, f.scheduleType AS frequencyScheduleType
      FROM maintenance_task_templates t
      LEFT JOIN maintenance_assets a ON a.shop = t.shop AND a.id = t.assetId
      JOIN maintenance_frequencies f ON f.shop = t.shop AND f.id = t.frequencyId
      WHERE t.shop = ?
        ${archivedClause}
      ORDER BY t.archivedAt IS NOT NULL ASC, equipmentType ASC, f.sortOrder ASC, t.title ASC
    `).all(normalizedShop).map(normalizeTemplate).filter(Boolean);
  },

  getTemplate({ shop, id } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedId = normalizeInt(id);
    if (!normalizedShop || normalizedId <= 0) return null;
    return normalizeTemplate(getTemplateRow(normalizedShop, normalizedId));
  },

  saveTemplate({ shop, template = {}, user = null } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return null;
    const timestamp = nowIso();
    const id = normalizeInt(template.id);
    const requestedScope = normalizeTemplateScope(template.targetScope || (template.targetEquipmentType || template.equipmentType ? 'equipment_type' : 'asset'));
    const targetEquipmentType = normalizeText(template.targetEquipmentType || template.equipmentType);
    const assetId = requestedScope === 'asset' ? normalizeInt(template.assetId) : 0;
    const frequencyId = normalizeInt(template.frequencyId);
    if (frequencyId <= 0) return null;
    const frequency = normalizeFrequency(getFrequencyRow(normalizedShop, frequencyId));
    if (!frequency) return null;
    if (requestedScope === 'equipment_type' && !targetEquipmentType) return null;
    if (requestedScope === 'asset' && assetId <= 0) return null;

    const values = {
      targetScope: requestedScope,
      targetEquipmentType: requestedScope === 'equipment_type' ? targetEquipmentType : null,
      title: normalizeText(template.title) || 'Untitled Maintenance Instruction',
      assignedTo: normalizeText(template.assignedTo),
      scheduleDaysOfWeekJson: stringifyJson(normalizeWeekdays(template.scheduleDaysOfWeek, [1, 2, 3, 4, 5])),
      scheduleDayOfWeek: normalizeWeekday(template.scheduleDayOfWeek, 1),
      scheduleDayOfMonth: normalizeMonthDay(template.scheduleDayOfMonth, 1),
      instructions: normalizeText(template.instructions),
      checklistJson: stringifyJson(normalizeChecklistItems(template.checklist)),
      documentsJson: stringifyJson(normalizeDocuments(template.documents)),
      estimatedMinutes: template.estimatedMinutes ? normalizeInt(template.estimatedMinutes) : null,
      completionNotesRequired: normalizeBool(template.completionNotesRequired),
      evidenceRequired: normalizeBool(template.evidenceRequired),
      active: normalizeBool(template.active !== false),
    };

    if (id > 0) {
      const existing = this.getTemplate({ shop: normalizedShop, id });
      if (!existing) return null;
      db.prepare(`
        UPDATE maintenance_task_templates
        SET assetId = ?, targetScope = ?, targetEquipmentType = ?, title = ?, frequencyId = ?,
            assignedTo = ?, scheduleDaysOfWeekJson = ?, scheduleDayOfWeek = ?, scheduleDayOfMonth = ?, instructions = ?, checklistJson = ?,
            documentsJson = ?, estimatedMinutes = ?, completionNotesRequired = ?,
            evidenceRequired = ?, active = ?, updatedBy = ?, updatedAt = ?
        WHERE shop = ? AND id = ?
      `).run(
        assetId,
        values.targetScope,
        values.targetEquipmentType,
        values.title,
        frequencyId,
        values.assignedTo,
        values.scheduleDaysOfWeekJson,
        values.scheduleDayOfWeek,
        values.scheduleDayOfMonth,
        values.instructions,
        values.checklistJson,
        values.documentsJson,
        values.estimatedMinutes,
        values.completionNotesRequired,
        values.evidenceRequired,
        values.active,
        user ? normalizeText(user) : null,
        timestamp,
        normalizedShop,
        id
      );
      db.prepare(`
        UPDATE maintenance_scheduled_instances
        SET assignedToSnapshot = ?,
            updatedAt = ?
        WHERE shop = ?
          AND templateId = ?
          AND status = 'scheduled'
          AND completionRecordId IS NULL
      `).run(values.assignedTo, timestamp, normalizedShop, id);
      return this.getTemplate({ shop: normalizedShop, id });
    }

    const result = db.prepare(`
      INSERT INTO maintenance_task_templates (
        shop, assetId, targetScope, targetEquipmentType, title, assignedTo, frequencyId, scheduleDaysOfWeekJson, scheduleDayOfWeek, scheduleDayOfMonth,
        instructions, checklistJson, documentsJson,
        estimatedMinutes, completionNotesRequired, evidenceRequired, active,
        createdBy, updatedBy, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedShop,
      assetId,
      values.targetScope,
      values.targetEquipmentType,
      values.title,
      values.assignedTo,
      frequencyId,
      values.scheduleDaysOfWeekJson,
      values.scheduleDayOfWeek,
      values.scheduleDayOfMonth,
      values.instructions,
      values.checklistJson,
      values.documentsJson,
      values.estimatedMinutes,
      values.completionNotesRequired,
      values.evidenceRequired,
      values.active,
      user ? normalizeText(user) : null,
      user ? normalizeText(user) : null,
      timestamp,
      timestamp
    );
    return this.getTemplate({ shop: normalizedShop, id: result.lastInsertRowid });
  },

  archiveTemplate({ shop, id } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedId = normalizeInt(id);
    if (!normalizedShop || normalizedId <= 0) return null;
    db.prepare(`
      UPDATE maintenance_task_templates
      SET archivedAt = COALESCE(archivedAt, ?),
          active = 0,
          updatedAt = ?
      WHERE shop = ? AND id = ?
    `).run(nowIso(), nowIso(), normalizedShop, normalizedId);
    return this.getTemplate({ shop: normalizedShop, id: normalizedId });
  },

  duplicateTemplate({ shop, id, user = null } = {}) {
    const existing = this.getTemplate({ shop, id });
    if (!existing) return null;
    return this.saveTemplate({
      shop,
      user,
      template: {
        ...existing,
        id: null,
        title: `${existing.title} Copy`,
        active: true,
      },
    });
  },

  listActiveTemplateRows({ shop } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return [];
    return db.prepare(`
      SELECT t.*, a.id AS resolvedAssetId, a.name AS assetName, a.equipmentType, a.availabilityStatus, f.key AS frequencyKey,
             f.label AS frequencyLabel, f.color AS frequencyColor, f.scheduleType, f.intervalValue, f.sortOrder
      FROM maintenance_task_templates t
      JOIN maintenance_frequencies f ON f.shop = t.shop AND f.id = t.frequencyId
      JOIN maintenance_assets a ON a.shop = t.shop
        AND a.archivedAt IS NULL
        AND a.active = 1
        AND (
          (
            COALESCE(NULLIF(t.targetScope, ''), 'asset') = 'equipment_type'
            AND a.equipmentType = t.targetEquipmentType
          )
          OR (
            COALESCE(NULLIF(t.targetScope, ''), 'asset') = 'asset'
            AND a.id = t.assetId
          )
        )
      WHERE t.shop = ?
        AND t.archivedAt IS NULL
        AND t.active = 1
        AND f.active = 1
    `).all(normalizedShop);
  },

  insertScheduledInstanceIfMissing({ shop, templateRow, dueDate, sourceType = 'preventive' } = {}) {
    const normalizedShop = normalizeText(shop);
    const date = normalizeText(dueDate);
    if (!normalizedShop || !templateRow?.id || !date) return null;
    const assetId = normalizeInt(templateRow.resolvedAssetId || templateRow.assetId);
    if (assetId <= 0) return null;
    const timestamp = nowIso();
    const result = db.prepare(`
      INSERT OR IGNORE INTO maintenance_scheduled_instances (
        shop, templateId, assetId, frequencyId, dueDate, sourceType, status,
        taskTitleSnapshot, equipmentNameSnapshot, assignedToSnapshot, frequencyKeySnapshot, frequencyLabelSnapshot,
        frequencyColorSnapshot, instructionsSnapshot, checklistSnapshotJson, documentsSnapshotJson,
        estimatedMinutesSnapshot, completionNotesRequired, evidenceRequired, generatedAt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedShop,
      templateRow.id,
      assetId,
      templateRow.frequencyId,
      date,
      normalizeText(sourceType) || 'preventive',
      templateRow.title,
      templateRow.assetName,
      templateRow.assignedTo || '',
      templateRow.frequencyKey,
      templateRow.frequencyLabel,
      templateRow.frequencyColor,
      templateRow.instructions || '',
      templateRow.checklistJson || '[]',
      templateRow.documentsJson || '[]',
      templateRow.estimatedMinutes,
      Number(templateRow.completionNotesRequired || 0),
      Number(templateRow.evidenceRequired || 0),
      timestamp,
      timestamp,
      timestamp
    );
    return result.changes > 0;
  },

  prunePendingPreventiveScheduledInstances({ shop, startDate = null, endDate = null, expectedKeys = [] } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return 0;
    const expected = new Set(Array.isArray(expectedKeys) ? expectedKeys.map(String) : []);
    const where = [
      'shop = ?',
      "status = 'scheduled'",
      "COALESCE(sourceType, 'preventive') = 'preventive'",
      'completionRecordId IS NULL',
    ];
    const params = [normalizedShop];
    if (startDate) {
      where.push('dueDate >= ?');
      params.push(normalizeText(startDate));
    }
    if (endDate) {
      where.push('dueDate <= ?');
      params.push(normalizeText(endDate));
    }

    const rows = db.prepare(`
      SELECT id, templateId, assetId, dueDate
      FROM maintenance_scheduled_instances
      WHERE ${where.join(' AND ')}
    `).all(...params);
    const deleteStmt = db.prepare(`
      DELETE FROM maintenance_scheduled_instances
      WHERE shop = ?
        AND id = ?
        AND status = 'scheduled'
        AND completionRecordId IS NULL
    `);

    let prunedCount = 0;
    const tx = db.transaction(() => {
      rows.forEach((row) => {
        const key = `${row.templateId}:${row.assetId}:${row.dueDate}`;
        if (expected.has(key)) return;
        prunedCount += deleteStmt.run(normalizedShop, row.id).changes || 0;
      });
    });
    tx();
    return prunedCount;
  },

  clearOverdueDailyScheduledInstances({ shop, beforeDate, user = null } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedBeforeDate = normalizeText(beforeDate);
    if (!normalizedShop || !normalizedBeforeDate) {
      return { clearedCount: 0, beforeDate: normalizedBeforeDate };
    }

    const rows = db.prepare(`
      SELECT s.id
      FROM maintenance_scheduled_instances s
      LEFT JOIN maintenance_frequencies f ON f.shop = s.shop AND f.id = s.frequencyId
      WHERE s.shop = ?
        AND s.dueDate < ?
        AND s.status NOT IN ('completed', 'cancelled', 'skipped')
        AND COALESCE(NULLIF(s.frequencyKeySnapshot, ''), f.key, '') = 'daily'
    `).all(normalizedShop, normalizedBeforeDate);

    if (!rows.length) {
      return { clearedCount: 0, beforeDate: normalizedBeforeDate };
    }

    const timestamp = nowIso();
    const actor = normalizeText(user);
    const update = db.prepare(`
      UPDATE maintenance_scheduled_instances
      SET status = 'cancelled',
          skipReason = COALESCE(NULLIF(skipReason, ''), ?),
          updatedAt = ?
      WHERE shop = ?
        AND id = ?
        AND status NOT IN ('completed', 'cancelled', 'skipped')
    `);

    let clearedCount = 0;
    const tx = db.transaction(() => {
      rows.forEach((row) => {
        const reason = actor
          ? `Cleared overdue daily maintenance by ${actor}`
          : 'Cleared overdue daily maintenance';
        clearedCount += update.run(reason, timestamp, normalizedShop, row.id).changes || 0;
      });
    });
    tx();

    return { clearedCount, beforeDate: normalizedBeforeDate };
  },

  listScheduledInstances({ shop, startDate = null, endDate = null, includeCompleted = true } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return [];
    const where = ['s.shop = ?'];
    const params = [normalizedShop];
    if (startDate) {
      where.push('s.dueDate >= ?');
      params.push(normalizeText(startDate));
    }
    if (endDate) {
      where.push('s.dueDate <= ?');
      params.push(normalizeText(endDate));
    }
    if (!includeCompleted) {
      where.push("s.status != 'completed'");
    }
    const rows = db.prepare(`
      SELECT s.*, a.equipmentType, a.availabilityStatus AS assetAvailabilityStatus,
             COALESCE(NULLIF(s.assignedToSnapshot, ''), t.assignedTo, '') AS resolvedAssignedTo
      FROM maintenance_scheduled_instances s
      LEFT JOIN maintenance_assets a ON a.shop = s.shop AND a.id = s.assetId
      LEFT JOIN maintenance_task_templates t ON t.shop = s.shop AND t.id = s.templateId
      WHERE ${where.join(' AND ')}
      ORDER BY s.dueDate ASC, s.equipmentNameSnapshot ASC, s.taskTitleSnapshot ASC
    `).all(...params);
    return rows.map(normalizeScheduledInstance).filter(Boolean);
  },

  getScheduledInstance({ shop, id } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedId = normalizeInt(id);
    if (!normalizedShop || normalizedId <= 0) return null;
    const row = db.prepare(`
      SELECT s.*, a.equipmentType, a.availabilityStatus AS assetAvailabilityStatus,
             COALESCE(NULLIF(s.assignedToSnapshot, ''), t.assignedTo, '') AS resolvedAssignedTo
      FROM maintenance_scheduled_instances s
      LEFT JOIN maintenance_assets a ON a.shop = s.shop AND a.id = s.assetId
      LEFT JOIN maintenance_task_templates t ON t.shop = s.shop AND t.id = s.templateId
      WHERE s.shop = ? AND s.id = ?
      LIMIT 1
    `).get(normalizedShop, normalizedId);
    return parseScheduledInstance(row);
  },

  completeScheduledInstance({ shop, id, user = null, payload = {} } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedId = normalizeInt(id);
    if (!normalizedShop || normalizedId <= 0) return null;
    const instance = this.getScheduledInstance({ shop: normalizedShop, id: normalizedId });
    if (!instance) return null;
    if (['cancelled', 'skipped'].includes(instance.status)) {
      const err = new Error(`Maintenance task is ${instance.status} and cannot be completed`);
      err.statusCode = 400;
      throw err;
    }

    const existingCompletion = db.prepare(`
      SELECT *
      FROM maintenance_completion_records
      WHERE shop = ? AND scheduledInstanceId = ?
      LIMIT 1
    `).get(normalizedShop, normalizedId);
    if (existingCompletion) {
      return {
        instance,
        completion: normalizeCompletion(existingCompletion),
        alreadyCompleted: true,
      };
    }

    const checklistResponses = normalizeChecklistItems(
      Array.isArray(payload.checklistResponses) ? payload.checklistResponses : instance.checklist
    ).map((item) => ({
      ...item,
      completed: Boolean((payload.checklistResponses || []).find((response) => String(response.id) === String(item.id))?.completed),
      notes: normalizeText((payload.checklistResponses || []).find((response) => String(response.id) === String(item.id))?.notes),
    }));
    const missingMandatory = checklistResponses.some((item) => item.mandatory && !item.completed);
    if (missingMandatory) {
      const err = new Error('All mandatory checklist items must be completed');
      err.statusCode = 400;
      throw err;
    }

    const notes = normalizeText(payload.notes);
    if (instance.completionNotesRequired && !notes) {
      const err = new Error('Completion notes are required');
      err.statusCode = 400;
      throw err;
    }

    const evidence = normalizeEvidence(payload.evidence);
    if (instance.evidenceRequired && evidence.length === 0) {
      const err = new Error('Completion evidence is required');
      err.statusCode = 400;
      throw err;
    }

    const completedAt = nowIso();
    const timeliness = instance.dueDate < completedAt.slice(0, 10)
      ? 'overdue'
      : instance.dueDate > completedAt.slice(0, 10)
        ? 'early'
        : 'on_time';

    let completion = null;
    const tx = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO maintenance_completion_records (
          shop, scheduledInstanceId, templateId, assetId, dueDate, completedBy, startedAt,
          completedAt, timeliness, equipmentNameSnapshot, taskTitleSnapshot, frequencyLabelSnapshot,
          instructionsSnapshot, checklistResponsesJson, documentsSnapshotJson, notes, problemsFound,
          correctiveActionTaken, evidenceJson, faultsJson, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizedShop,
        normalizedId,
        instance.templateId,
        instance.assetId,
        instance.dueDate,
        user ? normalizeText(user) : null,
        instance.startedAt || null,
        completedAt,
        timeliness,
        instance.equipmentName,
        instance.taskTitle,
        instance.frequencyLabel,
        instance.instructions,
        stringifyJson(checklistResponses),
        stringifyJson(instance.documents),
        notes,
        normalizeText(payload.problemsFound),
        normalizeText(payload.correctiveActionTaken),
        stringifyJson(evidence),
        stringifyJson(payload.faults || []),
        completedAt
      );

      db.prepare(`
        UPDATE maintenance_scheduled_instances
        SET status = 'completed',
            completedAt = ?,
            completionRecordId = ?,
            updatedAt = ?
        WHERE shop = ? AND id = ?
      `).run(completedAt, result.lastInsertRowid, completedAt, normalizedShop, normalizedId);

      completion = normalizeCompletion(db.prepare(`
        SELECT *
        FROM maintenance_completion_records
        WHERE shop = ? AND id = ?
      `).get(normalizedShop, result.lastInsertRowid));
    });

    tx();

    return {
      instance: this.getScheduledInstance({ shop: normalizedShop, id: normalizedId }),
      completion,
      alreadyCompleted: false,
    };
  },

  skipScheduledInstance({ shop, id, user = null, payload = {} } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedId = normalizeInt(id);
    if (!normalizedShop || normalizedId <= 0) return null;
    const instance = this.getScheduledInstance({ shop: normalizedShop, id: normalizedId });
    if (!instance) return null;

    if (instance.status === 'completed') {
      const err = new Error('Completed maintenance cannot be skipped');
      err.statusCode = 400;
      throw err;
    }

    if (instance.status === 'skipped') {
      return {
        instance,
        alreadySkipped: true,
      };
    }

    const skippedAt = nowIso();
    const reason = normalizeText(payload.reason) || 'Not deemed necessary today';
    db.prepare(`
      UPDATE maintenance_scheduled_instances
      SET status = 'skipped',
          skippedAt = ?,
          skippedBy = ?,
          skipReason = ?,
          updatedAt = ?
      WHERE shop = ? AND id = ?
    `).run(
      skippedAt,
      user ? normalizeText(user) : null,
      reason,
      skippedAt,
      normalizedShop,
      normalizedId
    );

    return {
      instance: this.getScheduledInstance({ shop: normalizedShop, id: normalizedId }),
      alreadySkipped: false,
    };
  },

  listCompletions({ shop, startDate = null, endDate = null, assetId = null, limit = 200 } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return [];
    const where = ['shop = ?'];
    const params = [normalizedShop];
    if (startDate) {
      where.push('dueDate >= ?');
      params.push(normalizeText(startDate));
    }
    if (endDate) {
      where.push('dueDate <= ?');
      params.push(normalizeText(endDate));
    }
    if (assetId) {
      where.push('assetId = ?');
      params.push(normalizeInt(assetId));
    }
    params.push(Math.max(1, Math.min(1000, normalizeInt(limit, 200))));
    return db.prepare(`
      SELECT *
      FROM maintenance_completion_records
      WHERE ${where.join(' AND ')}
      ORDER BY completedAt DESC
      LIMIT ?
    `).all(...params).map(normalizeCompletion).filter(Boolean);
  },

  createFault({ shop, fault = {}, user = null } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return null;
    const timestamp = nowIso();
    const assetId = normalizeInt(fault.assetId) || null;
    const equipmentImpact = normalizeText(fault.equipmentImpact || 'none').toLowerCase().replace(/[\s_]+/g, '_');
    const status = normalizeFaultStatus(fault.status);
    let createdFault = null;

    const tx = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO maintenance_faults (
          shop, faultRef, assetId, scheduledInstanceId, completionRecordId, title, description,
          severity, status, equipmentImpact, reportedBy, assignedTo, targetResolutionDate,
          attachmentsJson, createdAt, updatedAt
        ) VALUES (?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizedShop,
        assetId,
        normalizeInt(fault.scheduledInstanceId) || null,
        normalizeInt(fault.completionRecordId) || null,
        normalizeText(fault.title) || 'Untitled Fault',
        normalizeText(fault.description),
        normalizeFaultSeverity(fault.severity),
        status,
        equipmentImpact || 'none',
        user ? normalizeText(user) : normalizeText(fault.reportedBy),
        normalizeText(fault.assignedTo),
        normalizeText(fault.targetResolutionDate) || null,
        stringifyJson(normalizeDocuments(fault.attachments)),
        timestamp,
        timestamp
      );
      const faultRef = buildFaultRef(result.lastInsertRowid);
      db.prepare(`
        UPDATE maintenance_faults
        SET faultRef = ?
        WHERE shop = ? AND id = ?
      `).run(faultRef, normalizedShop, result.lastInsertRowid);

      insertFaultEvent({
        shop: normalizedShop,
        faultId: result.lastInsertRowid,
        action: 'fault_reported',
        user,
        after: { faultRef, status, severity: normalizeFaultSeverity(fault.severity), equipmentImpact },
      });

      if (assetId && (equipmentImpact === 'restricted_use' || equipmentImpact === 'out_of_service')) {
        updateAssetAvailability({
          shop: normalizedShop,
          assetId,
          nextStatus: equipmentImpact,
          user,
          faultId: result.lastInsertRowid,
          notes: `Fault ${faultRef} reported`,
        });
        insertFaultEvent({
          shop: normalizedShop,
          faultId: result.lastInsertRowid,
          action: `equipment_marked_${equipmentImpact}`,
          user,
          after: { availabilityStatus: equipmentImpact },
        });
      }

      createdFault = this.getFault({ shop: normalizedShop, id: result.lastInsertRowid });
    });

    tx();
    return createdFault;
  },

  getFault({ shop, id } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedId = normalizeInt(id);
    if (!normalizedShop || normalizedId <= 0) return null;
    return normalizeFault(db.prepare(`
      SELECT f.*, a.name AS assetName, a.equipmentType
      FROM maintenance_faults f
      LEFT JOIN maintenance_assets a ON a.shop = f.shop AND a.id = f.assetId
      WHERE f.shop = ? AND f.id = ?
      LIMIT 1
    `).get(normalizedShop, normalizedId));
  },

  listFaults({ shop, includeClosed = true, assetId = null, limit = 500 } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return [];
    const where = ['f.shop = ?'];
    const params = [normalizedShop];
    if (!includeClosed) {
      where.push("f.status NOT IN ('resolved', 'closed')");
    }
    if (assetId) {
      where.push('f.assetId = ?');
      params.push(normalizeInt(assetId));
    }
    params.push(Math.max(1, Math.min(1000, normalizeInt(limit, 500))));
    return db.prepare(`
      SELECT f.*, a.name AS assetName, a.equipmentType
      FROM maintenance_faults f
      LEFT JOIN maintenance_assets a ON a.shop = f.shop AND a.id = f.assetId
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE f.status WHEN 'critical' THEN 0 ELSE 1 END,
        f.resolvedAt IS NULL DESC,
        f.createdAt DESC
      LIMIT ?
    `).all(...params).map(normalizeFault).filter(Boolean);
  },

  updateFault({ shop, id, patch = {}, user = null } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedId = normalizeInt(id);
    if (!normalizedShop || normalizedId <= 0) return null;
    const existing = this.getFault({ shop: normalizedShop, id: normalizedId });
    if (!existing) return null;

    const next = {
      severity: patch.severity ? normalizeFaultSeverity(patch.severity) : existing.severity,
      status: patch.status ? normalizeFaultStatus(patch.status) : existing.status,
      assignedTo: patch.assignedTo !== undefined ? normalizeText(patch.assignedTo) : existing.assignedTo,
      targetResolutionDate: patch.targetResolutionDate !== undefined ? normalizeText(patch.targetResolutionDate) || null : existing.targetResolutionDate,
      correctiveAction: patch.correctiveAction !== undefined ? normalizeText(patch.correctiveAction) : existing.correctiveAction,
      resolutionNotes: patch.resolutionNotes !== undefined ? normalizeText(patch.resolutionNotes) : existing.resolutionNotes,
    };
    const isResolving = ['resolved', 'closed'].includes(next.status) && !existing.resolvedAt;
    const timestamp = nowIso();

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE maintenance_faults
        SET severity = ?, status = ?, assignedTo = ?, targetResolutionDate = ?,
            correctiveAction = ?, resolutionNotes = ?,
            resolvedAt = CASE WHEN ? THEN ? ELSE resolvedAt END,
            resolvedBy = CASE WHEN ? THEN ? ELSE resolvedBy END,
            updatedAt = ?
        WHERE shop = ? AND id = ?
      `).run(
        next.severity,
        next.status,
        next.assignedTo,
        next.targetResolutionDate,
        next.correctiveAction,
        next.resolutionNotes,
        isResolving ? 1 : 0,
        timestamp,
        isResolving ? 1 : 0,
        user ? normalizeText(user) : null,
        timestamp,
        normalizedShop,
        normalizedId
      );

      insertFaultEvent({
        shop: normalizedShop,
        faultId: normalizedId,
        action: isResolving ? 'fault_resolved' : 'fault_updated',
        user,
        before: existing,
        after: next,
      });

      if (isResolving && existing.assetId && normalizeBool(patch.returnEquipmentToAvailable)) {
        updateAssetAvailability({
          shop: normalizedShop,
          assetId: existing.assetId,
          nextStatus: 'available',
          user,
          faultId: normalizedId,
          notes: `Fault ${existing.faultRef} resolved`,
        });
      }
    });

    tx();
    return this.getFault({ shop: normalizedShop, id: normalizedId });
  },

  listFaultEvents({ shop, faultId } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedFaultId = normalizeInt(faultId);
    if (!normalizedShop || normalizedFaultId <= 0) return [];
    return db.prepare(`
      SELECT *
      FROM maintenance_fault_events
      WHERE shop = ? AND faultId = ?
      ORDER BY createdAt ASC, id ASC
    `).all(normalizedShop, normalizedFaultId).map(normalizeFaultEvent).filter(Boolean);
  },

  createCorrectiveTask({ shop, task = {}, user = null } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return null;
    const timestamp = nowIso();
    const faultId = normalizeInt(task.faultId) || null;
    const assetId = normalizeInt(task.assetId) || null;
    const result = db.prepare(`
      INSERT INTO maintenance_corrective_tasks (
        shop, faultId, assetId, title, instructions, checklistJson, documentsJson,
        priority, assignedTo, targetDate, evidenceRequired, notes, status,
        createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(
      normalizedShop,
      faultId,
      assetId,
      normalizeText(task.title) || 'Corrective Maintenance',
      normalizeText(task.instructions),
      stringifyJson(normalizeChecklistItems(task.checklist)),
      stringifyJson(normalizeDocuments(task.documents)),
      normalizeFaultSeverity(task.priority),
      normalizeText(task.assignedTo),
      normalizeText(task.targetDate) || null,
      normalizeBool(task.evidenceRequired),
      normalizeText(task.notes),
      timestamp,
      timestamp
    );

    if (faultId) {
      insertFaultEvent({
        shop: normalizedShop,
        faultId,
        action: 'corrective_maintenance_created',
        user,
        after: { correctiveTaskId: result.lastInsertRowid },
      });
      db.prepare(`
        UPDATE maintenance_faults
        SET status = CASE WHEN status IN ('reported', 'acknowledged') THEN 'corrective_maintenance_required' ELSE status END,
            updatedAt = ?
        WHERE shop = ? AND id = ?
      `).run(timestamp, normalizedShop, faultId);
    }

    return this.getCorrectiveTask({ shop: normalizedShop, id: result.lastInsertRowid });
  },

  getCorrectiveTask({ shop, id } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedId = normalizeInt(id);
    if (!normalizedShop || normalizedId <= 0) return null;
    return normalizeCorrectiveTask(db.prepare(`
      SELECT c.*, a.name AS assetName, f.faultRef
      FROM maintenance_corrective_tasks c
      LEFT JOIN maintenance_assets a ON a.shop = c.shop AND a.id = c.assetId
      LEFT JOIN maintenance_faults f ON f.shop = c.shop AND f.id = c.faultId
      WHERE c.shop = ? AND c.id = ?
      LIMIT 1
    `).get(normalizedShop, normalizedId));
  },

  listCorrectiveTasks({ shop, includeCompleted = true, assetId = null } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return [];
    const where = ['c.shop = ?'];
    const params = [normalizedShop];
    if (!includeCompleted) {
      where.push("c.status NOT IN ('completed', 'cancelled')");
    }
    if (assetId) {
      where.push('c.assetId = ?');
      params.push(normalizeInt(assetId));
    }
    return db.prepare(`
      SELECT c.*, a.name AS assetName, f.faultRef
      FROM maintenance_corrective_tasks c
      LEFT JOIN maintenance_assets a ON a.shop = c.shop AND a.id = c.assetId
      LEFT JOIN maintenance_faults f ON f.shop = c.shop AND f.id = c.faultId
      WHERE ${where.join(' AND ')}
      ORDER BY c.status = 'completed' ASC, c.targetDate ASC, c.createdAt DESC
    `).all(...params).map(normalizeCorrectiveTask).filter(Boolean);
  },

  completeCorrectiveTask({ shop, id, user = null, payload = {} } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedId = normalizeInt(id);
    if (!normalizedShop || normalizedId <= 0) return null;
    const task = this.getCorrectiveTask({ shop: normalizedShop, id: normalizedId });
    if (!task) return null;
    const responses = normalizeChecklistItems(
      Array.isArray(payload.checklistResponses) ? payload.checklistResponses : task.checklist
    ).map((item) => ({
      ...item,
      completed: Boolean((payload.checklistResponses || []).find((response) => String(response.id) === String(item.id))?.completed),
      notes: normalizeText((payload.checklistResponses || []).find((response) => String(response.id) === String(item.id))?.notes),
    }));
    if (responses.some((item) => item.mandatory && !item.completed)) {
      const err = new Error('All mandatory corrective checklist items must be completed');
      err.statusCode = 400;
      throw err;
    }

    const timestamp = nowIso();
    db.prepare(`
      UPDATE maintenance_corrective_tasks
      SET status = 'completed',
          completedBy = ?,
          completedAt = ?,
          completionNotes = ?,
          partsReplaced = ?,
          checklistJson = ?,
          evidenceJson = ?,
          updatedAt = ?
      WHERE shop = ? AND id = ?
    `).run(
      user ? normalizeText(user) : null,
      timestamp,
      normalizeText(payload.completionNotes),
      normalizeText(payload.partsReplaced),
      stringifyJson(responses),
      stringifyJson(normalizeEvidence(payload.evidence)),
      timestamp,
      normalizedShop,
      normalizedId
    );

    if (task.faultId) {
      insertFaultEvent({
        shop: normalizedShop,
        faultId: task.faultId,
        action: 'corrective_maintenance_completed',
        user,
        after: { correctiveTaskId: normalizedId, completionNotes: normalizeText(payload.completionNotes) },
      });
      if (payload.faultResolution === 'resolved' || payload.faultResolution === 'closed') {
        this.updateFault({
          shop: normalizedShop,
          id: task.faultId,
          user,
          patch: {
            status: payload.faultResolution,
            resolutionNotes: payload.completionNotes,
            returnEquipmentToAvailable: Boolean(payload.returnEquipmentToAvailable),
          },
        });
      }
    }

    return this.getCorrectiveTask({ shop: normalizedShop, id: normalizedId });
  },

  getDailyEquipmentCompletionState({ shop, assetId, dueDate } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedAssetId = normalizeInt(assetId);
    const normalizedDueDate = normalizeText(dueDate);
    if (!normalizedShop || normalizedAssetId <= 0 || !normalizedDueDate) return null;

    const rows = this.listScheduledInstances({
      shop: normalizedShop,
      startDate: normalizedDueDate,
      endDate: normalizedDueDate,
    }).filter((instance) => (
      Number(instance.assetId) === normalizedAssetId &&
      ['preventive', 'ad_hoc_daily'].includes(instance.sourceType) &&
      !['cancelled', 'skipped'].includes(instance.status)
    ));

    const completed = rows.filter((instance) => instance.status === 'completed');
    return {
      assetId: normalizedAssetId,
      dueDate: normalizedDueDate,
      totalRequired: rows.length,
      completedCount: completed.length,
      isComplete: rows.length > 0 && completed.length === rows.length,
      instances: rows,
    };
  },

  getOpenFaultCountForAssetDate({ shop, assetId, date } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedAssetId = normalizeInt(assetId);
    const normalizedDate = normalizeText(date);
    if (!normalizedShop || normalizedAssetId <= 0 || !normalizedDate) return 0;
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM maintenance_faults
      WHERE shop = ?
        AND assetId = ?
        AND DATE(createdAt) = ?
        AND status NOT IN ('resolved', 'closed')
    `).get(normalizedShop, normalizedAssetId, normalizedDate);
    return Number(row?.count || 0);
  },

  createNotificationEventIfMissing({ shop, eventType, assetId = null, eventDate = null, payload = {}, cycle = 1 } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedEventType = normalizeText(eventType);
    if (!normalizedShop || !normalizedEventType) return { event: null, created: false };
    const timestamp = nowIso();
    const result = db.prepare(`
      INSERT OR IGNORE INTO maintenance_notification_events (
        shop, eventType, assetId, eventDate, cycle, payloadJson, status, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?)
    `).run(
      normalizedShop,
      normalizedEventType,
      assetId || null,
      eventDate || null,
      cycle,
      stringifyJson(payload, {}),
      timestamp,
      timestamp
    );

    const event = normalizeNotificationEvent(db.prepare(`
      SELECT *
      FROM maintenance_notification_events
      WHERE shop = ?
        AND eventType = ?
        AND COALESCE(assetId, 0) = COALESCE(?, 0)
        AND COALESCE(eventDate, '') = COALESCE(?, '')
        AND cycle = ?
      LIMIT 1
    `).get(normalizedShop, normalizedEventType, assetId || null, eventDate || null, cycle));

    return { event, created: Number(result?.changes || 0) > 0 };
  },

  recordNotificationAttempt({ shop, eventId, provider, status, httpStatus = null, responseBody = null, errorMessage = null, retryCount = 0 } = {}) {
    const normalizedShop = normalizeText(shop);
    const normalizedEventId = normalizeInt(eventId);
    if (!normalizedShop || normalizedEventId <= 0) return null;
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO maintenance_notification_attempts (
        shop, eventId, provider, status, httpStatus, responseBody, errorMessage, retryCount, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedShop,
      normalizedEventId,
      normalizeText(provider),
      normalizeText(status),
      httpStatus,
      responseBody ? String(responseBody).slice(0, 2000) : null,
      errorMessage ? String(errorMessage).slice(0, 1000) : null,
      normalizeInt(retryCount),
      timestamp
    );

    db.prepare(`
      UPDATE maintenance_notification_events
      SET status = ?,
          updatedAt = ?
      WHERE shop = ? AND id = ?
    `).run(normalizeText(status), timestamp, normalizedShop, normalizedEventId);
  },

  getNotificationSettings({ shop, includeSecret = false } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return includeSecret ? null : normalizeNotificationSettings(null);
    const row = db.prepare(`
      SELECT *
      FROM maintenance_notification_settings
      WHERE shop = ?
      LIMIT 1
    `).get(normalizedShop);
    if (includeSecret) {
      return row ? {
        ...normalizeNotificationSettings(row),
        googleChatWebhookUrl: normalizeText(row.googleChatWebhookUrl),
      } : {
        ...normalizeNotificationSettings(null),
        googleChatWebhookUrl: '',
      };
    }
    return normalizeNotificationSettings(row);
  },

  saveNotificationSettings({ shop, settings = {}, user = null } = {}) {
    const normalizedShop = normalizeText(shop);
    if (!normalizedShop) return null;
    const existing = this.getNotificationSettings({ shop: normalizedShop, includeSecret: true });
    const webhookUrl = settings.googleChatWebhookUrl !== undefined
      ? normalizeText(settings.googleChatWebhookUrl)
      : normalizeText(existing?.googleChatWebhookUrl);
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO maintenance_notification_settings (
        shop, googleChatEnabled, googleChatWebhookUrl, googleChatDestinationName,
        dailyCompletionEnabled, updatedBy, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop) DO UPDATE SET
        googleChatEnabled = excluded.googleChatEnabled,
        googleChatWebhookUrl = excluded.googleChatWebhookUrl,
        googleChatDestinationName = excluded.googleChatDestinationName,
        dailyCompletionEnabled = excluded.dailyCompletionEnabled,
        updatedBy = excluded.updatedBy,
        updatedAt = excluded.updatedAt
    `).run(
      normalizedShop,
      normalizeBool(settings.googleChatEnabled),
      webhookUrl || null,
      normalizeText(settings.googleChatDestinationName),
      normalizeBool(settings.dailyCompletionEnabled !== false),
      user ? normalizeText(user) : null,
      timestamp
    );
    return this.getNotificationSettings({ shop: normalizedShop });
  },
};
