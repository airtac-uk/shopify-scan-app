const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sessionsStore = require('./sessionsStore');
const maintenanceStore = require('./maintenanceStore');
const maintenanceService = require('./maintenanceService');

const router = express.Router();
const LOCAL_MAINTENANCE_UPLOAD_ROOT = path.resolve(__dirname, 'uploads', 'maintenance');
const RENDER_MAINTENANCE_UPLOAD_ROOT = '/var/data/maintenance-uploads';
const MAINTENANCE_UPLOAD_ROOT = resolveMaintenanceUploadRoot();
const MAX_UPLOAD_REQUEST_BYTES = 60 * 1024 * 1024;
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'application/pdf',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const ALLOWED_UPLOAD_EXTENSIONS = new Set(['.gif', '.heic', '.heif', '.jpeg', '.jpg', '.pdf', '.png', '.webp']);

function resolveMaintenanceUploadRoot() {
  const configuredRoot = String(process.env.MAINTENANCE_UPLOAD_ROOT || process.env.MAINTENANCE_UPLOAD_DIR || '').trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  const configuredDiskRoot = String(process.env.RENDER_DISK_MOUNT_PATH || process.env.PERSISTENT_STORAGE_DIR || '').trim();
  if (configuredDiskRoot) {
    return path.resolve(configuredDiskRoot, 'maintenance-uploads');
  }

  if (process.env.RENDER || process.env.RENDER_SERVICE_ID) {
    return RENDER_MAINTENANCE_UPLOAD_ROOT;
  }

  return LOCAL_MAINTENANCE_UPLOAD_ROOT;
}

function sendAuthRequired(res, error = 'Not logged in') {
  return res.status(401).json({ success: false, error });
}

function resolveMaintenanceAuth(req, res, { requireUser = false } = {}) {
  const shop = String(req.cookies?.shop || '').trim();
  if (!shop) {
    sendAuthRequired(res, 'Not logged in');
    return null;
  }

  const session = sessionsStore.get(shop);
  if (!session) {
    sendAuthRequired(res, 'No session found');
    return null;
  }

  const userId = String(req.cookies?.userId || '').trim();
  if (requireUser && !userId) {
    sendAuthRequired(res, 'Username needs to be set');
    return null;
  }

  return { shop, session, userId };
}

function getStatusCode(err) {
  const statusCode = Number(err?.statusCode || err?.status);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
}

function sendRouteError(res, err, fallback = 'Server error') {
  return res.status(getStatusCode(err)).json({
    success: false,
    error: err?.message || fallback,
  });
}

function getMaintenanceRange(req) {
  return maintenanceService.getRangeFromRequest(req.query || {});
}

function normalizeUploadSegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'shop';
}

function normalizeUploadFileName(value) {
  return path.basename(String(value || '').trim()).replace(/[^\w .()[\]-]+/g, '_') || 'maintenance-upload';
}

function createHttpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function getBoundary(req) {
  const contentType = String(req.headers['content-type'] || '');
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? String(match[1] || match[2] || '').trim() : '';
}

