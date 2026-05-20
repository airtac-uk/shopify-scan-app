const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { normalizeSku } = require('./pickListService');

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DEFAULT_DOWNLOAD_ROOT = path.resolve(__dirname, './tmp/preform-builds');
const PREFORM_BUILD_DIR_PREFIX = 'sls-build-';
const DEFAULT_PREFORM_BUILD_RETENTION_HOURS = 0;
const DEFAULT_PREFORM_BUILD_MAX_DIRS = 0;
const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const DEFAULT_FUSE_BUILD_VOLUME_ML = 165 * 165 * 300 / 1000;
const DEFAULT_PREFORM_MODEL_SPACING_MM = 4;
const DEFAULT_PREFORM_WALL_SPACING_MM = 4;
const PREFORM_LOG_PREFIX = '[PreForm]';

let cachedDriveToken = null;

function sanitizeFilePart(value, fallback = 'file') {
  const sanitized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || fallback;
}

function getPositiveEnvNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getNonNegativeEnvNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isPreformLoggingEnabled() {
  return String(process.env.PREFORM_VERBOSE_LOGS || '1').trim() !== '0';
}

function formatPreformNumber(value, precision = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return number.toFixed(precision);
}

function formatPreformDensity(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return `${Math.round(number * 1000) / 10}%`;
}

function preformLog(message, details = null) {
  if (!isPreformLoggingEnabled()) return;
  if (details && typeof details === 'object') {
    console.info(`${PREFORM_LOG_PREFIX} ${message}`, details);
    return;
  }
  console.info(`${PREFORM_LOG_PREFIX} ${message}`);
}

function isPreformFullResponseLoggingEnabled() {
  return String(process.env.PREFORM_LOG_FULL_RESPONSES || '1').trim() !== '0';
}

function logPreformFullResponse({ method, pathname, status, ok, requestBody = null, responseBody = null }) {
  if (!isPreformFullResponseLoggingEnabled()) return;

  console.info(`${PREFORM_LOG_PREFIX} Full ${method} response ${pathname} (${status}${ok ? ' OK' : ' ERROR'})`);
  if (requestBody !== null) {
    console.info(`${PREFORM_LOG_PREFIX} Request body for ${method} ${pathname}:`);
    console.dir(requestBody, { depth: null, maxArrayLength: null, colors: false });
  }
  console.info(`${PREFORM_LOG_PREFIX} Response body for ${method} ${pathname}:`);
  console.dir(responseBody, { depth: null, maxArrayLength: null, colors: false });
}

function removePreformBuildDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (err) {
    console.warn(`Failed to clean PreForm build directory ${dirPath}:`, err.message || err);
  }
}

