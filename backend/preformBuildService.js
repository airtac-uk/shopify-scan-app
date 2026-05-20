const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { normalizeSku } = require('./pickListService');

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DEFAULT_DOWNLOAD_ROOT = path.resolve(__dirname, './tmp/preform-builds');

let cachedDriveToken = null;

function sanitizeFilePart(value, fallback = 'file') {
  const sanitized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || fallback;
}

function escapeDriveQueryValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function parseJsonishEnv(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (err) {
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch (base64Err) {
      return null;
    }
  }
}

function getServiceAccountCredentials() {
  const inlineJson = parseJsonishEnv(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON)
    || parseJsonishEnv(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (inlineJson?.client_email && inlineJson?.private_key) {
    return inlineJson;
  }

  const credentialsPath = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (credentialsPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
      if (parsed?.client_email && parsed?.private_key) return parsed;
    } catch (err) {
      throw new Error(`Failed to read GOOGLE_APPLICATION_CREDENTIALS: ${err.message}`);
    }
  }

  const clientEmail = String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const privateKey = String(process.env.GOOGLE_PRIVATE_KEY || process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '')
    .replace(/\\n/g, '\n')
    .trim();
  if (clientEmail && privateKey) {
    return {
      client_email: clientEmail,
      private_key: privateKey,
    };
  }

  return null;
}

async function getDriveAccessToken() {
  const explicitToken = String(process.env.GOOGLE_DRIVE_ACCESS_TOKEN || '').trim();
  if (explicitToken) return explicitToken;

  if (cachedDriveToken && cachedDriveToken.expiresAt > Date.now() + 60000) {
    return cachedDriveToken.accessToken;
  }

  const credentials = getServiceAccountCredentials();
  if (!credentials) return '';

  const nowSeconds = Math.floor(Date.now() / 1000);
  const assertionHeader = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const assertionPayload = base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: DRIVE_READ_SCOPE,
    aud: DRIVE_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }));
  const unsignedAssertion = `${assertionHeader}.${assertionPayload}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(unsignedAssertion)
    .sign(credentials.private_key, 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const response = await fetch(DRIVE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsignedAssertion}.${signature}`,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Failed to authenticate with Google Drive');
  }

  cachedDriveToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Math.max(60, Number(data.expires_in) || 3600) * 1000),
  };

  return cachedDriveToken.accessToken;
}