function readRequestBuffer(req, maxBytes = MAX_UPLOAD_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let failed = false;

    req.on('data', (chunk) => {
      if (failed) return;
      total += chunk.length;
      if (total > maxBytes) {
        failed = true;
        reject(createHttpError('Upload is too large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

function parsePartHeaders(headerText) {
  return String(headerText || '')
    .split(/\r?\n/)
    .reduce((headers, line) => {
      const separator = line.indexOf(':');
      if (separator <= 0) return headers;
      headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
      return headers;
    }, {});
}

function getDispositionValue(disposition, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(disposition || '').match(new RegExp(`${escapedKey}="([^"]*)"`, 'i'));
  return match ? match[1] : '';
}

function parseMultipartFiles(req, body) {
  const boundary = getBoundary(req);
  if (!boundary) throw createHttpError('Upload must use multipart/form-data');

  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const boundaryPrefix = Buffer.from(`\r\n--${boundary}`);
  const files = [];
  let cursor = 0;

  while (cursor < body.length) {
    const boundaryIndex = body.indexOf(boundaryBuffer, cursor);
    if (boundaryIndex < 0) break;

    let partStart = boundaryIndex + boundaryBuffer.length;
    if (body.slice(partStart, partStart + 2).toString('latin1') === '--') break;
    if (body.slice(partStart, partStart + 2).toString('latin1') === '\r\n') partStart += 2;

    const headerEnd = body.indexOf(headerSeparator, partStart);
    if (headerEnd < 0) break;

    const headers = parsePartHeaders(body.slice(partStart, headerEnd).toString('latin1'));
    const disposition = headers['content-disposition'] || '';
    const originalName = normalizeUploadFileName(getDispositionValue(disposition, 'filename'));
    const fieldName = getDispositionValue(disposition, 'name');
    const dataStart = headerEnd + headerSeparator.length;
    const nextBoundary = body.indexOf(boundaryPrefix, dataStart);
    if (nextBoundary < 0) break;

    if (originalName) {
      files.push({
        fieldName,
        originalName,
        mimeType: String(headers['content-type'] || 'application/octet-stream').toLowerCase(),
        buffer: body.slice(dataStart, nextBoundary),
      });
    }

    cursor = nextBoundary + 2;
  }

  return files;
}

function getExtensionForUpload(file) {
  const originalExtension = path.extname(file.originalName).toLowerCase();
  if (ALLOWED_UPLOAD_EXTENSIONS.has(originalExtension)) return originalExtension;
  if (file.mimeType === 'application/pdf') return '.pdf';
  if (file.mimeType === 'image/jpeg') return '.jpg';
  if (file.mimeType === 'image/png') return '.png';
  if (file.mimeType === 'image/gif') return '.gif';
  if (file.mimeType === 'image/webp') return '.webp';
  if (file.mimeType === 'image/heic') return '.heic';
  if (file.mimeType === 'image/heif') return '.heif';
  return '';
}

function getUploadDocumentType({ mimeType, extension }) {
  if (mimeType === 'application/pdf' || extension === '.pdf') return 'pdf';
  return 'image';
}

function validateUploadFile(file) {
  if (!file.buffer?.length) throw createHttpError('Uploaded file is empty');
  if (file.buffer.length > MAX_UPLOAD_FILE_BYTES) throw createHttpError(`${file.originalName} is larger than 25MB`, 413);

  const extension = getExtensionForUpload(file);
  const mimeAllowed = ALLOWED_UPLOAD_MIME_TYPES.has(file.mimeType);
  const extensionAllowed = ALLOWED_UPLOAD_EXTENSIONS.has(extension);
  if (!mimeAllowed && !extensionAllowed) {
    throw createHttpError(`${file.originalName} must be an image or PDF`);
  }

  return extension;
}

function saveMaintenanceUpload({ shop, user, file }) {
  const shopSegment = normalizeUploadSegment(shop);
  const uploadDir = path.join(MAINTENANCE_UPLOAD_ROOT, shopSegment);
  fs.mkdirSync(uploadDir, { recursive: true });

  const extension = validateUploadFile(file);
  const id = `upload_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  const storageName = `${id}${extension}`;
  const filePath = path.join(uploadDir, storageName);
  fs.writeFileSync(filePath, file.buffer, { flag: 'wx' });

  return {
    id,
    label: file.originalName,
    originalName: file.originalName,
    url: `/api/maintenance/uploads/${encodeURIComponent(storageName)}`,
    type: getUploadDocumentType({ mimeType: file.mimeType, extension }),
    mimeType: file.mimeType,
    size: file.buffer.length,
    uploadedBy: user || '',
    uploadedAt: new Date().toISOString(),
    sortOrder: 0,
  };
}

router.post('/api/maintenance/uploads', async (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;

    const body = await readRequestBuffer(req);
    const files = parseMultipartFiles(req, body);
    if (!files.length) return res.status(400).json({ success: false, error: 'Choose an image or PDF to upload' });

    const documents = files.map((file, index) => ({
      ...saveMaintenanceUpload({ shop: auth.shop, user: auth.userId, file }),
      sortOrder: index,
    }));

    return res.json({ success: true, documents });
  } catch (err) {
    console.error('Error in POST /api/maintenance/uploads:', err);
    return sendRouteError(res, err, 'Failed to upload file');
  }
});

router.get('/api/maintenance/uploads/:fileName', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res);
    if (!auth) return;

    const fileName = path.basename(String(req.params.fileName || '').trim());
    if (!/^[\w.-]+\.(gif|heic|heif|jpe?g|pdf|png|webp)$/i.test(fileName)) {
      return res.status(400).send('Invalid file');
    }

    const uploadDir = path.resolve(MAINTENANCE_UPLOAD_ROOT, normalizeUploadSegment(auth.shop));
    const filePath = path.resolve(uploadDir, fileName);
    if (!filePath.startsWith(`${uploadDir}${path.sep}`)) {
      return res.status(400).send('Invalid file');
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
    }

    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    return res.sendFile(filePath);
  } catch (err) {
    console.error('Error in GET /api/maintenance/uploads/:fileName:', err);
    return res.status(getStatusCode(err)).send(err?.message || 'Failed to load file');
  }
});

router.get('/api/maintenance/bootstrap', async (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res);
    if (!auth) return;

    maintenanceStore.ensureInitialMaintenanceSeedData({
      shop: auth.shop,
      user: auth.userId || 'System',
    });

    const range = getMaintenanceRange(req);
    const generated = maintenanceService.generateScheduledMaintenance({
      shop: auth.shop,
      startDate: range.startDate,
      endDate: range.endDate,
    });
    const scheduledInstances = maintenanceService.attachCalendarStatus(
      maintenanceStore.listScheduledInstances({
        shop: auth.shop,
        startDate: range.startDate,
        endDate: range.endDate,
      }),
      range.today
    );
    const dashboard = maintenanceService.buildDashboard({
      shop: auth.shop,
      startDate: range.startDate,
      endDate: range.endDate,
      today: range.today,
    });
    const reports = maintenanceService.buildReports({
      shop: auth.shop,
      startDate: range.startDate,
      endDate: range.endDate,
      today: range.today,
    });
    const knownUsers = sessionsStore.listKnownUsers({ shop: auth.shop });
    if (
      auth.userId &&
      !knownUsers.some((user) => String(user || '').trim().toLowerCase() === auth.userId.toLowerCase())
    ) {
      knownUsers.unshift(auth.userId);
    }

    return res.json({
      success: true,
      range,
      generated,
      assets: maintenanceStore.listAssets({ shop: auth.shop, includeArchived: true }),
      frequencies: maintenanceStore.listFrequencies({ shop: auth.shop }),
      templates: maintenanceStore.listTemplates({ shop: auth.shop, includeArchived: true }),
      scheduledInstances,
      faults: maintenanceStore.listFaults({ shop: auth.shop, includeClosed: true }),
      correctiveTasks: maintenanceStore.listCorrectiveTasks({ shop: auth.shop, includeCompleted: true }),
      dashboard,
      reports,
      knownUsers,
      notificationSettings: maintenanceStore.getNotificationSettings({ shop: auth.shop }),
    });
  } catch (err) {
    console.error('Error in /api/maintenance/bootstrap:', err);
    return sendRouteError(res, err);
  }
});

router.post('/api/maintenance/assets', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const asset = maintenanceStore.saveAsset({
      shop: auth.shop,
      user: auth.userId,
      asset: req.body || {},
    });
    return res.json({ success: true, asset });
  } catch (err) {
    console.error('Error in POST /api/maintenance/assets:', err);
    return sendRouteError(res, err);
  }
});

router.put('/api/maintenance/assets/:id', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const asset = maintenanceStore.saveAsset({
      shop: auth.shop,
      user: auth.userId,
      asset: { ...(req.body || {}), id: req.params.id },
    });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    return res.json({ success: true, asset });
  } catch (err) {
    console.error('Error in PUT /api/maintenance/assets/:id:', err);
    return sendRouteError(res, err);
  }
});

router.post('/api/maintenance/assets/:id/archive', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const asset = maintenanceStore.archiveAsset({ shop: auth.shop, id: req.params.id });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    return res.json({ success: true, asset });
  } catch (err) {
    console.error('Error in POST /api/maintenance/assets/:id/archive:', err);
    return sendRouteError(res, err);
  }
});

router.post('/api/maintenance/assets/:id/duplicate', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const asset = maintenanceStore.duplicateAsset({ shop: auth.shop, id: req.params.id, user: auth.userId });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    return res.json({ success: true, asset });
  } catch (err) {
    console.error('Error in POST /api/maintenance/assets/:id/duplicate:', err);
    return sendRouteError(res, err);
  }
});

router.post('/api/maintenance/assets/:id/schedule-daily', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const result = maintenanceService.scheduleUnexpectedDailyMaintenance({
      shop: auth.shop,
      assetId: req.params.id,
      date: req.body?.date,
      user: auth.userId,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('Error in POST /api/maintenance/assets/:id/schedule-daily:', err);
    return sendRouteError(res, err, 'Failed to schedule daily maintenance');
  }
});

router.post('/api/maintenance/frequencies', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const frequency = maintenanceStore.saveFrequency({ shop: auth.shop, frequency: req.body || {} });
    return res.json({ success: true, frequency });
  } catch (err) {
    console.error('Error in POST /api/maintenance/frequencies:', err);
    return sendRouteError(res, err);
  }
});

router.post('/api/maintenance/templates', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const template = maintenanceStore.saveTemplate({
      shop: auth.shop,
      user: auth.userId,
      template: req.body || {},
    });
    if (!template) return res.status(400).json({ success: false, error: 'Instruction needs machine type and frequency' });
    return res.json({ success: true, template });
  } catch (err) {
    console.error('Error in POST /api/maintenance/templates:', err);
    return sendRouteError(res, err);
  }
});

router.put('/api/maintenance/templates/:id', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const template = maintenanceStore.saveTemplate({
      shop: auth.shop,
      user: auth.userId,
      template: { ...(req.body || {}), id: req.params.id },
    });
    if (!template) return res.status(404).json({ success: false, error: 'Instruction not found' });
    return res.json({ success: true, template });
  } catch (err) {
    console.error('Error in PUT /api/maintenance/templates/:id:', err);
    return sendRouteError(res, err);
  }
});

router.post('/api/maintenance/templates/:id/archive', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const template = maintenanceStore.archiveTemplate({ shop: auth.shop, id: req.params.id });
    if (!template) return res.status(404).json({ success: false, error: 'Instruction not found' });
    return res.json({ success: true, template });
  } catch (err) {
    console.error('Error in POST /api/maintenance/templates/:id/archive:', err);
    return sendRouteError(res, err);
  }
});

router.post('/api/maintenance/templates/:id/duplicate', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const template = maintenanceStore.duplicateTemplate({ shop: auth.shop, id: req.params.id, user: auth.userId });
    if (!template) return res.status(404).json({ success: false, error: 'Instruction not found' });
    return res.json({ success: true, template });
  } catch (err) {
    console.error('Error in POST /api/maintenance/templates/:id/duplicate:', err);
    return sendRouteError(res, err);
  }
});

router.post('/api/maintenance/scheduled/clear-overdue-daily', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const result = maintenanceService.clearOverdueDailyMaintenance({
      shop: auth.shop,
      beforeDate: req.body?.beforeDate || req.body?.date,
      user: auth.userId,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('Error in POST /api/maintenance/scheduled/clear-overdue-daily:', err);
    return sendRouteError(res, err, 'Failed to clear overdue daily maintenance');
  }
});

router.get('/api/maintenance/scheduled/:id', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res);
    if (!auth) return;
    const instance = maintenanceStore.getScheduledInstance({ shop: auth.shop, id: req.params.id });
    if (!instance) return res.status(404).json({ success: false, error: 'Scheduled maintenance not found' });
    return res.json({ success: true, instance });
  } catch (err) {
    console.error('Error in GET /api/maintenance/scheduled/:id:', err);
    return sendRouteError(res, err);
  }
});

router.post('/api/maintenance/scheduled/:id/complete', async (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const result = await maintenanceService.completeScheduledMaintenance({
      shop: auth.shop,
      id: req.params.id,
      user: auth.userId,
      payload: req.body || {},
    });
    if (!result) return res.status(404).json({ success: false, error: 'Scheduled maintenance not found' });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('Error in POST /api/maintenance/scheduled/:id/complete:', err);
    return sendRouteError(res, err, 'Failed to complete maintenance');
  }
});

router.post('/api/maintenance/scheduled/:id/skip', async (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const result = await maintenanceService.skipScheduledMaintenance({
      shop: auth.shop,
      id: req.params.id,
      user: auth.userId,
      payload: req.body || {},
    });
    if (!result) return res.status(404).json({ success: false, error: 'Scheduled maintenance not found' });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('Error in POST /api/maintenance/scheduled/:id/skip:', err);
    return sendRouteError(res, err, 'Failed to skip maintenance');
  }
});

router.post('/api/maintenance/faults', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const fault = maintenanceStore.createFault({
      shop: auth.shop,
      user: auth.userId,
      fault: req.body || {},
    });
    return res.json({
      success: true,
      fault,
      events: fault ? maintenanceStore.listFaultEvents({ shop: auth.shop, faultId: fault.id }) : [],
    });
  } catch (err) {
    console.error('Error in POST /api/maintenance/faults:', err);
    return sendRouteError(res, err);
  }
});

router.put('/api/maintenance/faults/:id', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const fault = maintenanceStore.updateFault({
      shop: auth.shop,
      id: req.params.id,
      user: auth.userId,
      patch: req.body || {},
    });
    if (!fault) return res.status(404).json({ success: false, error: 'Fault not found' });
    return res.json({
      success: true,
      fault,
      events: maintenanceStore.listFaultEvents({ shop: auth.shop, faultId: fault.id }),
    });
  } catch (err) {
    console.error('Error in PUT /api/maintenance/faults/:id:', err);
    return sendRouteError(res, err);
  }
});

router.get('/api/maintenance/faults/:id/events', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res);
    if (!auth) return;
    return res.json({
      success: true,
      events: maintenanceStore.listFaultEvents({ shop: auth.shop, faultId: req.params.id }),
    });
  } catch (err) {
    console.error('Error in GET /api/maintenance/faults/:id/events:', err);
    return sendRouteError(res, err);
  }
});

router.post('/api/maintenance/faults/:id/corrective', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const fault = maintenanceStore.getFault({ shop: auth.shop, id: req.params.id });
    if (!fault) return res.status(404).json({ success: false, error: 'Fault not found' });
    const task = maintenanceStore.createCorrectiveTask({
      shop: auth.shop,
      user: auth.userId,
      task: {
        ...(req.body || {}),
        faultId: fault.id,
        assetId: req.body?.assetId || fault.assetId,
      },
    });
    return res.json({ success: true, correctiveTask: task });
  } catch (err) {
    console.error('Error in POST /api/maintenance/faults/:id/corrective:', err);
    return sendRouteError(res, err);
  }
});

router.post('/api/maintenance/corrective/:id/complete', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const task = maintenanceStore.completeCorrectiveTask({
      shop: auth.shop,
      id: req.params.id,
      user: auth.userId,
      payload: req.body || {},
    });
    if (!task) return res.status(404).json({ success: false, error: 'Corrective maintenance not found' });
    return res.json({ success: true, correctiveTask: task });
  } catch (err) {
    console.error('Error in POST /api/maintenance/corrective/:id/complete:', err);
    return sendRouteError(res, err);
  }
});

router.put('/api/maintenance/settings/notifications', (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const settings = maintenanceStore.saveNotificationSettings({
      shop: auth.shop,
      user: auth.userId,
      settings: req.body || {},
    });
    return res.json({ success: true, notificationSettings: settings });
  } catch (err) {
    console.error('Error in PUT /api/maintenance/settings/notifications:', err);
    return sendRouteError(res, err);
  }
});

router.post('/api/maintenance/settings/notifications/test', async (req, res) => {
  try {
    const auth = resolveMaintenanceAuth(req, res, { requireUser: true });
    if (!auth) return;
    const result = await maintenanceService.testGoogleChatWebhook({
      shop: auth.shop,
      message: req.body?.message,
    });
    return res.json({ success: true, result });
  } catch (err) {
    console.error('Error in POST /api/maintenance/settings/notifications/test:', err);
    return sendRouteError(res, err, 'Failed to send test notification');
  }
});

module.exports = router;