function cleanupPreformBuildRoot(buildRoot) {
  const normalizedBuildRoot = path.resolve(buildRoot || DEFAULT_DOWNLOAD_ROOT);
  if (!fs.existsSync(normalizedBuildRoot)) return;

  const retentionHours = getNonNegativeEnvNumber(
    'PREFORM_BUILD_RETENTION_HOURS',
    DEFAULT_PREFORM_BUILD_RETENTION_HOURS
  );
  const maxBuildDirs = Math.floor(getNonNegativeEnvNumber(
    'PREFORM_BUILD_MAX_DIRS',
    DEFAULT_PREFORM_BUILD_MAX_DIRS
  ));
  if (retentionHours <= 0 && maxBuildDirs <= 0) {
    preformLog('Build artifact cleanup disabled; generated build download links will not expire automatically.', {
      buildRoot: normalizedBuildRoot,
    });
    return;
  }

  const cutoffMs = Date.now() - (retentionHours * 60 * 60 * 1000);
  const buildDirs = fs.readdirSync(normalizedBuildRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(PREFORM_BUILD_DIR_PREFIX))
    .map((entry) => {
      const dirPath = path.join(normalizedBuildRoot, entry.name);
      const stats = fs.statSync(dirPath);
      return {
        dirPath,
        mtimeMs: Number(stats.mtimeMs) || 0,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  const retainedDirs = [];
  buildDirs.forEach((entry) => {
    if (retentionHours > 0 && entry.mtimeMs > 0 && entry.mtimeMs < cutoffMs) {
      preformLog('Removing expired build artifact directory.', { dirPath: entry.dirPath, retentionHours });
      removePreformBuildDir(entry.dirPath);
    } else {
      retainedDirs.push(entry);
    }
  });

  if (maxBuildDirs > 0) {
    retainedDirs.slice(maxBuildDirs).forEach((entry) => {
      preformLog('Removing old build artifact directory over max retained build count.', {
        dirPath: entry.dirPath,
        maxBuildDirs,
      });
      removePreformBuildDir(entry.dirPath);
    });
  }
}

function normalizePreformBuildId(value) {
  const buildId = String(value || '').trim();
  if (!buildId.startsWith(PREFORM_BUILD_DIR_PREFIX)) return '';
  return /^[A-Za-z0-9._-]+$/.test(buildId) ? buildId : '';
}

function resolvePreformBuildArtifact(buildId, artifact) {
  const normalizedBuildId = normalizePreformBuildId(buildId);
  if (!normalizedBuildId) return null;

  const normalizedArtifact = String(artifact || '').trim().toLowerCase();
  const buildRoot = path.resolve(process.env.PRINT_STL_DOWNLOAD_DIR || DEFAULT_DOWNLOAD_ROOT);
  const buildDir = path.resolve(buildRoot, normalizedBuildId);
  const safeBuildPrefix = `${buildRoot}${path.sep}`;
  if (buildDir !== buildRoot && !buildDir.startsWith(safeBuildPrefix)) return null;

  if (normalizedArtifact === 'manifest') {
    return {
      buildId: normalizedBuildId,
      artifact: 'manifest',
      filePath: path.join(buildDir, 'manifest.json'),
      filename: `${normalizedBuildId}-manifest.json`,
      contentType: 'application/json',
    };
  }

  if (normalizedArtifact === 'form' || normalizedArtifact === 'build') {
    const formDir = path.resolve(process.env.PREFORM_OUTPUT_DIR || buildDir);
    return {
      buildId: normalizedBuildId,
      artifact: 'form',
      filePath: path.join(formDir, `${normalizedBuildId}.form`),
      filename: `${normalizedBuildId}.form`,
      contentType: 'application/octet-stream',
    };
  }

  return null;
}

function getPreformBuildManifestPath(buildId) {
  const normalizedBuildId = normalizePreformBuildId(buildId);
  if (!normalizedBuildId) return '';

  const buildRoot = path.resolve(process.env.PRINT_STL_DOWNLOAD_DIR || DEFAULT_DOWNLOAD_ROOT);
  return path.join(buildRoot, normalizedBuildId, 'manifest.json');
}

function readPreformBuildManifest(buildId) {
  const manifestPath = getPreformBuildManifestPath(buildId);
  if (!manifestPath || !fs.existsSync(manifestPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.warn(`Failed to read PreForm build manifest ${manifestPath}:`, err.message || err);
    return null;
  }
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

function getDriveFolderIds(settings = {}) {
  const savedFolderIds = Array.isArray(settings.driveFolderIds)
    ? settings.driveFolderIds.map((folderId) => String(folderId || '').trim()).filter(Boolean)
    : [];
  if (savedFolderIds.length > 0) return savedFolderIds;

  return String(process.env.PRINT_STL_DRIVE_FOLDER_IDS || process.env.PRINT_STL_DRIVE_FOLDER_ID || '')
    .split(',')
    .map((folderId) => folderId.trim())
    .filter(Boolean);
}

function getAllowedExtensions(settings = {}) {
  return String(settings.stlExtensions || process.env.PRINT_STL_EXTENSIONS || 'stl,3mf')
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

  if (stem === skuText) return 120;
  if (compactStem === compactSku) return 100;
  return -1;
}

function scoreDrivePdfForSku(file, sku) {
  const extension = getFileExtension(file?.name);
  if (extension !== 'pdf') return -1;

  const skuText = normalizeSku(sku);
  const compactSku = compactName(skuText);
  const name = String(file?.name || '').trim().toUpperCase();
  const stem = getFileStem(name);
  const compactStem = compactName(stem);

  if (stem === skuText) return 120;
  if (compactStem === compactSku) return 100;
  return -1;
}

function getSafeDriveUrlForError(url) {
  const safeUrl = new URL(url);
  safeUrl.searchParams.delete('key');
  return safeUrl.toString();
}

function formatDriveApiError({ response, data, url, query }) {
  const error = data?.error || {};
  const details = Array.isArray(error.errors)
    ? error.errors.map((entry) => entry.message || entry.reason).filter(Boolean).join('; ')
    : '';
  const message = error.message || details || response.statusText || `HTTP ${response.status}`;
  return [
    `Google Drive search failed (${response.status}): ${message}`,
    query ? `Query: ${query}` : '',
    url ? `URL: ${getSafeDriveUrlForError(url)}` : '',
  ].filter(Boolean).join(' | ');
}

async function runDriveFilesSearch(url, query) {
  const response = await driveFetch(url.toString());
  const data = await response.json().catch(() => ({}));
  if (response.ok) {
    return Array.isArray(data.files) ? data.files : [];
  }

  return {
    error: formatDriveApiError({
      response,
      data,
      url: url.toString(),
      query,
    }),
    status: response.status,
  };
}

async function runDriveFilesSearchPage(url, query) {
  const response = await driveFetch(url.toString());
  const data = await response.json().catch(() => ({}));
  if (response.ok) {
    return {
      files: Array.isArray(data.files) ? data.files : [],
      nextPageToken: String(data.nextPageToken || ''),
    };
  }

  return {
    error: formatDriveApiError({
      response,
      data,
      url: url.toString(),
      query,
    }),
    status: response.status,
  };
}

async function listDriveFilesByQuery(query, { fields, pageSize = 100 } = {}) {
  const fileFields = fields || 'id,name,mimeType,size,modifiedTime,webViewLink,webContentLink,parents';
  const files = [];
  let pageToken = '';
  let useAllDrives = true;

  do {
    const url = new URL(`${DRIVE_API_BASE}/files`);
    url.searchParams.set('q', query);
    url.searchParams.set('fields', `nextPageToken,files(${fileFields})`);
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    if (useAllDrives) {
      url.searchParams.set('supportsAllDrives', 'true');
      url.searchParams.set('includeItemsFromAllDrives', 'true');
    }

    const result = await runDriveFilesSearchPage(url, query);
    if (!result.error) {
      files.push(...result.files);
      pageToken = result.nextPageToken;
      continue;
    }

    if (useAllDrives && result.status === 400) {
      useAllDrives = false;
      pageToken = '';
      files.length = 0;
      continue;
    }

    throw new Error(result.error);
  } while (pageToken);

  return files;
}

async function listDriveFilesForSku(sku, settings = {}) {
  const normalizedSku = normalizeSku(sku);
  const folderIds = getDriveFolderIds(settings);
  const qParts = ['trashed = false', `name contains '${escapeDriveQueryValue(normalizedSku)}'`];

  if (folderIds.length > 0) {
    const parentClause = folderIds.map((folderId) => `'${escapeDriveQueryValue(folderId)}' in parents`).join(' or ');
    qParts.push(folderIds.length === 1 ? parentClause : `(${parentClause})`);
  }

  const query = qParts.join(' and ');
  const url = new URL(`${DRIVE_API_BASE}/files`);
  url.searchParams.set('q', query);
  url.searchParams.set('fields', 'files(id,name,mimeType,size,modifiedTime,webViewLink,webContentLink)');
  url.searchParams.set('pageSize', '50');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');

  const firstResult = await runDriveFilesSearch(url, query);
  if (Array.isArray(firstResult)) {
    return firstResult;
  }

  if (firstResult.status !== 400) {
    throw new Error(firstResult.error);
  }

  const fallbackUrl = new URL(`${DRIVE_API_BASE}/files`);
  fallbackUrl.searchParams.set('q', query);
  fallbackUrl.searchParams.set('fields', 'files(id,name,mimeType,size,modifiedTime,webViewLink,webContentLink)');
  fallbackUrl.searchParams.set('pageSize', '50');

  const fallbackResult = await runDriveFilesSearch(fallbackUrl, query);
  if (Array.isArray(fallbackResult)) {
    return fallbackResult;
  }

  throw new Error(fallbackResult.error || firstResult.error);
}

async function listDrivePdfFilesForSku(sku) {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku) return [];

  const query = [
    'trashed = false',
    `name contains '${escapeDriveQueryValue(normalizedSku)}'`,
    "mimeType = 'application/pdf'",
  ].join(' and ');

  return listDriveFilesByQuery(query, {
    fields: 'id,name,mimeType,size,modifiedTime,webViewLink,webContentLink,parents',
    pageSize: 100,
  });
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

async function getDriveFileMetadata(fileId, { fields = 'id,name,mimeType,parents' } = {}) {
  const normalizedFileId = String(fileId || '').trim();
  if (!normalizedFileId) return null;

  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(normalizedFileId)}`);
  url.searchParams.set('fields', fields);
  url.searchParams.set('supportsAllDrives', 'true');

  const response = await driveFetch(url.toString());
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `Google Drive file metadata lookup failed (${response.status})`);
  }

  return data;
}

async function isDriveFileInsideFolders(file, rootFolderIds, metadataCache = new Map()) {
  const roots = new Set((Array.isArray(rootFolderIds) ? rootFolderIds : [])
    .map((folderId) => String(folderId || '').trim())
    .filter(Boolean));
  if (roots.size === 0) return true;

  const pendingParentIds = [...(Array.isArray(file?.parents) ? file.parents : [])]
    .map((folderId) => String(folderId || '').trim())
    .filter(Boolean);
  const visited = new Set();

  while (pendingParentIds.length > 0) {
    const parentId = pendingParentIds.pop();
    if (!parentId || visited.has(parentId)) continue;
    if (roots.has(parentId)) return true;
    visited.add(parentId);

    try {
      if (!metadataCache.has(parentId)) {
        metadataCache.set(parentId, await getDriveFileMetadata(parentId));
      }
      const parent = metadataCache.get(parentId);
      if (parent?.mimeType !== DRIVE_FOLDER_MIME_TYPE) continue;
      (Array.isArray(parent.parents) ? parent.parents : []).forEach((nextParentId) => {
        if (nextParentId && !visited.has(String(nextParentId))) {
          pendingParentIds.push(String(nextParentId));
        }
      });
    } catch (err) {
      console.warn(`Failed to inspect Google Drive parent ${parentId}:`, err.message || err);
    }
  }

  return false;
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

async function findDriveFileForSku(sku, settings = {}) {
  const allowedExtensions = getAllowedExtensions(settings);
  const files = await listDriveFilesForSku(sku, settings);
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

async function getDriveModelFileForSku(sku, settings = {}) {
  return findDriveFileForSku(sku, settings);
}

async function findDriveQcPdfForSku(sku, settings = {}) {
  const files = await listDrivePdfFilesForSku(sku);
  const rootFolderIds = getDriveFolderIds(settings);
  const metadataCache = new Map();
  const eligibleFiles = [];

  for (const file of files) {
    if (scoreDrivePdfForSku(file, sku) < 0) continue;
    if (await isDriveFileInsideFolders(file, rootFolderIds, metadataCache)) {
      eligibleFiles.push(file);
    }
  }

  const scoredFiles = eligibleFiles
    .map((file) => ({
      file,
      score: scoreDrivePdfForSku(file, sku),
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

async function openDriveModelFileStreamForSku(sku, settings = {}) {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku) return null;

  const file = await findDriveFileForSku(normalizedSku, settings);
  if (!file) return null;

  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}`);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');

  const response = await driveFetch(url.toString());
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to download ${file.name || normalizedSku} (${response.status}): ${body}`);
  }

  return {
    file,
    response,
  };
}

async function openDriveQcPdfStreamForSku(sku, settings = {}) {
  const normalizedSku = normalizeSku(sku);
  if (!normalizedSku) return null;

  const file = await findDriveQcPdfForSku(normalizedSku, settings);
  if (!file) return null;

  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}`);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');

  const response = await driveFetch(url.toString());
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to download ${file.name || `${normalizedSku}.pdf`} (${response.status}): ${body}`);
  }

  return {
    file,
    response,
  };
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

function normalizePreformOrientation(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x || 0);
  const y = Number(value.y || 0);
  const z = Number(value.z || 0);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    z: Number.isFinite(z) ? z : 0,
  };
}

function quaternionFromEulerOrientation(orientation) {
  const normalized = normalizePreformOrientation(orientation);
  if (!normalized) return null;

  const c1 = Math.cos(normalized.x / 2);
  const c2 = Math.cos(normalized.y / 2);
  const c3 = Math.cos(normalized.z / 2);
  const s1 = Math.sin(normalized.x / 2);
  const s2 = Math.sin(normalized.y / 2);
  const s3 = Math.sin(normalized.z / 2);

  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

function rotateVectorByQuaternion(vector, quaternion) {
  const x = Number(vector?.x || 0);
  const y = Number(vector?.y || 0);
  const z = Number(vector?.z || 0);
  const qx = quaternion.x;
  const qy = quaternion.y;
  const qz = quaternion.z;
  const qw = quaternion.w;

  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;

  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}

function normalizeVector(vector) {
  const length = Math.sqrt((vector.x ** 2) + (vector.y ** 2) + (vector.z ** 2));
  if (!Number.isFinite(length) || length <= 0) return vector;
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function looksLikeBinaryStl(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 84) return false;
  const triangleCount = buffer.readUInt32LE(80);
  const expectedLength = 84 + triangleCount * 50;
  if (expectedLength === buffer.length) return true;

  const prefix = buffer.subarray(0, 5).toString('utf8').toLowerCase();
  if (prefix === 'solid') return false;

  return expectedLength > 84 && expectedLength <= buffer.length;
}

function readBinaryStlVector(buffer, offset) {
  return {
    x: buffer.readFloatLE(offset),
    y: buffer.readFloatLE(offset + 4),
    z: buffer.readFloatLE(offset + 8),
  };
}

function writeBinaryStlVector(buffer, offset, vector) {
  buffer.writeFloatLE(Number.isFinite(vector.x) ? vector.x : 0, offset);
  buffer.writeFloatLE(Number.isFinite(vector.y) ? vector.y : 0, offset + 4);
  buffer.writeFloatLE(Number.isFinite(vector.z) ? vector.z : 0, offset + 8);
}

function transformBinaryStlBuffer(buffer, quaternion) {
  const transformed = Buffer.from(buffer);
  const triangleCount = transformed.readUInt32LE(80);
  const maxTriangles = Math.floor((transformed.length - 84) / 50);
  const safeTriangleCount = Math.min(triangleCount, maxTriangles);

  for (let triangleIndex = 0; triangleIndex < safeTriangleCount; triangleIndex += 1) {
    const baseOffset = 84 + triangleIndex * 50;
    const normal = normalizeVector(rotateVectorByQuaternion(readBinaryStlVector(transformed, baseOffset), quaternion));
    writeBinaryStlVector(transformed, baseOffset, normal);

    [12, 24, 36].forEach((vertexOffset) => {
      const rotatedVertex = rotateVectorByQuaternion(
        readBinaryStlVector(transformed, baseOffset + vertexOffset),
        quaternion
      );
      writeBinaryStlVector(transformed, baseOffset + vertexOffset, rotatedVertex);
    });
  }

  return transformed;
}

function formatStlNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) < 1e-9) return '0';
  return Number(number.toFixed(6)).toString();
}

function transformAsciiStlBuffer(buffer, quaternion) {
  const numberPattern = '([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?)';
  const stlLinePattern = new RegExp(
    `\\b(facet\\s+normal|vertex)\\s+${numberPattern}\\s+${numberPattern}\\s+${numberPattern}`,
    'gi'
  );
  const text = buffer.toString('utf8');
  const transformed = text.replace(stlLinePattern, (match, label, x, y, z) => {
    let vector = rotateVectorByQuaternion({ x, y, z }, quaternion);
    if (/normal/i.test(label)) vector = normalizeVector(vector);
    return `${label} ${formatStlNumber(vector.x)} ${formatStlNumber(vector.y)} ${formatStlNumber(vector.z)}`;
  });

  return Buffer.from(transformed, 'utf8');
}

function transformStlBufferOrientation(buffer, orientation) {
  const sourceBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const quaternion = quaternionFromEulerOrientation(orientation);
  if (!quaternion || sourceBuffer.length === 0) return sourceBuffer;

  if (looksLikeBinaryStl(sourceBuffer)) {
    return transformBinaryStlBuffer(sourceBuffer, quaternion);
  }

  return transformAsciiStlBuffer(sourceBuffer, quaternion);
}

function radiansToDegrees(value) {
  const radians = Number(value || 0);
  return Number.isFinite(radians) ? radians * 180 / Math.PI : 0;
}

function toPreformEulerDegrees(orientation) {
  const normalized = normalizePreformOrientation(orientation);
  if (!normalized) return null;
  return {
    x: radiansToDegrees(normalized.x),
    y: radiansToDegrees(normalized.y),
    z: radiansToDegrees(normalized.z),
  };
}

function getMatchingPartOrientation({ part, file, settings = {} }) {
  if (!part?.sku || !file?.id) return null;
  const orientations = settings.partOrientations && typeof settings.partOrientations === 'object'
    ? settings.partOrientations
    : {};
  const record = orientations[normalizeSku(part.sku)];
  if (!record?.orientation) return null;

  const storedFileId = String(record.driveFileId || '').trim();
  const storedModifiedTime = String(record.driveModifiedTime || '').trim();
  if (storedFileId && storedFileId !== String(file.id || '').trim()) return null;
  if (storedModifiedTime && storedModifiedTime !== String(file.modifiedTime || '').trim()) return null;

  const orientation = normalizePreformOrientation(record.orientation);
  if (!orientation) return null;

  return {
    orientation,
    lockMode: String(record.lockMode || 'LOCKED_XY_ROTATION_FREE_TRANSLATION').trim()
      || 'LOCKED_XY_ROTATION_FREE_TRANSLATION',
    updatedAt: record.updatedAt || null,
  };
}

function getEnvNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function getPreformPackingConfig() {
  const modelSpacingMm = getEnvNumber('PREFORM_MODEL_SPACING_MM', DEFAULT_PREFORM_MODEL_SPACING_MM);
  const wallSpacingMm = getEnvNumber('PREFORM_WALL_SPACING_MM', DEFAULT_PREFORM_WALL_SPACING_MM);
  const buildVolumeMl = getPositiveEnvNumber('PREFORM_BUILD_VOLUME_ML', DEFAULT_FUSE_BUILD_VOLUME_ML);

  return {
    modelSpacingMm: Math.max(0, modelSpacingMm),
    wallSpacingMm: Math.max(0, wallSpacingMm),
    buildVolumeMl,
  };
}

function expandPartsToModelJobs(parts) {
  const jobGroups = [];

  (Array.isArray(parts) ? parts : []).forEach((part) => {
    const quantity = Math.max(1, Number(part.quantity) || 1);
    const partJobs = [];
    for (let index = 0; index < quantity; index += 1) {
      partJobs.push({
        ...part,
        sourcePartQuantity: quantity,
        quantity: 1,
        instanceIndex: index + 1,
        instanceTotal: quantity,
        instanceName: part.sku
          ? `${part.sku} ${index + 1}/${quantity}`
          : `${part.title} ${index + 1}/${quantity}`,
      });
    }
    if (partJobs.length > 0) jobGroups.push(partJobs);
  });

  const jobs = [];
  const maxGroupLength = jobGroups.reduce((max, group) => Math.max(max, group.length), 0);
  for (let index = 0; index < maxGroupLength; index += 1) {
    jobGroups.forEach((group) => {
      if (group[index]) jobs.push(group[index]);
    });
  }

  return jobs;
}

function getBuildPartKey(part) {
  return part.sourceType === 'custom'
    ? `CUSTOM:${part.customFileUrl || part.title}`
    : `SKU:${part.sku}`;
}

function summarizeBuildJobs(jobs) {
  const summaries = new Map();

  (Array.isArray(jobs) ? jobs : []).forEach((job) => {
    const key = getBuildPartKey(job);
    if (!summaries.has(key)) {
      summaries.set(key, {
        sourceType: job.sourceType,
        sku: job.sku,
        title: job.title,
        typeRaw: job.typeRaw,
        quantity: 0,
        queueItemIds: [],
        driveFileId: job.driveFileId,
        driveFileName: job.driveFileName,
        driveWebViewLink: job.driveWebViewLink,
        localPath: job.localPath,
      });
    }

    const summary = summaries.get(key);
    summary.quantity += 1;
    (job.queueItemIds || []).forEach((id) => {
      if (!summary.queueItemIds.includes(id)) summary.queueItemIds.push(id);
    });
  });

  return Array.from(summaries.values());
}

function getSceneMaterialVolumeMl(scene) {
  const value = Number(scene?.material_usage?.volume_ml || scene?.materialUsage?.volumeMl || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function getSceneModelCount(scene) {
  return Array.isArray(scene?.models) ? scene.models.length : 0;
}

function getSceneLayerCount(scene) {
  const value = Number(scene?.layer_count || scene?.layerCount || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function getPreformJobLabel(job) {
  return String(job?.instanceName || job?.sku || job?.title || job?.localPath || 'Unnamed model').trim();
}

function getPreformServerBaseUrl() {
  return String(process.env.PREFORM_SERVER_URL || '').trim().replace(/\/+$/, '');
}

function getPreformRequestTimeoutMs() {
  return Math.floor(getPositiveEnvNumber('PREFORM_REQUEST_TIMEOUT_MS', 10 * 60 * 1000));
}

function normalizePreformLabel(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokenizePreformLabel(value) {
  return normalizePreformLabel(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

function scorePreformLabel(label, requestedLabel) {
  const normalizedLabel = normalizePreformLabel(label);
  const normalizedRequested = normalizePreformLabel(requestedLabel);
  if (!normalizedLabel || !normalizedRequested) return -1;
  if (normalizedLabel === normalizedRequested) return 1000;

  const labelTokens = tokenizePreformLabel(label);
  const requestedTokens = tokenizePreformLabel(requestedLabel);
  if (!labelTokens.length || !requestedTokens.length) return -1;

  const requestedPrefixMatches = requestedTokens.every((token, index) => labelTokens[index] === token);
  if (requestedPrefixMatches) {
    const extraTokens = labelTokens.slice(requestedTokens.length);
    if (extraTokens.length === 0) return 950;
    if (extraTokens.length === 1 && extraTokens[0] === 'powder') return 920;
    return 700 - extraTokens.length;
  }

  const compactLabel = labelTokens.join('');
  const compactRequested = requestedTokens.join('');
  if (compactLabel === compactRequested) return 900;
  if (compactLabel.includes(compactRequested)) return 250;

  return -1;
}

function findPreformLabelMatch(entries, requestedLabel) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      entry,
      score: scorePreformLabel(entry?.label, requestedLabel),
    }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return String(left.entry?.label || '').length - String(right.entry?.label || '').length;
    })[0]?.entry || null;
}

function getPreformEntryLabels(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => String(entry?.label || '').trim())
    .filter(Boolean);
}

function normalizePreformSceneSettings(settings) {
  if (!settings || typeof settings !== 'object') return null;
  return settings.scene_settings || settings.sceneSettings || null;
}

function parsePreformLayerThickness(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.toUpperCase() === 'ADAPTIVE') return 'ADAPTIVE';

  const layerThickness = Number(raw);
  return Number.isFinite(layerThickness) && layerThickness > 0 ? layerThickness : null;
}

function buildExplicitPreformScenePayload() {
  const rawPayload = parseJsonishEnv(process.env.PREFORM_SCENE_JSON);
  if (rawPayload && typeof rawPayload === 'object') return rawPayload;

  const machineType = String(process.env.PREFORM_MACHINE_TYPE || '').trim();
  const materialCode = String(process.env.PREFORM_MATERIAL_CODE || '').trim();
  const printSetting = String(process.env.PREFORM_PRINT_SETTING || '').trim();
  const layerThickness = parsePreformLayerThickness(process.env.PREFORM_LAYER_THICKNESS_MM);

  const missing = [];
  if (!machineType) missing.push('PREFORM_MACHINE_TYPE');
  if (!materialCode) missing.push('PREFORM_MATERIAL_CODE');
  if (!printSetting) missing.push('PREFORM_PRINT_SETTING');
  if (!layerThickness) missing.push('PREFORM_LAYER_THICKNESS_MM');
  if (missing.length > 0) return null;

  return {
    machine_type: machineType,
    material_code: materialCode,
    print_setting: printSetting,
    layer_thickness_mm: layerThickness,
  };
}

async function preformGet(pathname) {
  const baseUrl = getPreformServerBaseUrl();
  if (!baseUrl) return null;

  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    timeout: getPreformRequestTimeoutMs(),
  });
  const data = await response.json().catch(() => ({}));
  logPreformFullResponse({
    method: 'GET',
    pathname,
    status: response.status,
    ok: response.ok,
    responseBody: data,
  });
  if (!response.ok) {
    throw new Error(data.message || data.error || `PreFormServer request failed (${response.status})`);
  }
  return data;
}

async function buildPreformScenePayloadFromLabels() {
  const printerLabel = String(
    process.env.PREFORM_PRINTER_LABEL
    || process.env.PREFORM_MACHINE_LABEL
    || 'Fuse 1+ 30W'
  ).trim();
  const materialLabel = String(process.env.PREFORM_MATERIAL_LABEL || 'Nylon 12').trim();
  const materialSettingLabel = String(
    process.env.PREFORM_MATERIAL_SETTING_LABEL
    || process.env.PREFORM_PRINT_PROFILE_LABEL
    || ''
  ).trim();
  const materialData = await preformGet('/list-materials/');
  const printerTypes = Array.isArray(materialData?.printer_types)
    ? materialData.printer_types
    : (Array.isArray(materialData?.printerTypes) ? materialData.printerTypes : []);
  const printer = findPreformLabelMatch(printerTypes, printerLabel);
  if (!printer) {
    throw new Error(`PreForm printer "${printerLabel}" was not found. Available printers: ${getPreformEntryLabels(printerTypes).join(', ') || 'none'}.`);
  }

  const materials = Array.isArray(printer.materials) ? printer.materials : [];
  const material = findPreformLabelMatch(materials, materialLabel);
  if (!material) {
    throw new Error(`PreForm material "${materialLabel}" was not found for ${printer.label}. Available materials: ${getPreformEntryLabels(materials).join(', ') || 'none'}.`);
  }

  const materialSettings = Array.isArray(material.material_settings)
    ? material.material_settings
    : (Array.isArray(material.materialSettings) ? material.materialSettings : []);
  const materialSetting = materialSettingLabel
    ? findPreformLabelMatch(materialSettings, materialSettingLabel)
    : (materialSettings.find((entry) => /default/i.test(String(entry?.label || ''))) || materialSettings[0]);
  if (!materialSetting) {
    throw new Error(`No PreForm material settings found for ${printer.label} / ${material.label}.`);
  }

  const sceneSettings = normalizePreformSceneSettings(materialSetting);
  if (!sceneSettings) {
    throw new Error(`PreForm material setting "${materialSetting.label}" did not include scene_settings.`);
  }

  return sceneSettings;
}

async function buildPreformScenePayload() {
  return buildExplicitPreformScenePayload() || buildPreformScenePayloadFromLabels();
}

async function preformRequest(pathname, body) {
  const baseUrl = getPreformServerBaseUrl();
  if (!baseUrl) {
    return null;
  }

  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    timeout: getPreformRequestTimeoutMs(),
  });
  const data = await response.json().catch(() => ({}));
  logPreformFullResponse({
    method: 'POST',
    pathname,
    status: response.status,
    ok: response.ok,
    requestBody: body || {},
    responseBody: data,
  });
  if (!response.ok) {
    const error = new Error(data.message || data.error || `PreFormServer request failed (${response.status})`);
    error.status = response.status;
    error.data = data;
    error.pathname = pathname;
    throw error;
  }
  return data;
}

async function deletePreformModel(sceneId, modelId) {
  const baseUrl = getPreformServerBaseUrl();
  if (!baseUrl || !sceneId || !modelId) return null;

  preformLog('Deleting model from scene.', { sceneId, modelId });
  const response = await fetch(`${baseUrl}/scene/${encodeURIComponent(sceneId)}/models/${encodeURIComponent(modelId)}/`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
    timeout: getPreformRequestTimeoutMs(),
  });
  const data = await response.json().catch(() => ({}));
  logPreformFullResponse({
    method: 'DELETE',
    pathname: `/scene/${encodeURIComponent(sceneId)}/models/${encodeURIComponent(modelId)}/`,
    status: response.status,
    ok: response.ok,
    responseBody: data,
  });
  if (!response.ok) {
    throw new Error(data.message || data.error || `PreFormServer request failed (${response.status})`);
  }
  return data;
}

async function createPreformScene(scenePayload) {
  const scene = await preformRequest('/scene/', scenePayload);
  const sceneId = scene?.scene_id || scene?.id || scene?.sceneId;
  if (!sceneId) {
    throw new Error('PreFormServer did not return a scene id.');
  }
  preformLog('Created scene.', { sceneId });
  return {
    scene,
    sceneId,
  };
}

async function importPreformModel(sceneId, job) {
  const payload = {
    file: job.localPath,
    repair_behavior: 'REPAIR',
    name: job.instanceName || job.sku || job.title,
  };
  if (job.orientation) {
    payload.orientation = toPreformEulerDegrees(job.orientation);
    payload.lock = job.lockMode || 'LOCKED_XY_ROTATION_FREE_TRANSLATION';
  }

  preformLog('Importing model.', {
    sceneId,
    job: getPreformJobLabel(job),
    file: job.localPath,
  });
  const model = await preformRequest(`/scene/${encodeURIComponent(sceneId)}/import-model/`, payload);
  const modelId = model?.id || model?.model_id || '';
  preformLog('Imported model.', {
    sceneId,
    job: getPreformJobLabel(job),
    modelId,
  });

  return {
    ...job,
    modelId,
  };
}

function getPreformSceneFromPayload(payload) {
  if (Array.isArray(payload?.models)) return payload;
  if (Array.isArray(payload?.scene?.models)) return payload.scene;
  if (Array.isArray(payload?.data?.models)) return payload.data;
  return null;
}

function hasPreformBoundsSignal(scene) {
  return (Array.isArray(scene?.models) ? scene.models : [])
    .some((model) => Object.prototype.hasOwnProperty.call(model, 'in_bounds')
      || Object.prototype.hasOwnProperty.call(model, 'inBounds'));
}

function hasPreformOutOfBoundsSignal(scene) {
  return (Array.isArray(scene?.models) ? scene.models : [])
    .some((model) => isPreformSceneModelOutOfBounds(model));
}

function summarizePreformRequestError(err) {
  const data = err?.data && typeof err.data === 'object' ? err.data : null;
  const details = [
    data?.error?.message,
    data?.message,
    typeof data?.error === 'string' ? data.error : '',
    err?.message,
  ].filter(Boolean);
  return details[0] || err?.code || 'PreForm request failed';
}

function buildPreformAutoPackPayload(packingConfig) {
  return {
    model_spacing_mm: packingConfig.modelSpacingMm,
  };
}

async function requestPreformAutoPackScene(sceneId, payload) {
  try {
    const data = await preformRequest(`/scene/${encodeURIComponent(sceneId)}/auto-pack/`, payload);
    return getPreformSceneFromPayload(data) || data;
  } catch (err) {
    const responseScene = getPreformSceneFromPayload(err.data);
    if (responseScene && hasPreformOutOfBoundsSignal(responseScene)) {
      preformLog('Auto-pack returned a non-OK scene with bounds data; using fitted/out-of-bounds model flags.', {
        sceneId,
        status: err.status || '',
        modelCount: Array.isArray(responseScene.models) ? responseScene.models.length : 0,
      });
      return responseScene;
    }

    try {
      const currentScene = await getPreformScene(sceneId);
      if (hasPreformOutOfBoundsSignal(currentScene)) {
        preformLog('Auto-pack failed without bounds data in the response; using current scene out-of-bounds flags.', {
          sceneId,
          status: err.status || '',
          modelCount: Array.isArray(currentScene.models) ? currentScene.models.length : 0,
          error: summarizePreformRequestError(err),
        });
        return currentScene;
      }

      preformLog('Auto-pack failed and current scene did not contain usable out-of-bounds flags.', {
        sceneId,
        status: err.status || '',
        responseHadBoundsSchema: Boolean(responseScene && hasPreformBoundsSignal(responseScene)),
        currentSceneHadBoundsSchema: Boolean(currentScene && hasPreformBoundsSignal(currentScene)),
        error: summarizePreformRequestError(err),
      });
    } catch (sceneErr) {
      preformLog('Auto-pack failed and current scene could not be inspected.', {
        sceneId,
        status: err.status || '',
        autoPackError: summarizePreformRequestError(err),
        sceneError: sceneErr.message || sceneErr.code || '',
      });
    }

    err.code = err.code || 'PREFORM_AUTO_PACK_FAILED';
    err.message = [
      err.message || 'PreForm auto-pack failed.',
      'PreForm did not provide usable out-of-bounds model flags in the error response or current scene.',
    ].filter(Boolean).join(' ');
    throw err;
  }
}

async function autoPackPreformScene(sceneId, packingConfig) {
  if (String(process.env.PREFORM_AUTO_PACK || '1').trim() === '0') {
    preformLog('Auto-pack skipped because PREFORM_AUTO_PACK=0.', { sceneId });
    return null;
  }

  const autoPackPayload = buildPreformAutoPackPayload(packingConfig);
  preformLog('Auto-packing scene.', {
    sceneId,
    modelSpacingMm: packingConfig.modelSpacingMm,
    wallSpacingMm: packingConfig.wallSpacingMm,
    payload: autoPackPayload,
  });
  return requestPreformAutoPackScene(sceneId, autoPackPayload);
}

async function getPreformScene(sceneId) {
  return preformGet(`/scene/${encodeURIComponent(sceneId)}/`);
}

async function savePreformScene({ buildId, buildDir, sceneId }) {
  const formDir = path.resolve(process.env.PREFORM_OUTPUT_DIR || buildDir);
  fs.mkdirSync(formDir, { recursive: true });
  const formFilePath = path.join(formDir, `${buildId}.form`);
  preformLog('Saving PreForm build file.', { buildId, sceneId, formFilePath });
  await preformRequest(`/scene/${encodeURIComponent(sceneId)}/save-form/?async=false`, {
    file: formFilePath,
  });
  return formFilePath;
}

async function maybePackAndCagePreformScene({ buildId, sceneId, packingConfig }) {
  if (String(process.env.PREFORM_PACK_AND_CAGE || '').trim() !== '1') {
    return null;
  }

  preformLog('Running pack-and-cage.', {
    buildId,
    sceneId,
    modelSpacingMm: packingConfig.modelSpacingMm,
    distanceToCageMm: Number(process.env.PREFORM_CAGE_DISTANCE_MM || packingConfig.wallSpacingMm),
  });
  try {
    return await preformRequest('/scene/pack-and-cage/', {
      models: 'ALL',
      packing_type: {
        packing_type: String(process.env.PREFORM_PACKING_TYPE || 'PACK_NORMAL').trim(),
      },
      cage_label: String(process.env.PREFORM_CAGE_LABEL || buildId).trim(),
      generate_mesh_label: String(process.env.PREFORM_GENERATE_MESH_LABEL || '1').trim() !== '0',
      model_spacing_mm: packingConfig.modelSpacingMm,
      bar_spacing_mm: Number(process.env.PREFORM_CAGE_BAR_SPACING_MM || 0),
      bar_thickness_mm: Number(process.env.PREFORM_CAGE_BAR_THICKNESS_MM || 1),
      bar_width_mm: Number(process.env.PREFORM_CAGE_BAR_WIDTH_MM || 1),
      distance_to_cage_mm: Number(process.env.PREFORM_CAGE_DISTANCE_MM || packingConfig.wallSpacingMm),
      enable_round_edges: String(process.env.PREFORM_CAGE_ROUND_EDGES || '').trim() === '1',
      enable_square_bars: String(process.env.PREFORM_CAGE_SQUARE_BARS || '1').trim() !== '0',
    });
  } catch (err) {
    err.code = err.code || 'PREFORM_PACK_AND_CAGE_FAILED';
    throw err;
  }
}

function getPreformModelId(model) {
  return String(model?.id || model?.model_id || model?.modelId || '').trim();
}

function findPreformSceneModelForJob(scene, job) {
  const modelId = String(job?.modelId || '').trim();
  if (!modelId) return null;
  return (Array.isArray(scene?.models) ? scene.models : [])
    .find((model) => getPreformModelId(model) === modelId) || null;
}

function isPreformSceneModelOutOfBounds(model) {
  if (!model || typeof model !== 'object') return false;
  if (model.in_bounds === false || model.inBounds === false) return true;
  return false;
}

function getOutOfBoundsPreformJobs(scene, jobs) {
  if (!Array.isArray(scene?.models)) return [];
  return (Array.isArray(jobs) ? jobs : []).filter((job) => {
    const sceneModel = findPreformSceneModelForJob(scene, job);
    return isPreformSceneModelOutOfBounds(sceneModel);
  });
}

async function finalizePreformBuildScene({ buildId, buildDir, sceneId, acceptedJobs, packingConfig }) {
  const packScene = await autoPackPreformScene(sceneId, packingConfig);
  let buildJobs = acceptedJobs;
  let overflowJobs = [];

  const outOfBoundsJobs = getOutOfBoundsPreformJobs(packScene, acceptedJobs);
  if (outOfBoundsJobs.length > 0) {
    if (outOfBoundsJobs.length >= acceptedJobs.length) {
      const error = new Error('PreForm auto-pack could not fit any models in this build.');
      error.code = 'PREFORM_AUTO_PACK_FAILED';
      throw error;
    }

    const outOfBoundsModelIds = new Set(outOfBoundsJobs.map((job) => String(job.modelId || '').trim()));
    buildJobs = acceptedJobs.filter((job) => !outOfBoundsModelIds.has(String(job.modelId || '').trim()));
    overflowJobs = outOfBoundsJobs.map(({ modelId, ...job }) => job);

    preformLog('Auto-pack left some models out of bounds; keeping fitted models and deferring the rest.', {
      buildId,
      sceneId,
      fittedModels: buildJobs.length,
      overflowModels: overflowJobs.map(getPreformJobLabel),
    });

    for (const job of outOfBoundsJobs) {
      await deletePreformModel(sceneId, job.modelId);
    }
  }

  await maybePackAndCagePreformScene({ buildId, sceneId, packingConfig });
  const scene = await getPreformScene(sceneId);
  const materialVolumeMl = getSceneMaterialVolumeMl(scene);
  const modelInstanceCount = getSceneModelCount(scene) || buildJobs.length;
  const layerCount = getSceneLayerCount(scene);
  const formFilePath = await savePreformScene({ buildId, buildDir, sceneId });
  const buildDensity = packingConfig.buildVolumeMl > 0 ? materialVolumeMl / packingConfig.buildVolumeMl : 0;

  preformLog('Finalized build scene.', {
    buildId,
    sceneId,
    models: buildJobs.length,
    overflowModels: overflowJobs.length,
    materialVolumeMl: formatPreformNumber(materialVolumeMl),
    buildDensity: formatPreformDensity(buildDensity),
    layerCount,
    formFilePath,
  });

  return {
    buildId,
    sceneId,
    importedCount: buildJobs.length,
    modelInstanceCount,
    layerCount,
    materialVolumeMl,
    buildDensity,
    buildVolumeMl: packingConfig.buildVolumeMl,
    formFilePath,
    overflowJobs,
    parts: summarizeBuildJobs(buildJobs),
  };
}

function isPreformPackFailure(err) {
  return ['PREFORM_AUTO_PACK_FAILED', 'PREFORM_PACK_AND_CAGE_FAILED'].includes(String(err?.code || ''));
}

async function createPreformBuildFromJobGroup({
  buildId,
  buildDir,
  scenePayload,
  jobs,
  packingConfig,
}) {
  const activeScene = await createPreformScene(scenePayload);
  const acceptedJobs = [];

  preformLog('Started PreForm build attempt.', {
    buildId,
    sceneId: activeScene.sceneId,
    modelInstances: jobs.length,
    modelSpacingMm: packingConfig.modelSpacingMm,
    wallSpacingMm: packingConfig.wallSpacingMm,
  });

  for (const job of jobs) {
    acceptedJobs.push(await importPreformModel(activeScene.sceneId, job));
  }

  preformLog('Imported all requested models for build attempt; packing once.', {
    buildId,
    sceneId: activeScene.sceneId,
    importedModels: acceptedJobs.length,
  });

  return finalizePreformBuildScene({
    buildId,
    buildDir,
    sceneId: activeScene.sceneId,
    acceptedJobs,
    packingConfig,
  });
}

async function createPreformBuilds({ buildId, buildDir, parts }) {
  if (!String(process.env.PREFORM_SERVER_URL || '').trim()) {
    return null;
  }

  const scenePayload = await buildPreformScenePayload();
  const packingConfig = getPreformPackingConfig();
  preformLog('PreForm packing configuration.', {
    buildId,
    modelSpacingMm: packingConfig.modelSpacingMm,
    wallSpacingMm: packingConfig.wallSpacingMm,
    buildVolumeMl: formatPreformNumber(packingConfig.buildVolumeMl),
  });

  const modelJobs = expandPartsToModelJobs(parts);
  preformLog('Preparing model jobs for PreForm.', {
    buildId,
    sourceParts: Array.isArray(parts) ? parts.length : 0,
    modelInstances: modelJobs.length,
  });

  const groupQueue = [modelJobs];
  const builds = [];
  let packAttempts = 0;
  const maxPackAttempts = Math.max(1, modelJobs.length * 2 + 1);

  while (groupQueue.length > 0) {
    if (packAttempts >= maxPackAttempts) {
      throw new Error(`PreForm build planner stopped after ${packAttempts} pack attempts with ${groupQueue.length} groups still pending.`);
    }
    const group = groupQueue.shift();
    if (!group?.length) continue;

    const activeBuildId = `${buildId}-${String(builds.length + 1).padStart(2, '0')}`;
    packAttempts += 1;

    try {
      const build = await createPreformBuildFromJobGroup({
        buildId: activeBuildId,
        buildDir,
        scenePayload,
        jobs: group,
        packingConfig,
      });
      const overflowJobs = Array.isArray(build.overflowJobs) ? build.overflowJobs : [];
      const buildForManifest = { ...build };
      delete buildForManifest.overflowJobs;
      if (Number(buildForManifest.importedCount || 0) > 0) {
        builds.push(buildForManifest);
      }
      if (overflowJobs.length > 0) {
        preformLog('Queueing auto-pack overflow models for another build.', {
          sourceBuildId: activeBuildId,
          overflowModels: overflowJobs.map(getPreformJobLabel),
        });
        groupQueue.unshift(overflowJobs);
      }
    } catch (err) {
      if (isPreformPackFailure(err)) {
        if (group.length <= 1) {
          err.message = `A single model could not be packed with the configured spacing: ${getPreformJobLabel(group[0])}. ${err.message || ''}`.trim();
        } else {
          err.message = [
            `PreForm could not pack ${group.length} model instances and did not return usable out-of-bounds model data.`,
            'The build planner only cascades models that PreForm explicitly reports as out of bounds.',
            err.message || '',
          ].filter(Boolean).join(' ');
        }
      }
      throw err;
    }
  }

  preformLog('PreForm build planning complete.', {
    buildId,
    finalBuildCount: builds.length,
    packAttempts,
    builds: builds.map((build, index) => ({
      build: index + 1,
      buildId: build.buildId,
      models: build.importedCount,
      density: formatPreformDensity(build.buildDensity),
      materialVolumeMl: formatPreformNumber(build.materialVolumeMl),
      layers: build.layerCount,
    })),
  });

  const importedCount = builds.reduce((sum, build) => sum + Math.max(0, Number(build.importedCount) || 0), 0);
  if (importedCount !== modelJobs.length) {
    throw new Error(`PreForm build planner imported ${importedCount} model instances, but ${modelJobs.length} were requested.`);
  }

  return {
    builds,
    packing: {
      ...packingConfig,
      algorithm: 'single-pack-with-spacing-cascade-out-of-bounds',
      initialPlannedBuildCount: 1,
      finalBuildCount: builds.length,
      packAttempts,
    },
    scenePayload,
    importedCount,
    formFilePath: builds[0]?.formFilePath || '',
  };
}

async function createPreformBuild({ buildId, buildDir, parts }) {
  const result = await createPreformBuilds({ buildId, buildDir, parts });
  if (!result) return null;

  if (result.builds.length <= 1) {
    return {
      ...result,
      sceneId: result.builds[0]?.sceneId || '',
      formFilePath: result.builds[0]?.formFilePath || '',
    };
  }

  return {
    ...result,
    sceneId: result.builds[0]?.sceneId || '',
    formFilePath: result.builds[0]?.formFilePath || '',
  };
}

async function preparePreformBuildFromQueueItems(items, settings = {}) {
  const needsPrintedItems = (Array.isArray(items) ? items : [])
    .filter((item) => String(item?.stageKey || '').trim() === 'needs_printed');
  const buildId = `sls-build-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const buildRoot = path.resolve(process.env.PRINT_STL_DOWNLOAD_DIR || DEFAULT_DOWNLOAD_ROOT);
  cleanupPreformBuildRoot(buildRoot);
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
        file = await findDriveFileForSku(part.sku, settings);
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

      const storedOrientation = getMatchingPartOrientation({ part, file, settings });
      resolvedParts.push({
        ...part,
        driveFileId: file.id,
        driveFileName: file.name,
        driveWebViewLink: file.webViewLink || '',
        localPath,
        orientation: storedOrientation?.orientation || null,
        lockMode: storedOrientation?.lockMode || '',
        orientationUpdatedAt: storedOrientation?.updatedAt || null,
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

  const hasBuildIssues = missingFiles.length > 0 || skippedCustomItems.length > 0;
  let preform = null;
  if (resolvedParts.length > 0) {
    preform = await createPreformBuild({
      buildId,
      buildDir,
      parts: resolvedParts,
    });
  }

  if (preform?.builds) {
    manifest.preformBuilds = preform.builds;
    manifest.preformPacking = preform.packing || null;
    manifest.preformBuildCount = preform.builds.length;
  }

  const manifestPath = path.join(buildDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    manifest,
    manifestPath,
    preform,
    hasBuildIssues,
    partialBuild: Boolean(preform && hasBuildIssues),
    mode: preform ? (hasBuildIssues ? 'partial-preform' : 'preform') : 'manifest',
  };
}

module.exports = {
  getDriveModelFileForSku,
  openDriveModelFileStreamForSku,
  openDriveQcPdfStreamForSku,
  preparePreformBuildFromQueueItems,
  readPreformBuildManifest,
  resolvePreformBuildArtifact,
  transformStlBufferOrientation,
};