async function driveFetch(url, options = {}) {
  const accessToken = await getDriveAccessToken();
  const apiKey = String(process.env.GOOGLE_DRIVE_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  const requestUrl = new URL(url);

  if (!accessToken && apiKey) {
    requestUrl.searchParams.set('key', apiKey);
  }

  const headers = {
    ...(options.headers || {}),
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  if (!accessToken && !apiKey) {
    throw new Error('Google Drive access is not configured. Set GOOGLE_DRIVE_API_KEY/GOOGLE_API_KEY or service-account credentials.');
  }

  const response = await fetch(requestUrl.toString(), {
    ...options,
    headers,
  });

  return response;
}

function getDriveFolderIds() {
  return String(process.env.PRINT_STL_DRIVE_FOLDER_IDS || process.env.PRINT_STL_DRIVE_FOLDER_ID || '')
    .split(',')
    .map((folderId) => folderId.trim())
    .filter(Boolean);
}

function getAllowedExtensions() {
  return String(process.env.PRINT_STL_EXTENSIONS || 'stl,3mf')
    .split(',')
    .map((ext) => ext.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);
}

function getFileExtension(name) {
  return path.extname(String(name || '')).replace(/^\./, '').toLowerCase();
}

function getFileStem(name) {
  return String(name || '').replace(/\.[^.]+$/, '').trim();
}

function compactName(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function scoreDriveFileForSku(file, sku, allowedExtensions) {
  const extension = getFileExtension(file?.name);
  if (!allowedExtensions.includes(extension)) return -1;

  const skuText = normalizeSku(sku);
  const compactSku = compactName(skuText);
  const name = String(file?.name || '').trim().toUpperCase();
  const stem = getFileStem(name);
  const compactStem = compactName(stem);

  if (compactStem === compactSku) return 100;
  if (compactStem.startsWith(`${compactSku}V`)) return 85;
  if (compactStem.startsWith(compactSku)) return 70;
  if (compactStem.includes(compactSku)) return 45;
  return -1;
}

async function listDriveFilesForSku(sku) {
  const normalizedSku = normalizeSku(sku);
  const folderIds = getDriveFolderIds();
  const qParts = ['trashed = false', `name contains '${escapeDriveQueryValue(normalizedSku)}'`];

  if (folderIds.length > 0) {
    qParts.push(`(${folderIds.map((folderId) => `'${escapeDriveQueryValue(folderId)}' in parents`).join(' or ')})`);
  }

  const url = new URL(`${DRIVE_API_BASE}/files`);
  url.searchParams.set('q', qParts.join(' and '));
  url.searchParams.set('fields', 'files(id,name,mimeType,size,modifiedTime,webViewLink,webContentLink)');
  url.searchParams.set('pageSize', '50');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  url.searchParams.set('corpora', 'allDrives');

  const response = await driveFetch(url.toString());
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `Google Drive search failed (${response.status})`);
  }

  return Array.isArray(data.files) ? data.files : [];
}

async function getDriveFileById(fileId) {
  const normalizedFileId = String(fileId || '').trim();
  if (!normalizedFileId) return null;

  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(normalizedFileId)}`);
  url.searchParams.set('fields', 'id,name,mimeType,size,modifiedTime,webViewLink,webContentLink');
  url.searchParams.set('supportsAllDrives', 'true');

  const response = await driveFetch(url.toString());
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `Google Drive file lookup failed (${response.status})`);
  }

  return data;
}

function extractDriveFileId(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  const patterns = [
    /\/file\/d\/([^/?#]+)/i,
    /[?&]id=([^&#]+)/i,
    /\/uc\?[^#]*id=([^&#]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }

  return '';
}

async function findDriveFileForSku(sku) {
  const allowedExtensions = getAllowedExtensions();
  const files = await listDriveFilesForSku(sku);
  const scoredFiles = files
    .map((file) => ({
      file,
      score: scoreDriveFileForSku(file, sku, allowedExtensions),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return String(right.file.modifiedTime || '').localeCompare(String(left.file.modifiedTime || ''));
    });

  return scoredFiles[0]?.file || null;
}

async function downloadDriveFile({ file, targetDir, label }) {
  if (!file?.id) throw new Error('Missing Google Drive file id');

  fs.mkdirSync(targetDir, { recursive: true });
  const localFileName = `${sanitizeFilePart(label)}__${sanitizeFilePart(file.name, 'model.stl')}`;
  const localPath = path.join(targetDir, localFileName);
  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}`);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');

  const response = await driveFetch(url.toString());
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to download ${file.name || file.id} (${response.status}): ${body}`);
  }

  const buffer = await response.buffer();
  fs.writeFileSync(localPath, buffer);

  return localPath;
}

function expandQueueItemToBuildParts(item) {
  const parts = [];
  const queueItemId = Number(item?.id);
  const sourceType = String(item?.sourceType || '').trim().toLowerCase();

  if (sourceType === 'catalog' && item?.sku) {
    parts.push({
      sourceType: 'catalog',
      sku: normalizeSku(item.sku),
      title: String(item.title || item.sku).trim(),
      typeRaw: String(item.typeRaw || '').trim(),
      quantity: Math.max(1, Number(item.quantity) || 1),
      queueItemIds: Number.isFinite(queueItemId) ? [queueItemId] : [],
    });
  }

  (Array.isArray(item?.childItems) ? item.childItems : []).forEach((childItem) => {
    const sku = normalizeSku(childItem?.sku);
    if (!sku) return;
    parts.push({
      sourceType: 'catalog',
      sku,
      title: String(childItem.title || sku).trim(),
      typeRaw: String(childItem.typeRaw || '').trim(),
      quantity: Math.max(1, Number(childItem.quantity) || 1),
      queueItemIds: Number.isFinite(queueItemId) ? [queueItemId] : [],
    });
  });

  if (sourceType === 'custom') {
    parts.push({
      sourceType: 'custom',
      sku: '',
      title: String(item.customFileName || item.title || `Custom ${queueItemId || ''}`).trim(),
      typeRaw: 'CUSTOM',
      quantity: Math.max(1, Number(item.quantity) || 1),
      customFileUrl: String(item.customFileUrl || '').trim(),
      queueItemIds: Number.isFinite(queueItemId) ? [queueItemId] : [],
    });
  }

  return parts;
}

function mergeBuildParts(parts) {
  const merged = new Map();

  parts.forEach((part) => {
    const key = part.sourceType === 'custom'
      ? `CUSTOM:${part.customFileUrl || part.title}`
      : `SKU:${part.sku}`;
    if (!merged.has(key)) {
      merged.set(key, {
        ...part,
        quantity: 0,
        queueItemIds: [],
      });
    }

    const existing = merged.get(key);
    existing.quantity += Math.max(1, Number(part.quantity) || 1);
    (part.queueItemIds || []).forEach((id) => {
      if (!existing.queueItemIds.includes(id)) existing.queueItemIds.push(id);
    });
  });

  return Array.from(merged.values());
}

function buildPreformScenePayload() {
  const rawPayload = parseJsonishEnv(process.env.PREFORM_SCENE_JSON);
  if (rawPayload && typeof rawPayload === 'object') return rawPayload;

  const machineType = String(process.env.PREFORM_MACHINE_TYPE || '').trim();
  const materialCode = String(process.env.PREFORM_MATERIAL_CODE || '').trim();
  const printSetting = String(process.env.PREFORM_PRINT_SETTING || '').trim();
  const layerThickness = Number(process.env.PREFORM_LAYER_THICKNESS_MM || 0);

  const missing = [];
  if (!machineType) missing.push('PREFORM_MACHINE_TYPE');
  if (!materialCode) missing.push('PREFORM_MATERIAL_CODE');
  if (!printSetting) missing.push('PREFORM_PRINT_SETTING');
  if (!layerThickness) missing.push('PREFORM_LAYER_THICKNESS_MM');
  if (missing.length > 0) {
    throw new Error(`PreFormServer is configured, but ${missing.join(', ')} is missing.`);
  }

  return {
    machine_type: machineType,
    material_code: materialCode,
    print_setting: printSetting,
    layer_thickness_mm: layerThickness,
  };
}

async function preformRequest(pathname, body) {
  const baseUrl = String(process.env.PREFORM_SERVER_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    return null;
  }

  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `PreFormServer request failed (${response.status})`);
  }
  return data;
}

async function createPreformBuild({ buildId, buildDir, parts }) {
  if (!String(process.env.PREFORM_SERVER_URL || '').trim()) {
    return null;
  }

  const scenePayload = buildPreformScenePayload();
  const scene = await preformRequest('/scene/', scenePayload);
  const sceneId = scene?.scene_id || scene?.id || scene?.sceneId;
  if (!sceneId) {
    throw new Error('PreFormServer did not return a scene id.');
  }

  let importedCount = 0;
  for (const part of parts) {
    for (let index = 0; index < Math.max(1, Number(part.quantity) || 1); index += 1) {
      importedCount += 1;
      await preformRequest(`/scene/${encodeURIComponent(sceneId)}/import-model/`, {
        file: part.localPath,
        repair_behavior: 'REPAIR',
        name: part.sku
          ? `${part.sku} ${index + 1}/${part.quantity}`
          : `${part.title} ${index + 1}/${part.quantity}`,
      });
    }
  }

  if (String(process.env.PREFORM_AUTO_PACK || '1').trim() !== '0') {
    await preformRequest(`/scene/${encodeURIComponent(sceneId)}/auto-pack/`, {
      model_spacing_mm: Number(process.env.PREFORM_MODEL_SPACING_MM || 0),
    });
  }

  if (String(process.env.PREFORM_PACK_AND_CAGE || '').trim() === '1') {
    await preformRequest('/scene/pack-and-cage/', {
      models: 'ALL',
      packing_type: {
        packing_type: String(process.env.PREFORM_PACKING_TYPE || 'PACK_NORMAL').trim(),
      },
      cage_label: String(process.env.PREFORM_CAGE_LABEL || buildId).trim(),
      generate_mesh_label: String(process.env.PREFORM_GENERATE_MESH_LABEL || '1').trim() !== '0',
      model_spacing_mm: Number(process.env.PREFORM_MODEL_SPACING_MM || 0),
      bar_spacing_mm: Number(process.env.PREFORM_CAGE_BAR_SPACING_MM || 0),
      bar_thickness_mm: Number(process.env.PREFORM_CAGE_BAR_THICKNESS_MM || 1),
      bar_width_mm: Number(process.env.PREFORM_CAGE_BAR_WIDTH_MM || 1),
      distance_to_cage_mm: Number(process.env.PREFORM_CAGE_DISTANCE_MM || 0),
      enable_round_edges: String(process.env.PREFORM_CAGE_ROUND_EDGES || '').trim() === '1',
      enable_square_bars: String(process.env.PREFORM_CAGE_SQUARE_BARS || '1').trim() !== '0',
    });
  }

  const formDir = path.resolve(process.env.PREFORM_OUTPUT_DIR || buildDir);
  fs.mkdirSync(formDir, { recursive: true });
  const formFilePath = path.join(formDir, `${buildId}.form`);
  await preformRequest(`/scene/${encodeURIComponent(sceneId)}/save-form/?async=false`, {
    file: formFilePath,
  });

  return {
    sceneId,
    importedCount,
    formFilePath,
  };
}

async function preparePreformBuildFromQueueItems(items) {
  const needsPrintedItems = (Array.isArray(items) ? items : [])
    .filter((item) => String(item?.stageKey || '').trim() === 'needs_printed');
  const buildId = `sls-build-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const buildRoot = path.resolve(process.env.PRINT_STL_DOWNLOAD_DIR || DEFAULT_DOWNLOAD_ROOT);
  const buildDir = path.join(buildRoot, buildId);
  fs.mkdirSync(buildDir, { recursive: true });

  const buildParts = mergeBuildParts(needsPrintedItems.flatMap(expandQueueItemToBuildParts));
  const resolvedParts = [];
  const missingFiles = [];
  const skippedCustomItems = [];

  for (const part of buildParts) {
    try {
      let file = null;
      if (part.sourceType === 'custom') {
        const driveFileId = extractDriveFileId(part.customFileUrl);
        if (!driveFileId) {
          skippedCustomItems.push({
            title: part.title,
            quantity: part.quantity,
            reason: 'Custom job does not have a Google Drive file link.',
          });
          continue;
        }
        file = await getDriveFileById(driveFileId);
      } else {
        file = await findDriveFileForSku(part.sku);
      }

      if (!file) {
        missingFiles.push({
          sku: part.sku,
          title: part.title,
          quantity: part.quantity,
          reason: 'No matching STL/3MF file found in Google Drive.',
        });
        continue;
      }

      const localPath = await downloadDriveFile({
        file,
        targetDir: buildDir,
        label: part.sku || part.title,
      });

      resolvedParts.push({
        ...part,
        driveFileId: file.id,
        driveFileName: file.name,
        driveWebViewLink: file.webViewLink || '',
        localPath,
      });
    } catch (err) {
      missingFiles.push({
        sku: part.sku,
        title: part.title,
        quantity: part.quantity,
        reason: err.message || 'Failed to resolve model file.',
      });
    }
  }

  const manifest = {
    buildId,
    createdAt: new Date().toISOString(),
    buildDir,
    sourceStage: 'needs_printed',
    queueItemCount: needsPrintedItems.length,
    requestedPartCount: buildParts.length,
    resolvedPartCount: resolvedParts.length,
    modelInstanceCount: resolvedParts.reduce((sum, part) => sum + Math.max(1, Number(part.quantity) || 1), 0),
    queueItemIds: Array.from(new Set(resolvedParts.flatMap((part) => part.queueItemIds || []))),
    parts: resolvedParts,
    missingFiles,
    skippedCustomItems,
  };

  const manifestPath = path.join(buildDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  let preform = null;
  if (resolvedParts.length > 0 && missingFiles.length === 0 && skippedCustomItems.length === 0) {
    preform = await createPreformBuild({
      buildId,
      buildDir,
      parts: resolvedParts,
    });
  }

  return {
    manifest,
    manifestPath,
    preform,
    mode: preform ? 'preform' : 'manifest',
  };
}

module.exports = {
  preparePreformBuildFromQueueItems,
};
