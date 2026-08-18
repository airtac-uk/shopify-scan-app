// routes.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { ZipArchive } = require('archiver');
const sessionsStore = require('./sessionsStore'); // your SQLite session store
const { shopifyClient } = require('./shopifyClient');
const fetch = require('node-fetch'); // for OAuth token exchange
const {
  fetchPickListSheet,
  buildPickListForOrder,
  buildPutAwaySkuLookup,
  buildPartExplorerCatalogFromSheet,
  normalizeSku,
  normalizePickType,
  getWaitingPartsTypeGroup,
} = require('./pickListService');
const {
  TRACKER_STAGES,
  deriveTrackerStage,
  extractTrackerEventsFromOrderNote,
  extractLatestAwaitingPartsSnapshot,
  extractLatestStageStaffFromOrderNote,
  normalizeTrackerLineItems,
  buildPublicTrackerPayload,
  buildInternalOrderTimeline,
} = require('./orderTrackerService');
const {
  PRINT_QUEUE_CONFIGS,
  DEFAULT_PRINT_QUEUE_KEY,
  DEFAULT_PRINT_QUEUE_STAGE,
  normalizePrintQueueKey,
  getPrintQueueConfig,
  getPrintQueueStages,
  normalizeStageKey,
  isPrintableSheetRow,
  getPrintQueueKeyForSheetRow,
  buildPrintCatalogFromSheet,
  buildPrintQueueItemsForCatalogSku,
  parsePositiveInteger,
} = require('./printQueueService');
const {
  preparePreformBuildFromQueueItems,
  getDriveModelFileForSku,
  openDriveModelFileStreamForSku,
  openDriveQcPdfStreamForSku,
  readPreformBuildManifest,
  resolvePreformBuildArtifact,
  transformStlBufferOrientation,
} = require('./preformBuildService');
const {
  getShipmentRatesDetailed,
  getShipmentById,
  listPackageTypesForShipment,
  listLabelsForShipment,
  lookupShipmentForOrder,
  purchaseLabelForRate,
  voidLabelById,
  downloadLabelBuffer,
  getLabelById,
  updateShipmentPackages,
} = require('./shipstationService');
const {
  getBagLabelPrinterCapabilities,
  printBagLabelsPdf,
  printPackingSlipPdf,
  printPdfLabel,
} = require('./printNodeService');
const {
  buildBagLabelsPdf,
} = require('./bagLabelService');
const {
  buildPackingOrderLabelPdf,
} = require('./packingLabelService');
const {
  HYP_AR_STAGES,
  HYP_AR_RECEIVER_PRODUCT_IDS,
  normalizeHypArStageKey,
  normalizeShopifyProductId,
  getHypArStage,
  buildHypArReceiverUnits,
  buildHypArExcludedSourceKeys,
  getShopifyWorkflowStatus,
  getHypArArchiveReasonForOrder,
  buildHypArStageCounts,
  buildHypArOp1SkuSummary,
} = require('./hypArProductionService');

router.use(cookieParser());

async function appendOrderNote( client, orderGid, appendText ) {
  // 1) Fetch existing note
  const getNoteQuery = `
    query getOrderNote($id: ID!) {
      order(id: $id) {
        id
        note
      }
    }
  `;

  const noteRes = await client.graphql(getNoteQuery, {
    variables: { id: orderGid },
  });

  const order = noteRes.data?.order;
  if (!order) throw new Error(`Order not found for id: ${orderGid}`);

  const updatedNote = (order.note || '') + appendText;

  // 2) Update note
  const updateNoteMutation = `
    mutation updateOrderNote($id: ID!, $note: String) {
      orderUpdate(input: { id: $id, note: $note }) {
        userErrors { field message }
      }
    }
  `;

  const updateRes = await client.graphql(updateNoteMutation, {
    variables: { id: orderGid, note: updatedNote },
  });

  const userErrors = updateRes.data?.orderUpdate?.userErrors || [];
  if (userErrors.length) {
    const msg = userErrors.map(e => e.message).join('; ');
    throw new Error(`Failed to update order note: ${msg}`);
  }

  return { success: true };
}

async function appendOrderNoteOrWarn(client, orderGid, appendText, context = {}) {
  try {
    await appendOrderNote(client, orderGid, appendText);
    return { success: true, error: null };
  } catch (err) {
    const error = err.message || 'Failed to update order note';
    console.error('Order note update failed; continuing action:', {
      ...context,
      orderGid,
      error,
    });
    return { success: false, error };
  }
}


// ---------------------
// 1️⃣ /auth - start OAuth
// ---------------------
function getSafeAuthReturnTo(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '/scan.html';
  if (!raw.startsWith('/')) return '/scan.html';
  if (raw.startsWith('//')) return '/scan.html';
  if (raw.startsWith('/auth')) return '/scan.html';
  return raw;
}

function sendAuthRequired(res, error) {
  return res.status(401).json({
    success: false,
    error,
    authRequired: true,
    loginUrl: '/',
  });
}

function clearFrontendAuthCookies(res) {
  const cookieOptions = { sameSite: 'lax' };
  res.clearCookie('shop', cookieOptions);
  res.clearCookie('userId', cookieOptions);
  res.clearCookie('authReturnTo', cookieOptions);
}

function getSessionDisplayUser(session, cookieUser) {
  const fromCookie = String(cookieUser || '').trim();
  if (fromCookie) return fromCookie;

  const associatedUser = session?.associated_user;
  if (!associatedUser) return '';
  if (typeof associatedUser === 'string') return associatedUser.trim();

  return String(
    associatedUser.first_name ||
    associatedUser.name ||
    associatedUser.email ||
    ''
  ).trim();
}

router.get('/auth', async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).send('Missing shop parameter');
    const returnTo = getSafeAuthReturnTo(req.query.returnTo);

    console.log('Starting OAuth for shop:', shop);

    // Build Shopify OAuth URL manually
    const scopes = process.env.SHOPIFY_SCOPES.split(',').join(',');
    const redirectUri = `${process.env.HOST}/auth/callback`;
    const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${redirectUri}&state=nonce&grant_options[]=per-user`;

    console.log('Redirecting to Shopify auth URL:', installUrl);
    res.cookie('authReturnTo', returnTo, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(installUrl);

  } catch (err) {
    console.error('Error in /auth:', err);
    res.status(500).send('OAuth initiation failed');
  }
});

// ---------------------
// 2️⃣ /auth/callback
// ---------------------
router.get('/auth/callback', async (req, res) => {
  try {
    const { shop, code } = req.query;
    if (!shop || !code) return res.status(400).send('Missing shop or code');

    console.log('OAuth callback for shop:', shop);

    // Exchange code for access token
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code
      })
    });
    
    const data = await tokenRes.json();
    const accessToken = data.access_token;
    if (!accessToken) throw new Error('Failed to get access token');
    
    console.log("Data");
    console.log(JSON.stringify(data));

    const associatedUserName = getSessionDisplayUser(
      { associated_user: data.associated_user },
      ''
    );

    // Store session in SQLite
    sessionsStore.set(shop, { shop, accessToken, isOnline: false, associated_user: associatedUserName });

    try {
      const client = shopifyClient({ shop, accessToken, isOnline: false });
      await ensureOrdersCreateWebhookSubscription({ client, shop, req });
    } catch (webhookErr) {
      console.error(`Failed to ensure orders/create webhook for ${shop}:`, webhookErr);
    }

    // Set cookie for frontend
    res.cookie('shop', shop, { httpOnly: false, sameSite: 'lax' });
    res.cookie('userId', associatedUserName, { httpOnly: false, sameSite: 'lax' });


    const returnTo = getSafeAuthReturnTo(req.cookies?.authReturnTo);
    res.clearCookie('authReturnTo', { sameSite: 'lax' });

    console.log('Session stored successfully, redirecting to:', returnTo);
    res.redirect(returnTo);

  } catch (err) {
    console.error('Error in /auth/callback:', err);
    res.status(500).send('OAuth failed');
  }
});

router.post('/auth/logout', (req, res) => {
  clearFrontendAuthCookies(res);
  res.json({ success: true, loginUrl: '/' });
});

router.get('/auth/logout', (req, res) => {
  clearFrontendAuthCookies(res);
  res.redirect('/');
});

router.get('/api/auth/status', async (req, res) => {

  const shop = req.cookies.shop;
  if (!shop) 
    {
      console.log("Cookie has no shop")
      return sendAuthRequired(res, 'Not logged in');
    }

  const session = sessionsStore.get(shop);
  if (!session) {
    console.log("Cookie has no session")
    return sendAuthRequired(res, 'No session found');
  }

  try {
    const client = shopifyClient(session);
    await ensureOrdersCreateWebhookSubscription({ client, shop, req });
  } catch (webhookErr) {
    console.error(`Failed to ensure orders/create webhook for ${shop}:`, webhookErr);
  }
  res.json({
    authenticated: true,
    shop: req.cookies.shop,
    user: getSessionDisplayUser(session, req.cookies.userId),
  });
});

async function sendGoogleChatMessage(webhookUrl, text) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Chat error ${res.status}: ${body}`);
  }
}

async function sendGeckoboardEvent(eventData) {
  const apiKey = process.env.GECKOBOARD_API_KEY;
  const datasetId = process.env.GECKOBOARD_DATASET_ID;
  if (!apiKey || !datasetId) return;

  const authHeader = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  await ensureGeckoboardDataset({ authHeader, datasetId });

  const res = await fetch(`https://api.geckoboard.com/datasets/${datasetId}/data`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({ data: [eventData] }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Geckoboard error ${res.status}: ${body}`);
  }
}

async function trySendGeckoboardEvent(eventData) {
  const apiKey = process.env.GECKOBOARD_API_KEY;
  const datasetId = process.env.GECKOBOARD_DATASET_ID;
  if (!apiKey || !datasetId) {
    return {
      sent: false,
      warning: 'GECKOBOARD_API_KEY or GECKOBOARD_DATASET_ID is not configured',
    };
  }

  try {
    await sendGeckoboardEvent(eventData);
    return { sent: true, warning: null };
  } catch (err) {
    console.error('Geckoboard event send failed:', err);
    return {
      sent: false,
      warning: err?.message || 'Unknown Geckoboard error',
    };
  }
}

let geckoboardDatasetChecked = false;
const wholesaleAdapterBuiltScanCounts = new Map();
const webhookRegistrationCheckedShops = new Set();
const awaitingPartsSyncPromises = new Map();
const hypArProductionSyncJobs = new Map();
const HYP_AR_BACKGROUND_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
const ALLOW_AWAITING_PARTS_NOTE_SYNC = String(process.env.ALLOW_AWAITING_PARTS_NOTE_SYNC || '').trim() === '1';
const BLOCKED_FULFILLMENT_STATUSES = new Set(['FULFILLED', 'PARTIALLY_FULFILLED', 'RESTOCKED']);
const CLOSED_AWAITING_PARTS_FULFILLMENT_STATUSES = new Set(['FULFILLED', 'RESTOCKED']);
const SHIPPING_ALLOWED_FINANCIAL_STATUSES = new Set(['PAID', 'PARTIALLY_REFUNDED']);
const SHIPPING_LABEL_PURCHASE_STAGE_KEYS = new Set(['packaged', 'fulfilled', 'partially_fulfilled']);
const ORDER_FLOW_TERMINAL_WORKFLOW_STATUSES = new Set(['FULFILLED', 'RESTOCKED', 'CANCELLED']);
const ORDER_FLOW_DEFAULT_NEW_ORDER_WORKING_DAYS = 1;
const ORDER_FLOW_DEFAULT_STAGE_THRESHOLD_WORKING_DAYS = 1;
const ORDER_FLOW_STAGE_THRESHOLDS_WORKING_DAYS = {
  received: 0.25,
  queued: 1,
  building: 1,
  awaiting_parts: 3,
  quality_check: 0.5,
  rebuild: 2,
  passed_qc: 1,
  packaged: 1,
  on_hold: 3,
  partially_fulfilled: 3,
};
const ORDER_FLOW_STAGE_SORT_ORDER = Object.keys(ORDER_FLOW_STAGE_THRESHOLDS_WORKING_DAYS);
const ORDER_FLOW_EXCEPTION_STACK_LABELS = {
  snoozed: 'Snoozed',
  wholesale: 'Wholesale',
  proto: 'Proto',
};
const ORDER_WORKFLOW_STATUS_FIELDS = `
              displayFulfillmentStatus
              displayFinancialStatus
              cancelledAt
              cancelReason
              currentSubtotalLineItemsQuantity
              subtotalLineItemsQuantity
              currentTotalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
`;
const TRACKER_METAFIELD_NAMESPACE = String(process.env.SHOPIFY_TRACKER_METAFIELD_NAMESPACE || 'airtac').trim();
const TRACKER_METAFIELD_KEY = String(process.env.SHOPIFY_TRACKER_METAFIELD_KEY || 'tracker_token').trim();
const HPA_TANK_REG_REMOVAL_SKUS = new Set(['T1P_TANK-1', 'T1P_TANK-2']);
const ORDER_LOOKUP_CANDIDATE_LIMIT = 10;
const ORDER_TRACKER_METAFIELD_FIELD = `
              trackerTokenMetafield: metafield(namespace: "${TRACKER_METAFIELD_NAMESPACE}", key: "${TRACKER_METAFIELD_KEY}") {
                value
              }
`;

function normalizeScanBarcode(barcode) {
  return normalizeSku(barcode);
}

function getOrderLookupTokens(value) {
  const normalized = normalizeScanBarcode(value);
  if (!normalized) return [];

  const tokens = new Set([normalized]);
  const withoutHash = normalized.replace(/^#/, '');
  if (withoutHash) tokens.add(withoutHash);
  if (withoutHash && !withoutHash.startsWith('ORDER-')) {
    tokens.add(`ORDER-${withoutHash}`);
  }
  if (withoutHash.startsWith('ORDER-')) {
    const withoutOrderPrefix = withoutHash.replace(/^ORDER-/, '');
    if (withoutOrderPrefix) tokens.add(withoutOrderPrefix);
  }
  return Array.from(tokens).filter(Boolean);
}

function orderMatchesExactLookup(order, lookup) {
  const lookupTokens = new Set(getOrderLookupTokens(lookup));
  if (!lookupTokens.size || !order) return false;

  const orderTokens = new Set([
    ...getOrderLookupTokens(order.name),
    ...getOrderLookupTokens(order.orderNumber),
    ...getOrderLookupTokens(order.barcode),
  ]);

  const lineItemEdges = Array.isArray(order.lineItems?.edges) ? order.lineItems.edges : [];
  lineItemEdges.forEach((edge) => {
    const node = edge?.node || {};
    getOrderLookupTokens(node?.variant?.barcode).forEach((token) => orderTokens.add(token));
  });

  return Array.from(lookupTokens).some((token) => orderTokens.has(token));
}

function selectExactOrderEdge(edges, lookup) {
  return (Array.isArray(edges) ? edges : [])
    .find((edge) => orderMatchesExactLookup(edge?.node, lookup)) || null;
}

function selectExactOrderNode(response, lookup) {
  return selectExactOrderEdge(response?.data?.orders?.edges, lookup)?.node || null;
}

function buildOrderSearchQuery(lookup) {
  const lookupTokens = getOrderLookupTokens(lookup);
  const nameToken = lookupTokens.find((token) => !token.startsWith('ORDER-') && !token.startsWith('#'))
    || lookupTokens.find((token) => !token.startsWith('ORDER-'))
    || lookupTokens[0]
    || '';
  return nameToken ? `name:${nameToken} status:any` : 'status:any';
}

function normalizeOrderTags(tags) {
  if (Array.isArray(tags)) {
    return tags
      .map((tag) => String(tag || '').trim())
      .filter(Boolean);
  }

  return String(tags || '')
    .split(',')
    .map((tag) => String(tag || '').trim())
    .filter(Boolean);
}

function hasAwaitingPartsTag(tags) {
  return normalizeOrderTags(tags)
    .some((tag) => String(tag || '').trim().toLowerCase() === 'awaiting_parts');
}

function resolveAuthenticatedRequest(req, res, { requireUser = false } = {}) {
  const shop = req.cookies.shop;
  if (!shop) {
    sendAuthRequired(res, 'Not logged in');
    return null;
  }

  const session = sessionsStore.get(shop);
  if (!session) {
    sendAuthRequired(res, 'No session found');
    return null;
  }

  const userId = String(req.cookies.userId || '').trim();
  if (requireUser && !userId) {
    sendAuthRequired(res, 'Username needs to be set');
    return null;
  }

  return { shop, session, userId };
}

function hasWholesaleAdapterBuiltNote(orderNote) {
  return /(^|\n)\s*WHOLESALE ADAPTER BUILT\b/i.test(String(orderNote || ''));
}

function shouldExcludeOrderFromAwaitingPartsQueue(order) {
  if (!order) return false;
  if (order.cancelledAt) return true;

  const fulfillmentStatus = String(order.displayFulfillmentStatus || '').trim().toUpperCase();
  return CLOSED_AWAITING_PARTS_FULFILLMENT_STATUSES.has(fulfillmentStatus);
}

function shouldReplaceAwaitingPartsTagWithPackaged(order) {
  if (!order) return false;

  const fulfillmentStatus = String(order.displayFulfillmentStatus || '').trim().toUpperCase();
  return fulfillmentStatus === 'FULFILLED' && hasAwaitingPartsTag(order.tags);
}

async function replaceAwaitingPartsTagWithPackaged({ client, order }) {
  if (!client || !order?.id || !shouldReplaceAwaitingPartsTagWithPackaged(order)) {
    return false;
  }

  const mutation = `
    mutation replaceAwaitingPartsTagWithPackaged($id: ID!, $tags: [String!]) {
      orderUpdate(input: { id: $id, tags: $tags }) {
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const response = await client.graphql(mutation, {
      variables: {
        id: order.id,
        tags: ['packaged'],
      },
    });

    const userErrors = response.data?.orderUpdate?.userErrors || [];
    if (userErrors.length) {
      const message = userErrors.map((error) => error.message).join('; ');
      throw new Error(message || 'Unknown Shopify error');
    }

    order.tags = ['packaged'];
    return true;
  } catch (err) {
    console.error(`Failed to replace awaiting_parts tag with packaged for order ${order.id}:`, err);
    return false;
  }
}

function resolveLatestWaitingQcStaff({ shop, normalizedBarcode, orderId, orderNote }) {
  const normalizedOrderNote = String(orderNote || '');

  const waitingQcStaff = sessionsStore.getLatestWaitingQcStaffByBarcode(normalizedBarcode);
  if (waitingQcStaff) {
    return waitingQcStaff;
  }

  const orderNoteStaff = extractLatestStageStaffFromOrderNote(normalizedOrderNote, 'quality_check');
  if (orderNoteStaff) {
    return orderNoteStaff;
  }

  return sessionsStore.getLatestOrderTrackerStaffByStage({
    shop,
    orderId,
    stageKey: 'quality_check',
  });
}

function verifyShopifyWebhook(rawBody, hmacHeader) {
  const bodyBuffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(String(rawBody || ''), 'utf8');
  const expected = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET || '')
    .update(bodyBuffer)
    .digest('base64');

  const expectedBuffer = Buffer.from(expected);
  const headerBuffer = Buffer.from(String(hmacHeader || ''));
  if (expectedBuffer.length !== headerBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, headerBuffer);
}

function buildOrdersCreateWebhookUrl(req) {
  return `${getTrackerBaseUrl(req)}/webhooks/orders-create`;
}

function buildWebhookTrackerBarcode(orderPayload) {
  const name = String(orderPayload?.name || '').trim();
  if (name) return normalizeScanBarcode(name);

  const orderNumber = String(orderPayload?.order_number || '').trim();
  if (orderNumber) return normalizeScanBarcode(`ORDER-${orderNumber}`);

  const numericId = String(orderPayload?.id || '').trim();
  if (numericId) return normalizeScanBarcode(`ORDER-${numericId}`);

  return '';
}

function buildWebhookLineItems(lineItems = []) {
  return (lineItems || [])
    .map((lineItem) => {
      const quantity = Math.max(0, Number(lineItem?.current_quantity ?? lineItem?.quantity) || 0);
      if (quantity <= 0) return null;

      return {
        title: String(lineItem?.title || '').trim(),
        variantTitle: String(lineItem?.variant_title || '').trim(),
        sku: String(lineItem?.sku || '').trim(),
        quantity,
      };
    })
    .filter(Boolean);
}

async function ensureOrdersCreateWebhookSubscription({ client, shop, req }) {
  if (!client || !shop) return false;
  if (webhookRegistrationCheckedShops.has(shop)) {
    return true;
  }

  const callbackUrl = buildOrdersCreateWebhookUrl(req);
  const query = `
    query getWebhookSubscriptions {
      webhookSubscriptions(first: 50) {
        edges {
          node {
            id
            topic
            endpoint {
              __typename
              ... on WebhookHttpEndpoint {
                callbackUrl
              }
            }
          }
        }
      }
    }
  `;

  const response = await client.graphql(query);
  const subscriptions = response.data?.webhookSubscriptions?.edges || [];
  const matchingSubscription = subscriptions.find((edge) => {
    const node = edge?.node;
    const topic = String(node?.topic || '').trim().toUpperCase();
    const existingCallbackUrl = String(node?.endpoint?.callbackUrl || '').trim();
    return topic === 'ORDERS_CREATE' && existingCallbackUrl === callbackUrl;
  });

  if (matchingSubscription) {
    webhookRegistrationCheckedShops.add(shop);
    return true;
  }

  const mutation = `
    mutation createOrdersCreateWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription {
          id
          topic
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const createResponse = await client.graphql(mutation, {
    variables: {
      topic: 'ORDERS_CREATE',
      webhookSubscription: {
        uri: callbackUrl,
        format: 'JSON',
        includeFields: [
          'id',
          'name',
          'order_number',
          'created_at',
          'note',
          'tags',
          'cancelled_at',
          'fulfillment_status',
          'line_items',
        ],
      },
    },
  });

  const userErrors = createResponse.data?.webhookSubscriptionCreate?.userErrors || [];
  if (userErrors.length) {
    const message = userErrors.map((error) => error.message).join('; ');
    throw new Error(`Failed to register orders/create webhook: ${message}`);
  }

  webhookRegistrationCheckedShops.add(shop);
  return true;
}

function formatOrderStatusLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ');
}

function getOrderWorkflowBlock(order) {
  if (!order) return null;

  if (order.cancelledAt) {
    const cancelReason = formatOrderStatusLabel(order.cancelReason);
    const reasonText = cancelReason ? ` (${cancelReason})` : '';
    return {
      code: 'cancelled',
      status: 'CANCELLED',
      message: `Order ${order.name} is cancelled${reasonText}. Do not pick or build this order.`,
    };
  }

  const fulfillmentStatus = String(order.displayFulfillmentStatus || '').trim().toUpperCase();
  if (BLOCKED_FULFILLMENT_STATUSES.has(fulfillmentStatus)) {
    return {
      code: fulfillmentStatus.toLowerCase(),
      status: fulfillmentStatus,
      message: `Order ${order.name} is ${formatOrderStatusLabel(fulfillmentStatus)}. Do not pick or build this order.`,
    };
  }

  return null;
}

function canManageShippingDespiteWorkflowBlock(workflowBlock) {
  const status = String(workflowBlock?.status || workflowBlock?.code || '').trim().toUpperCase();
  return status === 'FULFILLED' || status === 'PARTIALLY_FULFILLED';
}

function normalizeFinancialStatus(value) {
  return String(value || '').trim().toUpperCase();
}

function getOrderPaymentState(order) {
  const financialStatus = normalizeFinancialStatus(order?.displayFinancialStatus);
  const canShip = SHIPPING_ALLOWED_FINANCIAL_STATUSES.has(financialStatus);
  const label = financialStatus ? formatOrderStatusLabel(financialStatus) : 'unknown';
  return {
    financialStatus,
    canShip,
    message: canShip
      ? ''
      : `Order ${order?.name || ''} is payment ${label}. Ask the customer to pay in Shopify before buying a shipping label.`,
  };
}

function getOrderTrackerStageForShipping(order) {
  return deriveTrackerStage({
    explicitTag: '',
    tags: order?.tags,
    cancelledAt: order?.cancelledAt,
    displayFulfillmentStatus: order?.displayFulfillmentStatus,
    orderNote: order?.note,
  });
}

function getShippingLabelPurchaseBlock(order) {
  const trackerStage = getOrderTrackerStageForShipping(order);
  if (SHIPPING_LABEL_PURCHASE_STAGE_KEYS.has(trackerStage.key)) {
    return null;
  }

  return {
    code: 'not_packaged',
    currentStage: {
      key: trackerStage.key,
      label: trackerStage.label,
    },
    message: 'Mark this order as Packaged before buying a shipping label.',
  };
}

function getShippingOrderQuery() {
  return `
    query getOrderForShipping($query: String!) {
      orders(first: ${ORDER_LOOKUP_CANDIDATE_LIMIT}, query: $query) {
        edges {
          node {
            id
            name
            note
            tags
            shippingAddress {
              name
              company
              firstName
              lastName
              country
              countryCodeV2
            }
            customer {
              displayName
              firstName
              lastName
            }
            ${ORDER_WORKFLOW_STATUS_FIELDS}
          }
        }
      }
    }
  `;
}

async function findOrderForShipping({ client, barcode }) {
  const normalizedBarcode = normalizeScanBarcode(barcode);
  if (!normalizedBarcode) return null;

  const response = await client.graphql(getShippingOrderQuery(), {
    variables: {
      query: buildOrderSearchQuery(normalizedBarcode),
    },
  });

  return selectExactOrderNode(response, normalizedBarcode);
}

function buildPackingLabelCustomerName(order) {
  const shippingAddress = order?.shippingAddress || {};
  const customer = order?.customer || {};
  const shippingName = String(shippingAddress.name || '').trim();
  const shippingCompany = String(shippingAddress.company || '').trim();
  const shippingPartsName = [shippingAddress.firstName, shippingAddress.lastName]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  const customerDisplayName = String(customer.displayName || '').trim();
  const customerPartsName = [customer.firstName, customer.lastName]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');

  return shippingName || shippingCompany || shippingPartsName || customerDisplayName || customerPartsName || '';
}

function buildPackingLabelCountry(order) {
  const shippingAddress = order?.shippingAddress || {};
  return String(shippingAddress.country || shippingAddress.countryCodeV2 || '').trim();
}

function buildShippingOrderIdentifiers({ order, barcode }) {
  const values = [
    barcode,
    order?.name,
    String(order?.name || '').replace(/^#/, ''),
  ];

  return Array.from(new Set(values
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

const APP_ORDER_NOTE_HEADING_PATTERNS = [
  /^AWAITING PARTS\b/i,
  /^ON HOLD\b/i,
  /^ORDER BUILT - AWAITING QUALITY CHECKS\b/i,
  /^ORDER PACKAGED - AWAITING COURIER COLLECTION\b/i,
  /^ORDER READY TO BE BUILT\b/i,
  /^QC FAIL\b/i,
  /^QUALITY CHECKS ESCALATED - AWAITING REBUILD\b/i,
  /^QUALITY CHECKS PASSED - AWAITING SHIPPING\b/i,
  /^WHOLESALE ADAPTER BUILT\b/i,
];

function stripAppOrderNoteBlocks(orderNote) {
  const rawNote = String(orderNote || '').trim();
  if (!rawNote) return '';

  const segments = rawNote.includes('~')
    ? rawNote.split('~').map((segment) => segment.trim()).filter(Boolean)
    : [rawNote];

  return segments
    .filter((segment) => {
      const firstLine = segment
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) || '';
      return !APP_ORDER_NOTE_HEADING_PATTERNS.some((pattern) => pattern.test(firstLine));
    })
    .join('\n\n')
    .trim();
}

function summarizeNewOrderQueueItem(order) {
  if (!order?.id) return null;
  const lineItems = Array.isArray(order.lineItems?.edges)
    ? buildCurrentOrderLineItems(order.lineItems.edges)
    : [];
  const itemCount = lineItems.reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0);
  return {
    id: order.id,
    orderNumber: String(order.name || '').trim(),
    barcode: normalizeScanBarcode(order.name || ''),
    createdAt: order.createdAt || '',
    tags: normalizeOrderTags(order.tags),
    financialStatus: String(order.displayFinancialStatus || '').trim(),
    fulfillmentStatus: String(order.displayFulfillmentStatus || '').trim(),
    itemCount,
    firstItemTitle: String(lineItems[0]?.title || '').trim(),
    orderNote: stripAppOrderNoteBlocks(order.note),
  };
}

async function listNewOrderQueueOrders({ client, maxOrders = 1000, pageSize = 100 } = {}) {
  const safeMaxOrders = Math.max(1, Math.min(1000, Math.floor(Number(maxOrders) || 1000)));
  const safePageSize = Math.max(1, Math.min(250, Math.floor(Number(pageSize) || 100)));
  const query = `
    query getNewOrderQueue($first: Int!, $after: String) {
      orders(first: $first, after: $after, query: "tag:new_order status:open", sortKey: CREATED_AT, reverse: false) {
        edges {
          cursor
          node {
            id
            name
            createdAt
            note
            tags
            ${ORDER_WORKFLOW_STATUS_FIELDS}
            lineItems(first: 10) {
              edges {
                node {
                  id
                  title
                  sku
                  quantity
                  currentQuantity
                  variantTitle
                  product {
                    id
                  }
                  variant {
                    barcode
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
  const orders = [];
  const seenOrderIds = new Set();
  let after = null;
  let hasNextPage = true;
  let pagesFetched = 0;

  while (hasNextPage && orders.length < safeMaxOrders) {
    const first = Math.min(safePageSize, safeMaxOrders - orders.length);
    const response = await client.graphql(query, {
      variables: {
        first,
        after,
      },
    });
    pagesFetched += 1;

    const connection = response.data?.orders || {};
    const edges = Array.isArray(connection.edges) ? connection.edges : [];
    edges.forEach((edge) => {
      const order = summarizeNewOrderQueueItem(edge?.node);
      if (!order?.barcode || seenOrderIds.has(order.id)) return;
      seenOrderIds.add(order.id);
      orders.push(order);
    });

    hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
    after = connection.pageInfo?.endCursor || edges[edges.length - 1]?.cursor || null;
    if (hasNextPage && !after) break;
  }

  return {
    orders,
    pagesFetched,
    hasMore: hasNextPage && orders.length >= safeMaxOrders,
    maxOrders: safeMaxOrders,
  };
}

function parseOrderFlowPositiveNumber(value, fallback, { min = 0.25, max = 720 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseOrderFlowWorkingDays(value, fallback, { min = 0.25, max = 60 } = {}) {
  return parseOrderFlowPositiveNumber(value, fallback, { min, max });
}

function parseOrderFlowStageWorkingDays(value) {
  let rawValue = value;
  if (typeof rawValue === 'string') {
    try {
      rawValue = JSON.parse(rawValue);
    } catch (err) {
      rawValue = {};
    }
  }

  const rawThresholds = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
    ? rawValue
    : {};

  return Object.keys(ORDER_FLOW_STAGE_THRESHOLDS_WORKING_DAYS).reduce((acc, stageKey) => {
    acc[stageKey] = parseOrderFlowWorkingDays(
      rawThresholds[stageKey],
      ORDER_FLOW_STAGE_THRESHOLDS_WORKING_DAYS[stageKey],
      { min: 0.25, max: 60 }
    );
    return acc;
  }, {});
}

function getOrderFlowStageThresholdWorkingDays(
  stageKey,
  stageWorkingDays = ORDER_FLOW_STAGE_THRESHOLDS_WORKING_DAYS,
  fallbackWorkingDays = ORDER_FLOW_DEFAULT_STAGE_THRESHOLD_WORKING_DAYS
) {
  const normalizedStageKey = String(stageKey || '').trim();
  const stageThreshold = Number(stageWorkingDays?.[normalizedStageKey]);
  return Number.isFinite(stageThreshold) && stageThreshold > 0 ? stageThreshold : fallbackWorkingDays;
}

function normalizeOrderFlowExceptionStack(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'wholesale') return 'wholesale';
  if (normalized === 'proto' || normalized === 'prototype') return 'proto';
  return 'snoozed';
}

function getOrderFlowDateMs(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

function getOrderFlowElapsedCalendarHours(nowMs, value) {
  const dateMs = getOrderFlowDateMs(value);
  if (!dateMs) return null;
  return Math.max(0, (nowMs - dateMs) / 3600000);
}

function isOrderFlowWorkingDay(date) {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

function getOrderFlowElapsedWorkingDays(nowMs, value) {
  const startMs = getOrderFlowDateMs(value);
  if (!startMs || !Number.isFinite(nowMs) || nowMs <= startMs) return null;

  let cursor = new Date(startMs);
  const endMs = nowMs;
  let workingMs = 0;

  while (cursor.getTime() < endMs) {
    const dayEnd = new Date(cursor);
    dayEnd.setHours(24, 0, 0, 0);
    const segmentEndMs = Math.min(dayEnd.getTime(), endMs);

    if (isOrderFlowWorkingDay(cursor)) {
      workingMs += Math.max(0, segmentEndMs - cursor.getTime());
    }

    cursor = new Date(segmentEndMs);
  }

  return workingMs / 86400000;
}

function getOrderFlowLatestStaff(tracker) {
  const events = Array.isArray(tracker?.events) ? tracker.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const staff = String(events[index]?.staff || '').trim();
    if (staff) return staff;
  }
  return '';
}

function getOrderFlowTrackerStage(tracker, shopifyOrder = null) {
  if (tracker?.currentStageKey) {
    return {
      key: String(tracker.currentStageKey || '').trim(),
      label: String(tracker.currentStageLabel || '').trim() || formatOrderStatusLabel(tracker.currentStageKey),
    };
  }

  const derived = deriveTrackerStage({
    explicitTag: '',
    tags: shopifyOrder?.tags || [],
    cancelledAt: shopifyOrder?.cancelledAt,
    displayFulfillmentStatus: shopifyOrder?.fulfillmentStatus || shopifyOrder?.displayFulfillmentStatus,
    orderNote: shopifyOrder?.orderNote || shopifyOrder?.note || '',
  });
  return {
    key: derived.key,
    label: derived.label,
  };
}

function getOrderFlowMoneyBagValue(...moneyBags) {
  for (const moneyBag of moneyBags) {
    const money = moneyBag?.shopMoney || moneyBag?.presentmentMoney || moneyBag || null;
    const amount = Number(money?.amount);
    const currencyCode = String(money?.currencyCode || money?.currency || '').trim().toUpperCase();
    if (Number.isFinite(amount) && currencyCode) {
      return {
        amount,
        currencyCode,
      };
    }
  }
  return null;
}

function getOrderFlowLineItemCount(lineItems) {
  return (Array.isArray(lineItems) ? lineItems : [])
    .reduce((sum, item) => sum + Math.max(0, Number(item?.quantity) || 0), 0);
}

function getOrderFlowFirstItemTitle(lineItems) {
  const firstItem = (Array.isArray(lineItems) ? lineItems : [])
    .find((item) => String(item?.title || '').trim());
  return String(firstItem?.title || '').trim();
}

function summarizeOrderFlowShopifyOrder(order) {
  if (!order?.id) return null;
  const lineItems = Array.isArray(order.lineItems?.edges)
    ? buildCurrentOrderLineItems(order.lineItems.edges)
    : [];
  const orderLevelItemCount = Number(order.currentSubtotalLineItemsQuantity ?? order.subtotalLineItemsQuantity);
  const orderValue = getOrderFlowMoneyBagValue(order.currentTotalPriceSet, order.totalPriceSet);
  const itemCount = Number.isFinite(orderLevelItemCount)
    ? Math.max(0, orderLevelItemCount)
    : getOrderFlowLineItemCount(lineItems);
  return {
    id: String(order.id || '').trim(),
    orderNumber: String(order.name || '').trim(),
    barcode: normalizeScanBarcode(order.name || ''),
    createdAt: order.createdAt || '',
    updatedAt: order.updatedAt || '',
    tags: normalizeOrderTags(order.tags),
    financialStatus: String(order.displayFinancialStatus || '').trim(),
    fulfillmentStatus: String(order.displayFulfillmentStatus || '').trim(),
    cancelledAt: order.cancelledAt || null,
    cancelReason: String(order.cancelReason || '').trim(),
    itemCount,
    orderValue,
    firstItemTitle: getOrderFlowFirstItemTitle(lineItems),
    orderNote: order.note ? stripAppOrderNoteBlocks(order.note) : '',
  };
}

async function listOrderFlowOpenOrders({ client, maxOrders = 500, pageSize = 100 } = {}) {
  const safeMaxOrders = Math.max(1, Math.min(1000, Math.floor(Number(maxOrders) || 500)));
  const safePageSize = Math.max(1, Math.min(250, Math.floor(Number(pageSize) || 100)));
  const query = `
    query getOrderFlowOpenOrders($first: Int!, $after: String) {
      orders(first: $first, after: $after, query: "status:open", sortKey: CREATED_AT, reverse: false) {
        edges {
          cursor
          node {
            id
            name
            createdAt
            updatedAt
            tags
            ${ORDER_WORKFLOW_STATUS_FIELDS}
            lineItems(first: 10) {
              edges {
                node {
                  id
                  title
                  sku
                  quantity
                  currentQuantity
                  variantTitle
                  product {
                    id
                  }
                  variant {
                    barcode
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const orders = [];
  const seenOrderIds = new Set();
  let after = null;
  let hasNextPage = true;
  let pagesFetched = 0;

  while (hasNextPage && orders.length < safeMaxOrders) {
    const first = Math.min(safePageSize, safeMaxOrders - orders.length);
    const response = await client.graphql(query, {
      variables: {
        first,
        after,
      },
    });
    pagesFetched += 1;

    const connection = response.data?.orders || {};
    const edges = Array.isArray(connection.edges) ? connection.edges : [];
    edges.forEach((edge) => {
      const order = summarizeOrderFlowShopifyOrder(edge?.node);
      if (!order?.id || seenOrderIds.has(order.id)) return;
      seenOrderIds.add(order.id);
      orders.push(order);
    });

    hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
    after = connection.pageInfo?.endCursor || edges[edges.length - 1]?.cursor || null;
    if (hasNextPage && !after) break;
  }

  return {
    orders,
    pagesFetched,
    hasMore: hasNextPage && orders.length >= safeMaxOrders,
    maxOrders: safeMaxOrders,
  };
}

async function listOrderFlowOrdersByIds({ client, orderIds = [], chunkSize = 50 } = {}) {
  const ids = Array.from(new Set(
    (Array.isArray(orderIds) ? orderIds : [])
      .map((orderId) => String(orderId || '').trim())
      .filter(Boolean)
  ));
  if (!ids.length) return [];

  const safeChunkSize = Math.max(1, Math.min(100, Math.floor(Number(chunkSize) || 50)));
  const query = `
    query getOrderFlowOrdersByIds($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order {
          id
          name
          createdAt
          updatedAt
          tags
          ${ORDER_WORKFLOW_STATUS_FIELDS}
          lineItems(first: 10) {
            edges {
              node {
                id
                title
                sku
                quantity
                currentQuantity
                variantTitle
                product {
                  id
                }
                variant {
                  barcode
                }
              }
            }
          }
        }
      }
    }
  `;
  const orders = [];

  for (let index = 0; index < ids.length; index += safeChunkSize) {
    const chunk = ids.slice(index, index + safeChunkSize);
    const response = await client.graphql(query, {
      variables: {
        ids: chunk,
      },
    });
    const nodes = Array.isArray(response.data?.nodes) ? response.data.nodes : [];
    nodes.forEach((node) => {
      const order = summarizeOrderFlowShopifyOrder(node);
      if (order?.id) orders.push(order);
    });
  }

  return orders;
}

function isOrderFlowTrackerTerminal(tracker) {
  const workflowStatus = String(tracker?.workflowStatus || '').trim().toUpperCase();
  return Boolean(tracker?.currentStageIsTerminal) || ORDER_FLOW_TERMINAL_WORKFLOW_STATUSES.has(workflowStatus);
}

function isOrderFlowShopifyOrderTerminal(order) {
  if (!order) return false;
  if (order.cancelledAt) return true;
  const fulfillmentStatus = String(order.fulfillmentStatus || order.displayFulfillmentStatus || '')
    .trim()
    .toUpperCase();
  return ORDER_FLOW_TERMINAL_WORKFLOW_STATUSES.has(fulfillmentStatus);
}

function syncOrderFlowTerminalTracker({ shop, tracker, shopifyOrder }) {
  if (!shop || !tracker?.orderId || !shopifyOrder || !isOrderFlowShopifyOrderTerminal(shopifyOrder)) {
    return false;
  }

  const terminalStage = deriveTrackerStage({
    explicitTag: '',
    tags: shopifyOrder.tags,
    cancelledAt: shopifyOrder.cancelledAt,
    displayFulfillmentStatus: shopifyOrder.fulfillmentStatus || shopifyOrder.displayFulfillmentStatus,
    orderNote: shopifyOrder.orderNote || shopifyOrder.note || '',
  });
  if (!terminalStage?.isTerminal) return false;

  if (isOrderFlowTrackerTerminal(tracker)) {
    return true;
  }

  try {
    sessionsStore.saveOrderTrackerSnapshot({
      shop,
      orderId: tracker.orderId || shopifyOrder.id,
      barcode: tracker.barcode || shopifyOrder.barcode || shopifyOrder.orderNumber,
      orderNumber: tracker.orderNumber || shopifyOrder.orderNumber,
      orderCreatedAt: tracker.orderCreatedAt || shopifyOrder.createdAt || null,
      currentStage: terminalStage,
      workflowStatus: shopifyOrder.cancelledAt
        ? 'CANCELLED'
        : String(shopifyOrder.fulfillmentStatus || shopifyOrder.displayFulfillmentStatus || '').trim(),
      lineItems: Array.isArray(tracker.lineItems) ? tracker.lineItems : [],
      legacyEvents: [],
      appendEventIfStageChanged: true,
      sourceTag: terminalStage.key,
      staff: null,
    });
  } catch (err) {
    console.error('Order Flow terminal tracker sync failed:', err);
  }

  return true;
}

function getOrderFlowIssueKey({ orderId, barcode, type, stageKey }) {
  const sourceRef = String(orderId || barcode || '').trim();
  const normalizedType = String(type || '').trim();
  const normalizedStageKey = String(stageKey || '').trim();
  const rawKey = [sourceRef, normalizedType, normalizedStageKey].join('|');
  return `of_${crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 32)}`;
}

function buildOrderFlowIssue({
  type,
  severity,
  reason,
  shopifyOrder = null,
  tracker = null,
  nowMs,
  thresholdWorkingDays = null,
  source = 'shopify',
}) {
  const stage = getOrderFlowTrackerStage(tracker, shopifyOrder);
  const trackerLineItems = Array.isArray(tracker?.lineItems) ? tracker.lineItems : [];
  const orderId = String(shopifyOrder?.id || tracker?.orderId || '').trim();
  const orderNumber = String(shopifyOrder?.orderNumber || tracker?.orderNumber || '').trim();
  const barcode = normalizeScanBarcode(shopifyOrder?.barcode || tracker?.barcode || orderNumber);
  const createdAt = shopifyOrder?.createdAt || tracker?.orderCreatedAt || null;
  const lastEventAt = tracker?.lastEventAt || tracker?.updatedAt || null;
  const ageWorkingDays = getOrderFlowElapsedWorkingDays(nowMs, createdAt);
  const idleWorkingDays = getOrderFlowElapsedWorkingDays(nowMs, lastEventAt);
  const ageCalendarHours = getOrderFlowElapsedCalendarHours(nowMs, createdAt);
  const idleCalendarHours = getOrderFlowElapsedCalendarHours(nowMs, lastEventAt);
  const tags = Array.from(new Set([
    ...normalizeOrderTags(shopifyOrder?.tags),
  ])).sort((left, right) => left.localeCompare(right));
  const issueKey = getOrderFlowIssueKey({
    orderId,
    barcode,
    type,
    stageKey: stage.key,
  });

  return {
    issueKey,
    type,
    severity,
    reason,
    source,
    orderId,
    orderNumber,
    barcode,
    createdAt,
    updatedAt: tracker?.updatedAt || shopifyOrder?.updatedAt || null,
    lastEventAt,
    ageWorkingDays: ageWorkingDays == null ? null : Number(ageWorkingDays.toFixed(2)),
    idleWorkingDays: idleWorkingDays == null ? null : Number(idleWorkingDays.toFixed(2)),
    ageCalendarHours: ageCalendarHours == null ? null : Number(ageCalendarHours.toFixed(1)),
    idleCalendarHours: idleCalendarHours == null ? null : Number(idleCalendarHours.toFixed(1)),
    thresholdWorkingDays,
    currentStage: stage,
    trackerExists: Boolean(tracker),
    shopifyOpen: source !== 'local_tracker' && Boolean(shopifyOrder),
    tags,
    financialStatus: String(shopifyOrder?.financialStatus || '').trim(),
    fulfillmentStatus: String(shopifyOrder?.fulfillmentStatus || tracker?.workflowStatus || '').trim(),
    itemCount: Math.max(0, Number(shopifyOrder?.itemCount ?? getOrderFlowLineItemCount(trackerLineItems)) || 0),
    orderValue: shopifyOrder?.orderValue || null,
    firstItemTitle: String(shopifyOrder?.firstItemTitle || getOrderFlowFirstItemTitle(trackerLineItems)).trim(),
    lastStaff: getOrderFlowLatestStaff(tracker),
  };
}

function sortOrderFlowIssues(left, right) {
  const severityRank = { critical: 0, warning: 1, info: 2 };
  const severityDiff = (severityRank[left.severity] ?? 9) - (severityRank[right.severity] ?? 9);
  if (severityDiff !== 0) return severityDiff;

  const leftAge = Math.max(Number(left.idleWorkingDays || 0), Number(left.ageWorkingDays || 0));
  const rightAge = Math.max(Number(right.idleWorkingDays || 0), Number(right.ageWorkingDays || 0));
  if (rightAge !== leftAge) return rightAge - leftAge;

  return String(left.orderNumber || '').localeCompare(String(right.orderNumber || ''));
}

function getOrderFlowGridIssueRank(issue) {
  const severity = String(issue?.severity || issue?.issueSeverity || '').trim();
  if (severity === 'critical') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

function getOrderFlowGridOrderSortValue(order = {}) {
  return String(order?.orderNumber || order?.barcode || order?.orderId || '').trim();
}

function buildOrderFlowGridOrder({
  shopifyOrder = null,
  tracker = null,
  issue = null,
  nowMs,
  newOrderWorkingDays,
  fallbackStaleWorkingDays,
  stageWorkingDays,
  source = 'shopify',
} = {}) {
  const stage = getOrderFlowTrackerStage(tracker, shopifyOrder);
  const trackerLineItems = Array.isArray(tracker?.lineItems) ? tracker.lineItems : [];
  const orderId = String(shopifyOrder?.id || tracker?.orderId || '').trim();
  const orderNumber = String(shopifyOrder?.orderNumber || tracker?.orderNumber || '').trim();
  const barcode = normalizeScanBarcode(shopifyOrder?.barcode || tracker?.barcode || orderNumber);
  const createdAt = shopifyOrder?.createdAt || tracker?.orderCreatedAt || null;
  const lastEventAt = tracker?.lastEventAt || tracker?.updatedAt || shopifyOrder?.updatedAt || createdAt || null;
  const ageWorkingDays = getOrderFlowElapsedWorkingDays(nowMs, createdAt);
  const idleWorkingDays = getOrderFlowElapsedWorkingDays(nowMs, lastEventAt);
  const thresholdWorkingDays = tracker
    ? getOrderFlowStageThresholdWorkingDays(stage.key, stageWorkingDays, fallbackStaleWorkingDays)
    : newOrderWorkingDays;
  const ageBasisWorkingDays = tracker
    ? (idleWorkingDays ?? ageWorkingDays ?? 0)
    : (ageWorkingDays ?? idleWorkingDays ?? 0);
  const ageRatio = thresholdWorkingDays > 0
    ? ageBasisWorkingDays / thresholdWorkingDays
    : 0;
  const tags = Array.from(new Set([
    ...normalizeOrderTags(shopifyOrder?.tags),
  ])).sort((left, right) => left.localeCompare(right));

  if (!orderId && !barcode) return null;

  return {
    orderId,
    orderNumber,
    barcode,
    createdAt,
    updatedAt: tracker?.updatedAt || shopifyOrder?.updatedAt || null,
    lastEventAt,
    currentStage: stage,
    ageWorkingDays: ageWorkingDays == null ? null : Number(ageWorkingDays.toFixed(2)),
    idleWorkingDays: idleWorkingDays == null ? null : Number(idleWorkingDays.toFixed(2)),
    thresholdWorkingDays,
    ageRatio: Number(Math.max(0, ageRatio).toFixed(2)),
    issueKey: issue?.issueKey || null,
    issueType: issue?.type || null,
    issueSeverity: issue?.severity || null,
    issueReason: issue?.reason || '',
    issueStack: issue?.exceptionStack?.key || null,
    trackerExists: Boolean(tracker),
    shopifyOpen: Boolean(shopifyOrder),
    source,
    tags,
    financialStatus: String(shopifyOrder?.financialStatus || '').trim(),
    fulfillmentStatus: String(shopifyOrder?.fulfillmentStatus || tracker?.workflowStatus || '').trim(),
    itemCount: Math.max(0, Number(shopifyOrder?.itemCount ?? getOrderFlowLineItemCount(trackerLineItems)) || 0),
    orderValue: shopifyOrder?.orderValue || null,
    firstItemTitle: String(shopifyOrder?.firstItemTitle || getOrderFlowFirstItemTitle(trackerLineItems)).trim(),
    lastStaff: getOrderFlowLatestStaff(tracker),
  };
}

function sortOrderFlowGridOrders(left, right) {
  return getOrderFlowGridOrderSortValue(left).localeCompare(
    getOrderFlowGridOrderSortValue(right),
    'en-GB',
    { numeric: true, sensitivity: 'base' }
  );
}

async function buildOrderFlowOverview({ client, shop, query = {} }) {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const maxOpenOrders = Math.max(50, Math.min(1000, Math.floor(Number(query.maxOpenOrders) || 500)));
  const maxTrackers = Math.max(50, Math.min(2000, Math.floor(Number(query.maxTrackers) || 1000)));
  const legacyNewOrderWorkingDays = Number.isFinite(Number(query.newOrderHours))
    ? Number(query.newOrderHours) / 24
    : null;
  const legacyStaleWorkingDays = Number.isFinite(Number(query.staleHours))
    ? Number(query.staleHours) / 24
    : null;
  const newOrderWorkingDays = parseOrderFlowWorkingDays(
    query.newOrderWorkingDays ?? legacyNewOrderWorkingDays,
    ORDER_FLOW_DEFAULT_NEW_ORDER_WORKING_DAYS,
    { min: 0.25, max: 30 }
  );
  const fallbackStaleWorkingDays = parseOrderFlowWorkingDays(
    query.staleWorkingDays ?? legacyStaleWorkingDays,
    ORDER_FLOW_DEFAULT_STAGE_THRESHOLD_WORKING_DAYS,
    { min: 0.25, max: 60 }
  );
  const stageWorkingDays = parseOrderFlowStageWorkingDays(query.stageWorkingDays);

  const openOrderResult = await listOrderFlowOpenOrders({
    client,
    maxOrders: maxOpenOrders,
    pageSize: query.pageSize,
  });
  const openOrders = openOrderResult.orders;
  const openOrdersById = new Map(openOrders.map((order) => [order.id, order]));
  const trackers = sessionsStore.listOrderTrackers({
    shop,
    includeTerminal: false,
    limit: maxTrackers,
  });
  const trackersByOrderId = new Map(trackers.map((tracker) => [String(tracker.orderId || '').trim(), tracker]));
  const trackerOrderIdsMissingFromOpenOrders = trackers
    .map((tracker) => String(tracker.orderId || '').trim())
    .filter((orderId) => orderId && !openOrdersById.has(orderId));
  let trackedShopifyOrders = [];
  if (trackerOrderIdsMissingFromOpenOrders.length) {
    try {
      trackedShopifyOrders = await listOrderFlowOrdersByIds({
        client,
        orderIds: trackerOrderIdsMissingFromOpenOrders,
      });
    } catch (err) {
      console.error('Order Flow tracker status refresh failed:', err);
    }
  }
  const trackedShopifyOrdersById = new Map(trackedShopifyOrders.map((order) => [order.id, order]));
  const terminalTrackerOrderIds = new Set();
  const issues = [];
  const issueKeys = new Set();

  const addIssue = (issue) => {
    if (!issue?.orderId || !issue?.type) return;
    const key = `${issue.orderId}:${issue.type}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push(issue);
  };

  openOrders.forEach((order) => {
    const tracker = trackersByOrderId.get(order.id) || null;
    if (isOrderFlowShopifyOrderTerminal(order)) {
      if (syncOrderFlowTerminalTracker({ shop, tracker, shopifyOrder: order })) {
        terminalTrackerOrderIds.add(String(tracker?.orderId || order.id || '').trim());
      }
      return;
    }

    const tags = normalizeOrderTags(order.tags).map((tag) => tag.toLowerCase());
    const isNewOrder = tags.includes('new_order');
    const orderAgeWorkingDays = getOrderFlowElapsedWorkingDays(nowMs, order.createdAt) || 0;

    if (isNewOrder && orderAgeWorkingDays >= newOrderWorkingDays) {
      addIssue(buildOrderFlowIssue({
        type: 'unstarted',
        severity: 'critical',
        reason: tracker
          ? 'Open Shopify order is still tagged new_order and has not moved out of the Monitor flow.'
          : 'Open Shopify order is still tagged new_order and has no local tracker, so it may never have entered the picking flow.',
        shopifyOrder: order,
        tracker,
        nowMs,
        thresholdWorkingDays: newOrderWorkingDays,
        source: 'shopify',
      }));
      return;
    }

    if (!tracker && orderAgeWorkingDays >= newOrderWorkingDays) {
      addIssue(buildOrderFlowIssue({
        type: 'untracked',
        severity: 'critical',
        reason: 'Open Shopify order has no local tracker record, so it may be outside the internal flow.',
        shopifyOrder: order,
        tracker,
        nowMs,
        thresholdWorkingDays: newOrderWorkingDays,
        source: 'shopify',
      }));
      return;
    }

    if (!tracker || isOrderFlowTrackerTerminal(tracker)) {
      return;
    }

    const stageKey = String(tracker.currentStageKey || '').trim();
    const idleWorkingDays = getOrderFlowElapsedWorkingDays(nowMs, tracker.lastEventAt || tracker.updatedAt) || 0;

    const thresholdWorkingDays = getOrderFlowStageThresholdWorkingDays(stageKey, stageWorkingDays, fallbackStaleWorkingDays);
    if (idleWorkingDays >= thresholdWorkingDays) {
      addIssue(buildOrderFlowIssue({
        type: 'stale_stage',
        severity: idleWorkingDays >= thresholdWorkingDays * 2 ? 'critical' : 'warning',
        reason: `No recorded movement in ${tracker.currentStageLabel || stageKey} for ${idleWorkingDays.toFixed(2)} working days.`,
        shopifyOrder: order,
        tracker,
        nowMs,
        thresholdWorkingDays,
        source: 'tracker',
      }));
    }
  });

  trackers.forEach((tracker) => {
    const orderId = String(tracker?.orderId || '').trim();
    if (!orderId || openOrdersById.has(orderId) || isOrderFlowTrackerTerminal(tracker)) {
      return;
    }

    const refreshedShopifyOrder = trackedShopifyOrdersById.get(orderId) || null;
    if (isOrderFlowShopifyOrderTerminal(refreshedShopifyOrder)) {
      if (syncOrderFlowTerminalTracker({ shop, tracker, shopifyOrder: refreshedShopifyOrder })) {
        terminalTrackerOrderIds.add(orderId);
      }
      return;
    }

    const stageKey = String(tracker.currentStageKey || '').trim();
    const idleWorkingDays = getOrderFlowElapsedWorkingDays(nowMs, tracker.lastEventAt || tracker.updatedAt) || 0;
    const thresholdWorkingDays = getOrderFlowStageThresholdWorkingDays(stageKey, stageWorkingDays, fallbackStaleWorkingDays);
    if (idleWorkingDays < thresholdWorkingDays) return;

    addIssue(buildOrderFlowIssue({
      type: 'stale_stage',
      severity: idleWorkingDays >= thresholdWorkingDays * 2 ? 'critical' : 'warning',
      reason: `Local tracker has not moved in ${tracker.currentStageLabel || stageKey} for ${idleWorkingDays.toFixed(2)} working days.`,
      shopifyOrder: refreshedShopifyOrder,
      tracker,
      nowMs,
      thresholdWorkingDays,
      source: 'local_tracker',
    }));
  });

  issues.sort(sortOrderFlowIssues);

  const stageCounts = trackers.reduce((acc, tracker) => {
    const orderId = String(tracker?.orderId || '').trim();
    if (!tracker?.currentStageKey || terminalTrackerOrderIds.has(orderId) || isOrderFlowTrackerTerminal(tracker)) return acc;
    const key = String(tracker.currentStageKey);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const activeTrackerCount = trackers.filter((tracker) => {
    const orderId = String(tracker?.orderId || '').trim();
    return orderId && !terminalTrackerOrderIds.has(orderId) && !isOrderFlowTrackerTerminal(tracker);
  }).length;
  const snoozesByIssueKey = new Map(
    sessionsStore.listOrderFlowSnoozes({ shop, includeDeleted: true })
      .map((snooze) => [snooze.issueKey, snooze])
  );
  const activeIssues = [];
  const exceptionStacks = Object.keys(ORDER_FLOW_EXCEPTION_STACK_LABELS).reduce((acc, stackKey) => {
    acc[stackKey] = {
      key: stackKey,
      label: ORDER_FLOW_EXCEPTION_STACK_LABELS[stackKey],
      count: 0,
      issues: [],
    };
    return acc;
  }, {});

  issues.forEach((issue) => {
    const snooze = snoozesByIssueKey.get(issue.issueKey);
    if (snooze?.deletedAt) {
      return;
    }

    if (!snooze) {
      activeIssues.push(issue);
      return;
    }

    const stackKey = normalizeOrderFlowExceptionStack(snooze.stack);
    const stackLabel = ORDER_FLOW_EXCEPTION_STACK_LABELS[stackKey] || ORDER_FLOW_EXCEPTION_STACK_LABELS.snoozed;
    const stackedIssue = {
      ...issue,
      exceptionStack: {
        key: stackKey,
        label: stackLabel,
        by: snooze.snoozedBy || '',
        at: snooze.snoozedAt || null,
      },
    };
    if (stackKey === 'snoozed') {
      stackedIssue.snoozed = {
        by: snooze.snoozedBy || '',
        at: snooze.snoozedAt || null,
      };
    }
    exceptionStacks[stackKey].issues.push(stackedIssue);
  });

  Object.values(exceptionStacks).forEach((stack) => {
    stack.count = stack.issues.length;
  });

  const issueByOrderId = new Map();
  const setIssueForGridOrder = (issue) => {
    const orderId = String(issue?.orderId || '').trim();
    if (!orderId) return;

    const existing = issueByOrderId.get(orderId);
    if (!existing || getOrderFlowGridIssueRank(issue) < getOrderFlowGridIssueRank(existing)) {
      issueByOrderId.set(orderId, issue);
    }
  };
  activeIssues.forEach(setIssueForGridOrder);
  Object.values(exceptionStacks).forEach((stack) => {
    (Array.isArray(stack?.issues) ? stack.issues : []).forEach(setIssueForGridOrder);
  });

  const gridOrders = [];
  const gridOrderIds = new Set();
  const addGridOrder = ({ shopifyOrder = null, tracker = null, source = 'shopify' } = {}) => {
    const orderId = String(shopifyOrder?.id || tracker?.orderId || '').trim();
    if (!orderId || gridOrderIds.has(orderId)) return;
    const issue = issueByOrderId.get(orderId) || null;
    const gridOrder = buildOrderFlowGridOrder({
      shopifyOrder,
      tracker,
      issue,
      nowMs,
      newOrderWorkingDays,
      fallbackStaleWorkingDays,
      stageWorkingDays,
      source,
    });
    if (!gridOrder) return;
    gridOrderIds.add(orderId);
    gridOrders.push(gridOrder);
  };

  openOrders.forEach((order) => {
    if (!order?.id || isOrderFlowShopifyOrderTerminal(order)) return;
    const tracker = trackersByOrderId.get(order.id) || null;
    const trackerOrderId = String(tracker?.orderId || '').trim();
    if (trackerOrderId && terminalTrackerOrderIds.has(trackerOrderId)) return;
    addGridOrder({ shopifyOrder: order, tracker, source: tracker ? 'tracker' : 'shopify' });
  });

  trackers.forEach((tracker) => {
    const orderId = String(tracker?.orderId || '').trim();
    if (
      !orderId
      || gridOrderIds.has(orderId)
      || terminalTrackerOrderIds.has(orderId)
      || isOrderFlowTrackerTerminal(tracker)
    ) {
      return;
    }

    const refreshedShopifyOrder = trackedShopifyOrdersById.get(orderId) || null;
    if (isOrderFlowShopifyOrderTerminal(refreshedShopifyOrder)) return;
    addGridOrder({
      shopifyOrder: refreshedShopifyOrder,
      tracker,
      source: refreshedShopifyOrder ? 'tracker' : 'local_tracker',
    });
  });
  gridOrders.sort(sortOrderFlowGridOrders);

  return {
    generatedAt: nowIso,
    shop,
    thresholds: {
      unit: 'working_days',
      workingDayDefinition: 'Monday-Friday calendar days',
      newOrderWorkingDays,
      fallbackStaleWorkingDays,
      stageWorkingDays: {
        ...stageWorkingDays,
      },
    },
    scan: {
      openOrdersScanned: openOrders.length,
      openOrderPagesFetched: openOrderResult.pagesFetched,
      openOrderHasMore: openOrderResult.hasMore,
      maxOpenOrders: openOrderResult.maxOrders,
      activeTrackersScanned: activeTrackerCount,
      maxTrackers,
    },
    summary: {
      issueCount: activeIssues.length,
      criticalCount: activeIssues.filter((issue) => issue.severity === 'critical').length,
      warningCount: activeIssues.filter((issue) => issue.severity === 'warning').length,
      untrackedCount: activeIssues.filter((issue) => issue.type === 'untracked').length,
      unstartedCount: activeIssues.filter((issue) => issue.type === 'unstarted').length,
      staleStageCount: activeIssues.filter((issue) => issue.type === 'stale_stage').length,
      snoozedCount: exceptionStacks.snoozed.count,
      wholesaleCount: exceptionStacks.wholesale.count,
      protoCount: exceptionStacks.proto.count,
      openOrdersScanned: openOrders.length,
      activeTrackersScanned: activeTrackerCount,
      gridOrderCount: gridOrders.length,
      stageCounts,
    },
    orders: gridOrders,
    issues: activeIssues,
    exceptionStacks,
    snoozed: {
      count: exceptionStacks.snoozed.count,
      issues: exceptionStacks.snoozed.issues,
    },
  };
}

function summarizeShippingLabel(label) {
  if (!label) return null;
  const packages = Array.isArray(label.packages)
    ? label.packages
    : (Array.isArray(label.label?.packages) ? label.label.packages : []);
  return {
    labelId: String(label.labelId || '').trim(),
    shipmentId: String(label.shipmentId || '').trim(),
    rateId: String(label.rateId || '').trim(),
    trackingNumber: String(label.trackingNumber || '').trim(),
    labelUrl: String(label.labelUrl || '').trim(),
    status: String(label.status || '').trim(),
    priceAmount: Number(label.priceAmount || label.shipmentCost?.amount || 0),
    priceCurrency: String(label.priceCurrency || label.shipmentCost?.currency || '').trim().toUpperCase(),
    printNodeJobId: String(label.printNodeJobId || '').trim(),
    printStatus: String(label.printStatus || '').trim(),
    printError: String(label.printError || '').trim(),
    packages: packages.map((pkg, index) => ({
      sequence: Number(pkg.sequence || index + 1),
      trackingNumber: String(pkg.trackingNumber || pkg.tracking_number || '').trim(),
      weight: pkg.weight || null,
      dimensions: pkg.dimensions || null,
    })),
    packageCount: packages.length || 1,
    createdAt: label.createdAt || null,
    updatedAt: label.updatedAt || null,
    printedAt: label.printedAt || null,
  };
}

function isReusableShippingLabel(label) {
  const status = String(label?.status || '').trim().toLowerCase();
  return Boolean(label?.labelId && status !== 'voided' && status !== 'error');
}

function isRoyalMailShippingEntity(entity) {
  const haystack = [
    entity?.carrierCode,
    entity?.carrierName,
    entity?.carrierFriendlyName,
    entity?.serviceCode,
    entity?.serviceName,
    entity?.serviceType,
    entity?.requestedShipmentService,
    entity?.raw?.carrier_code,
    entity?.raw?.carrier_friendly_name,
    entity?.raw?.service_code,
    entity?.raw?.service_type,
    entity?.raw?.requested_shipment_service,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\broyal\s*mail\b/.test(haystack) || /\broyal_mail\b/.test(haystack);
}

function isUkCountryCode(countryCode) {
  const code = String(countryCode || '').trim().toUpperCase();
  return code === 'GB' || code === 'UK';
}

function summarizeShippingRate(rate, quote = null) {
  if (!rate) return null;
  const hidePrice = isRoyalMailShippingEntity(rate);
  return {
    quoteId: quote?.quoteId || '',
    rateId: String(rate.rateId || '').trim(),
    shipmentId: String(rate.shipmentId || '').trim(),
    carrierCode: String(rate.carrierCode || '').trim(),
    carrierName: String(rate.carrierName || '').trim(),
    serviceCode: String(rate.serviceCode || '').trim(),
    serviceName: String(rate.serviceName || '').trim(),
    deliveryDays: rate.deliveryDays ?? null,
    deliveryDate: rate.deliveryDate || '',
    validationStatus: String(rate.validationStatus || '').trim(),
    warningMessages: Array.isArray(rate.warningMessages) ? rate.warningMessages : [],
    priceAmount: hidePrice ? null : Number(rate.totalAmount?.amount || 0),
    priceCurrency: hidePrice ? '' : String(rate.totalAmount?.currency || '').trim().toUpperCase(),
    priceUnavailable: hidePrice,
    priceUnavailableReason: hidePrice ? 'Royal Mail does not return a quote through ShipStation.' : '',
  };
}

function getEmptyStateCityFallback(shipment) {
  const shipTo = shipment?.shipTo || {};
  const stateProvince = String(shipTo.stateProvince || '').trim();
  const city = String(shipTo.city || '').trim();
  if (stateProvince || !city) return '';
  return city;
}

function buildShippingRateRouteDiagnostics({ rateResult, shipment, ratePackageCode, packages, retryInfo = null }) {
  const diagnostics = {
    ...(rateResult?.diagnostics || {}),
    shipment: {
      shipmentId: shipment?.shipmentId || '',
      shipmentNumber: shipment?.shipmentNumber || '',
      status: shipment?.status || '',
      carrierCode: shipment?.carrierCode || '',
      carrierFriendlyName: shipment?.carrierFriendlyName || '',
      serviceCode: shipment?.serviceCode || '',
      serviceType: shipment?.serviceType || '',
      requestedShipmentService: shipment?.requestedShipmentService || '',
      packageCode: shipment?.packageCode || '',
      ratePackageCode,
      confirmation: shipment?.confirmation || '',
      insuranceProvider: shipment?.insuranceProvider || '',
      shipDate: shipment?.shipDate || '',
      shipTo: shipment?.shipTo || null,
      shipFrom: shipment?.shipFrom || null,
      packageCount: shipment?.packages?.length || 0,
    },
    packages,
  };

  if (retryInfo) {
    diagnostics.retry = {
      ...(diagnostics.retry || {}),
      emptyStateCityFallback: retryInfo,
    };
  }

  return diagnostics;
}

function normalizeShippingPackageDimensionsInput(dimensions) {
  if (!dimensions || typeof dimensions !== 'object') return null;
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
    unit: String(dimensions.unit || 'centimeter').trim() || 'centimeter',
  };
}

function normalizeShippingPackagesInput(packages, fallbackPackage = {}) {
  const rawPackages = Array.isArray(packages) && packages.length > 0
    ? packages
    : [{
        weightGrams: fallbackPackage.weightGrams,
        packageDimensions: fallbackPackage.packageDimensions,
      }];

  return rawPackages
    .map((pkg) => {
      const weightGrams = Math.floor(Number(pkg?.weightGrams) || 0);
      const dimensions = normalizeShippingPackageDimensionsInput(pkg?.packageDimensions || pkg?.dimensions);
      const hasInsuredValue = Object.prototype.hasOwnProperty.call(pkg || {}, 'insuredValueAmount')
        || Object.prototype.hasOwnProperty.call(pkg || {}, 'insuranceValueAmount');
      const insuredValueAmount = Number(pkg?.insuredValueAmount ?? pkg?.insuranceValueAmount ?? 0);
      const insuredValueCurrency = String(pkg?.insuredValueCurrency || pkg?.insuranceValueCurrency || 'GBP').trim().toUpperCase();
      if (!Number.isInteger(weightGrams) || weightGrams <= 0 || !dimensions) return null;
      const normalizedPackage = {
        weightGrams,
        dimensions,
      };
      if (hasInsuredValue && Number.isFinite(insuredValueAmount) && insuredValueAmount > 0) {
        normalizedPackage.insuredValueAmount = Number.isFinite(insuredValueAmount) && insuredValueAmount > 0
          ? Number(insuredValueAmount.toFixed(2))
          : 0;
        normalizedPackage.insuredValueCurrency = insuredValueCurrency || 'GBP';
      }
      return normalizedPackage;
    })
    .filter(Boolean);
}

async function upsertRemoteShippingLabels({ shop, barcode, orderNumber, labels = [], rate = null }) {
  const records = [];
  for (const label of labels) {
    if (!label?.labelId || !label?.shipmentId) continue;
    const record = sessionsStore.upsertShippingLabel({
      shop,
      barcode,
      orderNumber,
      label,
      rate,
    });
    if (record) records.push(record);
  }
  return records;
}

async function getKnownShippingLabelsForShipment({
  shop,
  barcode,
  orderNumber,
  shipmentId,
  requireRemote = false,
  reusableOnly = true,
} = {}) {
  const localLabels = sessionsStore.getShippingLabelsForShipment({ shop, shipmentId });
  let remoteRecords = [];
  try {
    const remoteLabels = await listLabelsForShipment(shipmentId);
    remoteRecords = await upsertRemoteShippingLabels({
      shop,
      barcode,
      orderNumber,
      labels: remoteLabels,
    });
  } catch (err) {
    console.error('Failed to list ShipStation labels for duplicate check:', err);
    if (requireRemote) throw err;
  }

  const byLabelId = new Map();
  [...localLabels, ...remoteRecords].forEach((label) => {
    if (!label?.labelId) return;
    byLabelId.set(label.labelId, label);
  });

  const labels = Array.from(byLabelId.values());
  return (reusableOnly ? labels.filter(isReusableShippingLabel) : labels)
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

async function refreshStoredShippingLabel({ shop, label }) {
  const refreshedLabel = await getLabelById(label.labelId);
  return sessionsStore.upsertShippingLabel({
    shop,
    barcode: label.barcode,
    orderNumber: label.orderNumber,
    quoteId: label.quoteId,
    label: refreshedLabel,
  }) || label;
}

async function downloadStoredShippingLabelPdf({ shop, label }) {
  let currentLabel = label;
  let labelUrl = String(currentLabel?.labelUrl || '').trim();
  if (!labelUrl) {
    currentLabel = await refreshStoredShippingLabel({ shop, label: currentLabel });
    labelUrl = String(currentLabel?.labelUrl || '').trim();
  }

  try {
    return {
      label: currentLabel,
      download: await downloadLabelBuffer(labelUrl),
    };
  } catch (err) {
    const originalError = err;
    currentLabel = await refreshStoredShippingLabel({ shop, label: currentLabel });
    const refreshedUrl = String(currentLabel?.labelUrl || '').trim();
    if (!refreshedUrl || refreshedUrl === labelUrl) {
      throw originalError;
    }

    try {
      return {
        label: currentLabel,
        download: await downloadLabelBuffer(refreshedUrl),
      };
    } catch (retryErr) {
      retryErr.message = `${retryErr.message} Original label download error: ${originalError.message || originalError}`;
      throw retryErr;
    }
  }
}

async function printStoredShippingLabel({ shop, label, useIdempotency = true }) {
  if (!label?.labelId) throw new Error('Missing purchased label.');
  const { label: currentLabel, download } = await downloadStoredShippingLabelPdf({ shop, label });
  const printResult = await printPdfLabel({
    shop,
    labelId: currentLabel.labelId,
    orderNumber: currentLabel.orderNumber || currentLabel.barcode,
    pdfBuffer: download.buffer,
    useIdempotency,
  });

  return sessionsStore.updateShippingLabelPrintResult({
    shop,
    labelId: currentLabel.labelId,
    printNodeJobId: printResult.printNodeJobId,
    printStatus: printResult.printStatus,
    printError: null,
  });
}

async function tryPrintStoredShippingLabel({ shop, label }) {
  try {
    return await printStoredShippingLabel({ shop, label });
  } catch (err) {
    console.error('Failed to print shipping label:', err);
    return sessionsStore.updateShippingLabelPrintResult({
      shop,
      labelId: label.labelId,
      printStatus: 'error',
      printError: err.message || 'PrintNode print failed',
    }) || label;
  }
}

function normalizeShopifyLineItemMoney(node = {}) {
  const money = node.discountedTotalSet?.shopMoney
    || node.discountedTotalSet?.presentmentMoney
    || node.originalTotalSet?.shopMoney
    || node.originalTotalSet?.presentmentMoney
    || null;
  const amount = Number(money?.amount || 0);
  return {
    amount: Number.isFinite(amount) && amount > 0 ? amount : 0,
    currency: String(money?.currencyCode || money?.currency || '').trim().toUpperCase(),
  };
}

function normalizeShopifyImage(...images) {
  for (const image of images) {
    if (!image || typeof image !== 'object') continue;
    const url = String(image.url || image.src || image.transformedSrc || '').trim();
    if (!url) continue;
    return {
      url,
      altText: String(image.altText || '').trim(),
    };
  }

  return {
    url: '',
    altText: '',
  };
}

function buildCurrentOrderLineItems(edges = []) {
  return (edges || [])
    .map((edge, index) => {
      const node = edge?.node || {};
      const rawCurrentQty = Number(node.currentQuantity);
      const rawLegacyQty = Number(node.quantity);
      const quantity = Number.isFinite(rawCurrentQty)
        ? rawCurrentQty
        : (Number.isFinite(rawLegacyQty) ? rawLegacyQty : 0);

      if (quantity <= 0) {
        return null;
      }

      const lineMoney = normalizeShopifyLineItemMoney(node);
      const bundleGroup = node.lineItemGroup
        ? {
            id: String(node.lineItemGroup.id || '').trim(),
            title: String(node.lineItemGroup.title || '').trim(),
            quantity: Number(node.lineItemGroup.quantity) || null,
          }
        : null;
      const image = normalizeShopifyImage(
        node.variant?.image,
        node.variant?.product?.featuredImage
      );

      return {
        id: node.id || `ORDER_LINE_${index + 1}`,
        title: node.title || '',
        sku: node.sku || '',
        quantity,
        variantTitle: node.variantTitle || '',
        productId: node.product?.id || node.variant?.product?.id || '',
        upc: node.variant?.barcode || '',
        imageUrl: image.url,
        imageAltText: image.altText,
        bundleGroup,
        priceAmount: lineMoney.amount,
        priceCurrency: lineMoney.currency,
        unitPriceAmount: quantity > 0 && lineMoney.amount > 0
          ? Number((lineMoney.amount / quantity).toFixed(4))
          : 0,
      };
    })
    .filter(Boolean);
}

function normalizeOrderShippingDestination(order = {}) {
  const address = order?.shippingAddress || order?.shipping_address || {};
  return {
    countryCode: String(address?.countryCodeV2 || address?.country_code || address?.countryCode || '').trim().toUpperCase(),
    countryName: String(address?.country || address?.country_name || address?.countryName || '').trim(),
  };
}

function isHpaTankLineItem(item = {}) {
  return HPA_TANK_REG_REMOVAL_SKUS.has(normalizeSku(item.sku));
}

function buildHpaTankShippingWarning({ order, lineItems = [] } = {}) {
  const destination = normalizeOrderShippingDestination(order);
  const countryCode = destination.countryCode;
  if (countryCode !== 'US' && countryCode !== 'CA') return null;

  const tankItems = (Array.isArray(lineItems) ? lineItems : [])
    .filter(isHpaTankLineItem)
    .map((item) => ({
      sku: String(item.sku || '').trim(),
      title: String(item.title || '').trim(),
      variantTitle: String(item.variantTitle || '').trim(),
      quantity: Math.max(1, Number(item.quantity) || 1),
    }));

  if (!tankItems.length) return null;

  const skus = Array.from(new Set(tankItems.map((item) => item.sku).filter(Boolean)));
  const countryLabel = destination.countryName || (countryCode === 'US' ? 'United States' : 'Canada');

  return {
    active: true,
    countryCode,
    countryName: countryLabel,
    message: 'Take to a team member to get reg removed',
    skus,
    items: tankItems,
  };
}

function buildWholesaleOrderWarning(order = {}) {
  const purchasingEntity = order?.purchasingEntity || null;
  const purchasingEntityType = String(purchasingEntity?.__typename || '').trim();
  const isNativeB2bOrder = purchasingEntityType === 'PurchasingCompany';
  const companyName = String(purchasingEntity?.company?.name || '').trim();
  const locationName = String(purchasingEntity?.location?.name || '').trim();

  if (!isNativeB2bOrder) return null;

  return {
    active: true,
    source: 'shopify_b2b',
    companyName,
    locationName,
    title: 'Wholesale order',
    message: 'Print bag topper labels before dispatch. A team member can help you apply them.',
  };
}

function buildTypedAwaitingPartsItems({ skus, items, skuMap }) {
  const normalizedItems = Array.isArray(items) && items.length > 0
    ? items.map((item) => ({
        sku: normalizeSku(item?.sku || item?.partSku),
        quantity: Math.max(1, Number(item?.quantity) || 1),
      }))
    : (skus || []).map((sku) => ({
        sku: normalizeSku(sku),
        quantity: 1,
      }));

  return normalizedItems.map((item) => {
    const normalizedSku = normalizeSku(item.sku);
    const sheetRow = skuMap?.get(normalizedSku);
    const partTypeRaw = normalizePickType(sheetRow?.type);

    return {
      partSku: normalizedSku,
      partTypeRaw,
      partTypeGroup: getWaitingPartsTypeGroup(partTypeRaw),
      quantity: Math.max(1, Number(item.quantity) || 1),
    };
  }).filter((item) => item.partSku);
}

function collectPrintQueueSkus(item) {
  const skus = [];
  const ownSku = normalizeSku(item?.sku);
  if (ownSku) skus.push(ownSku);

  (Array.isArray(item?.childItems) ? item.childItems : []).forEach((childItem) => {
    const childSku = normalizeSku(childItem?.sku);
    if (childSku) skus.push(childSku);
  });

  return skus;
}

function collectPrintQueueCardSkus(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => normalizeSku(item?.sku))
    .filter(Boolean);
}

function getPrintQueueKeyFromRequest(req) {
  return normalizePrintQueueKey(req?.body?.queueKey || req?.body?.queue || req?.query?.queueKey || req?.query?.queue);
}

function getPrintQueueLabel(queueKey) {
  return getPrintQueueConfig(queueKey).label;
}

function getPrintQueueTypeLabel(queueKey) {
  return getPrintQueueConfig(queueKey).shortLabel;
}

function extractGoogleDriveFolderId(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  const patterns = [
    /\/folders\/([^/?#]+)/i,
    /[?&]id=([^&#]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }

  return text;
}

function normalizeGoogleDriveFolderIds(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(',');

  return Array.from(new Set(values
    .map(extractGoogleDriveFolderId)
    .map((folderId) => folderId.trim())
    .filter(Boolean)));
}

function getPreformBuildDownloadUrl(buildId, artifact) {
  const normalizedBuildId = String(buildId || '').trim();
  const normalizedArtifact = String(artifact || '').trim();
  if (!normalizedBuildId || !normalizedArtifact) return '';

  return `/api/print-queue/preform-builds/${encodeURIComponent(normalizedBuildId)}/${encodeURIComponent(normalizedArtifact)}/download`;
}

function getPreformBuildDownloads(buildResult) {
  const buildId = String(buildResult?.manifest?.buildId || '').trim();
  if (!buildId) return {};

  const downloads = {
    manifest: getPreformBuildDownloadUrl(buildId, 'manifest'),
  };

  const buildCount = Array.isArray(buildResult?.preform?.builds)
    ? buildResult.preform.builds.length
    : 0;
  if (buildCount > 0 || buildResult?.preform?.formFilePath) {
    downloads.zip = getPreformBuildDownloadUrl(buildId, 'zip');
  }

  return downloads;
}

function getOrientationFileStatus(orientation, driveFile) {
  if (!orientation) return 'missing';
  if (!driveFile?.id) return 'file_missing';
  if (orientation.driveFileId && orientation.driveFileId !== String(driveFile.id || '').trim()) return 'stale';
  if (
    orientation.driveModifiedTime
    && orientation.driveModifiedTime !== String(driveFile.modifiedTime || '').trim()
  ) {
    return 'stale';
  }
  return 'current';
}

async function findPrintQueueOrientationRequirements({ shop, items, settings }) {
  const skus = Array.from(new Set((Array.isArray(items) ? items : [])
    .flatMap(collectPrintQueueSkus)
    .filter(Boolean)));
  const requirements = [];

  for (const sku of skus) {
    const driveFile = await getDriveModelFileForSku(sku, settings);
    if (!driveFile) continue;

    const orientation = sessionsStore.getPrintPartOrientation({ shop, sku });
    const status = getOrientationFileStatus(orientation, driveFile);
    if (status === 'current') continue;

    requirements.push({
      sku,
      status,
      driveFile: {
        id: driveFile.id,
        name: driveFile.name,
        modifiedTime: driveFile.modifiedTime || '',
        size: driveFile.size || '',
        webViewLink: driveFile.webViewLink || '',
      },
      orientation,
    });
  }

  return requirements;
}

function getExistingPreformBuildArtifacts(buildId) {
  const artifacts = [];
  const manifestInfo = resolvePreformBuildArtifact(buildId, 'manifest');
  if (manifestInfo?.filePath && fs.existsSync(manifestInfo.filePath)) {
    artifacts.push(manifestInfo);
  }

  const manifest = readPreformBuildManifest(buildId);
  const preformBuilds = Array.isArray(manifest?.preformBuilds)
    ? manifest.preformBuilds
    : [];
  preformBuilds.forEach((build, index) => {
    const filePath = String(build?.formFilePath || '').trim();
    if (!filePath || !fs.existsSync(filePath)) return;
    artifacts.push({
      buildId: String(build?.buildId || `${buildId}-${String(index + 1).padStart(2, '0')}`),
      artifact: 'form',
      filePath,
      filename: `${String(build?.buildId || `${buildId}-${String(index + 1).padStart(2, '0')}`)}.form`,
      contentType: 'application/octet-stream',
    });
  });

  if (preformBuilds.length === 0) {
    const formInfo = resolvePreformBuildArtifact(buildId, 'form');
    if (formInfo?.filePath && fs.existsSync(formInfo.filePath)) {
      artifacts.push(formInfo);
    }
  }

  return artifacts;
}

function summarizeAwaitingPartsMatches(rows) {
  const bySku = new Map();

  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const sku = normalizeSku(row?.partSku);
    if (!sku) return;

    if (!bySku.has(sku)) {
      bySku.set(sku, {
        partSku: sku,
        totalQuantity: 0,
        openOrderCount: 0,
        orders: [],
      });
    }

    const entry = bySku.get(sku);
    const quantity = Math.max(1, Number(row?.quantity) || 1);
    entry.totalQuantity += quantity;
    entry.orders.push({
      orderId: String(row?.orderId || '').trim(),
      orderNumber: String(row?.orderNumber || '').trim(),
      quantity,
      reportedBy: String(row?.reportedBy || '').trim(),
      createdAt: row?.createdAt || null,
    });
  });

  return Array.from(bySku.values())
    .map((entry) => ({
      ...entry,
      openOrderCount: entry.orders.length,
    }))
    .sort((left, right) => left.partSku.localeCompare(right.partSku));
}

function attachAwaitingPartsMatchesToPrintQueueItems({ shop, items }) {
  const queueItems = Array.isArray(items) ? items : [];
  const skus = Array.from(new Set(queueItems.flatMap(collectPrintQueueSkus).filter(Boolean)));
  if (!shop || skus.length === 0) {
    return queueItems.map((item) => ({
      ...item,
      awaitingPartsMatches: [],
      awaitingPartsOrderCount: 0,
      awaitingPartsQuantity: 0,
    }));
  }

  const awaitingRows = sessionsStore.getOpenAwaitingPartsItemsForSkus({ shop, skus });
  const matchesBySku = new Map(
    summarizeAwaitingPartsMatches(awaitingRows).map((match) => [match.partSku, match])
  );

  return queueItems.map((item) => {
    const itemMatches = collectPrintQueueSkus(item)
      .map((sku) => matchesBySku.get(sku))
      .filter(Boolean);
    const orderKeys = new Set();
    itemMatches.forEach((match) => {
      (Array.isArray(match.orders) ? match.orders : []).forEach((order) => {
        const orderKey = String(order.orderNumber || order.orderId || '').trim();
        if (orderKey) orderKeys.add(orderKey);
      });
    });

    return {
      ...item,
      awaitingPartsMatches: itemMatches,
      awaitingPartsOrderCount: orderKeys.size,
      awaitingPartsQuantity: itemMatches.reduce((sum, match) => (
        sum + Math.max(0, Number(match.totalQuantity) || 0)
      ), 0),
    };
  });
}

function formatPrintPutAwayAwaitingPartsChat({ item, matches, staff }) {
  const label = normalizeSku(item?.sku) || String(item?.title || item?.customFileName || item?.id || '').trim();
  const lines = [
    `✅ Printed parts put away${label ? `: ${label}` : ''}`,
    staff ? `Put away by: ${staff}` : '',
  ].filter(Boolean);

  if (!Array.isArray(matches) || matches.length === 0) {
    lines.push('', 'No open awaiting-parts orders are currently waiting on these SKUs.');
    return lines.join('\n');
  }

  lines.push('', '🚨 Orders waiting on these parts:');

  matches.forEach((match) => {
    const orderText = match.orders
      .map((order) => {
        const orderLabel = order.orderNumber || order.orderId;
        return `${orderLabel} x${order.quantity}`;
      })
      .join(', ');
    lines.push(`- ${match.partSku}: ${orderText}`);
  });

  return lines.join('\n');
}

function syncAwaitingPartsToPrintQueue({ shop, staff, items, skuMap }) {
  const makeQueueResult = (queueKey) => ({
    queueKey,
    label: getPrintQueueLabel(queueKey),
    addedSkus: [],
    alreadyQueuedSkus: [],
    blockedByQueued: [],
    createdCount: 0,
    createdPartCount: 0,
  });
  const result = {
    addedSkus: [],
    alreadyQueuedSkus: [],
    blockedByQueued: [],
    notPrintableSkus: [],
    missingSkus: [],
    createdCount: 0,
    createdPartCount: 0,
    queues: {
      sls: makeQueueResult('sls'),
      fdm: makeQueueResult('fdm'),
    },
    error: null,
  };

  const normalizedShop = String(shop || '').trim();
  if (!normalizedShop || !(skuMap instanceof Map)) {
    return result;
  }

  const activePrintQueueCardSkusByQueue = new Map(
    Object.keys(PRINT_QUEUE_CONFIGS).map((queueKey) => [
      queueKey,
      new Set(collectPrintQueueCardSkus(sessionsStore.getActivePrintQueueItems({
        shop: normalizedShop,
        queueKey,
      }))),
    ])
  );
  const queueItemsToCreate = [];

  (Array.isArray(items) ? items : []).forEach((item) => {
    const sku = normalizeSku(item?.sku || item?.partSku);
    if (!sku) return;

    const sheetRow = skuMap.get(sku);
    if (!sheetRow) {
      result.missingSkus.push(sku);
      return;
    }

    const queueKey = getPrintQueueKeyForSheetRow(sheetRow);
    if (!queueKey || !isPrintableSheetRow(sheetRow, queueKey)) {
      result.notPrintableSkus.push(sku);
      return;
    }

    const activePrintQueueCardSkus = activePrintQueueCardSkusByQueue.get(queueKey) || new Set();
    const queueResult = result.queues[queueKey] || makeQueueResult(queueKey);
    result.queues[queueKey] = queueResult;

    if (activePrintQueueCardSkus.has(sku)) {
      result.alreadyQueuedSkus.push(sku);
      queueResult.alreadyQueuedSkus.push(sku);
      return;
    }

    const queueItems = buildPrintQueueItemsForCatalogSku({ skuMap, sku, queueKey });
    if (!queueItems.length) {
      result.notPrintableSkus.push(sku);
      return;
    }

    queueItemsToCreate.push(...queueItems);
    result.addedSkus.push(sku);
    queueResult.addedSkus.push(sku);
    collectPrintQueueCardSkus(queueItems).forEach((queueSku) => activePrintQueueCardSkus.add(queueSku));
    activePrintQueueCardSkusByQueue.set(queueKey, activePrintQueueCardSkus);
  });

  if (queueItemsToCreate.length === 0) {
    return result;
  }

  const createdItems = sessionsStore.addPrintQueueItems({
    shop: normalizedShop,
    createdBy: staff,
    items: queueItemsToCreate,
  });

  result.createdCount = createdItems.length;
  result.createdPartCount = createdItems.reduce((count, item) => (
    count + 1 + (Array.isArray(item.childItems) ? item.childItems.length : 0)
  ), 0);
  createdItems.forEach((item) => {
    const queueKey = normalizePrintQueueKey(item?.queueKey);
    const queueResult = result.queues[queueKey] || makeQueueResult(queueKey);
    queueResult.createdCount += 1;
    queueResult.createdPartCount += 1 + (Array.isArray(item.childItems) ? item.childItems.length : 0);
    result.queues[queueKey] = queueResult;
  });

  return result;
}

function normalizeTrackerOrderId(ref) {
  const value = String(ref || '').trim();
  if (!value) return '';

  if (/^gid:\/\/shopify\/Order\/\d+$/i.test(value)) {
    return value;
  }

  if (/^\d+$/.test(value)) {
    return `gid://shopify/Order/${value}`;
  }

  return '';
}

function getHypArOrderLineItemFields() {
  return `
    lineItems(first: 200) {
      edges {
        node {
          id
          title
          sku
          quantity
          currentQuantity
          discountedTotalSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          originalTotalSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          variantTitle
          product {
            id
          }
          variant {
            barcode
            product {
              id
            }
          }
        }
      }
    }
  `;
}

async function fetchOrderForTrackerById({ client, orderId }) {
  if (!client || !orderId) {
    return null;
  }

  const query = `
    query getOrderForTrackerById($id: ID!) {
      order(id: $id) {
        id
        name
        createdAt
        note
        tags
        ${ORDER_WORKFLOW_STATUS_FIELDS}
        ${ORDER_TRACKER_METAFIELD_FIELD}
        ${getHypArOrderLineItemFields()}
      }
    }
  `;

  const response = await client.graphql(query, {
    variables: { id: orderId },
  });

  const order = response.data?.order || null;
  if (order) {
    await replaceAwaitingPartsTagWithPackaged({
      client,
      order,
    });
  }

  return order;
}

async function fetchHypArOrderById({ client, orderId }) {
  if (!client || !orderId) {
    return null;
  }

  const query = `
    query getHypArOrderById($id: ID!) {
      order(id: $id) {
        id
        name
        createdAt
        tags
        ${ORDER_WORKFLOW_STATUS_FIELDS}
        ${getHypArOrderLineItemFields()}
      }
    }
  `;

  const response = await client.graphql(query, {
    variables: { id: orderId },
  });

  return response.data?.order || null;
}

async function findOrCreateTrackerRecordByOrderId({ req, orderId }) {
  const normalizedOrderId = normalizeTrackerOrderId(orderId);
  if (!normalizedOrderId) {
    return null;
  }

  const existingRecord = sessionsStore.getOrderTrackerByOrderId(normalizedOrderId);
  if (existingRecord) {
    return existingRecord;
  }

  const sessions = sessionsStore.list()
    .filter((session) => session?.shop && session?.accessToken);

  for (const session of sessions) {
    try {
      const client = shopifyClient(session);
      const order = await fetchOrderForTrackerById({
        client,
        orderId: normalizedOrderId,
      });

      if (!order) {
        continue;
      }

      const lineItems = buildCurrentOrderLineItems(order?.lineItems?.edges || []);
      const barcode = normalizeScanBarcode(order?.name || normalizedOrderId);

      await persistOrderTrackerSnapshot({
        req,
        client,
        shop: session.shop,
        order,
        barcode,
        lineItems,
        explicitTag: '',
        appendEventIfStageChanged: false,
      });

      return sessionsStore.getOrderTrackerByOrderId(normalizedOrderId);
    } catch (err) {
      console.error(`Failed to backfill tracker for order ${normalizedOrderId} via ${session.shop}:`, err);
    }
  }

  return null;
}

async function refreshTrackerRecordFromShopify({ req, trackerRecord }) {
  if (!trackerRecord?.shop || !trackerRecord?.orderId) {
    return trackerRecord || null;
  }

  const session = sessionsStore.get(trackerRecord.shop);
  if (!session?.accessToken) {
    return trackerRecord;
  }

  try {
    const client = shopifyClient(session);
    const order = await fetchOrderForTrackerById({
      client,
      orderId: trackerRecord.orderId,
    });

    if (!order) {
      return trackerRecord;
    }

    const lineItems = buildCurrentOrderLineItems(order?.lineItems?.edges || []);
    const barcode = normalizeScanBarcode(trackerRecord.barcode || order?.name || trackerRecord.orderId);

    await persistOrderTrackerSnapshot({
      req,
      client,
      shop: trackerRecord.shop,
      order,
      barcode,
      lineItems,
      explicitTag: '',
      appendEventIfStageChanged: true,
    });

    return sessionsStore.getOrderTrackerByOrderId(trackerRecord.orderId) || trackerRecord;
  } catch (err) {
    console.error(`Failed to refresh tracker ${trackerRecord.orderId} from Shopify:`, err);
    return trackerRecord;
  }
}

router.post('/webhooks/orders-create', async (req, res) => {
  const topic = String(req.get('X-Shopify-Topic') || '').trim();
  const shop = String(req.get('X-Shopify-Shop-Domain') || '').trim();
  const hmacHeader = String(req.get('X-Shopify-Hmac-Sha256') || '').trim();

  if (!verifyShopifyWebhook(req.rawBody, hmacHeader)) {
    return res.sendStatus(401);
  }

  if (topic !== 'orders/create') {
    return res.sendStatus(200);
  }

  if (!shop) {
    return res.sendStatus(200);
  }

  let orderPayload;
  try {
    orderPayload = req.rawBody?.length
      ? JSON.parse(req.rawBody.toString('utf8'))
      : (req.body || {});
  } catch (err) {
    console.error('Failed to parse orders/create webhook payload:', err);
    return res.sendStatus(400);
  }

  const session = sessionsStore.get(shop);
  if (!session) {
    console.error(`No session found for orders/create webhook from ${shop}`);
    return res.sendStatus(200);
  }

  const orderId = String(orderPayload?.admin_graphql_api_id || '').trim() || (
    orderPayload?.id ? `gid://shopify/Order/${orderPayload.id}` : ''
  );
  const trackerBarcode = buildWebhookTrackerBarcode(orderPayload);

  if (!orderId || !trackerBarcode) {
    return res.sendStatus(200);
  }

  try {
    const client = shopifyClient(session);
    await persistOrderTrackerSnapshot({
      req,
      client,
      shop,
      order: {
        id: orderId,
        name: String(orderPayload?.name || orderPayload?.order_number || '').trim() || `Order ${orderPayload?.id || ''}`.trim(),
        createdAt: orderPayload?.created_at || null,
        note: orderPayload?.note || '',
        tags: orderPayload?.tags || '',
        cancelledAt: orderPayload?.cancelled_at || null,
        displayFulfillmentStatus: orderPayload?.fulfillment_status || '',
        trackerTokenMetafield: null,
      },
      barcode: trackerBarcode,
      lineItems: buildWebhookLineItems(orderPayload?.line_items || []),
      explicitTag: '',
      appendEventIfStageChanged: false,
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error(`Failed to process orders/create webhook for ${shop}:`, err);
    return res.sendStatus(500);
  }
});

function getTrackerBaseUrl(req) {
  const configuredHost = String(process.env.HOST || '').trim();
  if (configuredHost) {
    return configuredHost.replace(/\/+$/, '');
  }

  return `${req.protocol}://${req.get('host')}`;
}

async function fetchOrderTrackingLinks({ client, orderId }) {
  if (!client || !orderId) {
    return [];
  }

  const query = `
    query getOrderTrackingLinks($id: ID!) {
      order(id: $id) {
        fulfillments(first: 20) {
          trackingInfo(first: 10) {
            company
            number
            url
          }
        }
      }
    }
  `;

  const response = await client.graphql(query, {
    variables: { id: orderId },
  });

  const fulfillments = response.data?.order?.fulfillments || [];
  const seenUrls = new Set();

  return fulfillments.flatMap((fulfillment) => (
    Array.isArray(fulfillment?.trackingInfo) ? fulfillment.trackingInfo : []
  )).map((trackingInfo) => ({
    company: String(trackingInfo?.company || '').trim(),
    number: String(trackingInfo?.number || '').trim(),
    url: String(trackingInfo?.url || '').trim(),
  })).filter((trackingInfo) => {
    if (!trackingInfo.url) return false;
    if (seenUrls.has(trackingInfo.url)) return false;
    seenUrls.add(trackingInfo.url);
    return true;
  });
}

async function syncAwaitingPartsFromOrderNotes({ client, shop }) {
  if (!client || !shop) {
    return {
      scannedOrderCount: 0,
      awaitingPartsOrderCount: 0,
      upsertedOrderCount: 0,
      resolvedOrderCount: 0,
      skippedAwaitingPartsOrderCount: 0,
      awaitingPartsSkuCount: 0,
    };
  }

  const pickListSheet = await fetchPickListSheet();
  const skuMap = pickListSheet?.skuMap || new Map();
  const nowIso = new Date().toISOString();
  const stats = {
    scannedOrderCount: 0,
    awaitingPartsOrderCount: 0,
    upsertedOrderCount: 0,
    resolvedOrderCount: 0,
    skippedAwaitingPartsOrderCount: 0,
    awaitingPartsSkuCount: 0,
  };

  let after = null;
  let hasNextPage = true;

  const query = `
    query syncAwaitingPartsOrders($after: String) {
      orders(first: 100, after: $after, query: "status:any", sortKey: UPDATED_AT, reverse: true) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            name
            note
            tags
            ${ORDER_WORKFLOW_STATUS_FIELDS}
          }
        }
      }
    }
  `;

  while (hasNextPage) {
    const response = await client.graphql(query, {
      variables: { after },
    });

    const ordersConnection = response.data?.orders;
    const edges = Array.isArray(ordersConnection?.edges) ? ordersConnection.edges : [];

    for (const edge of edges) {
      const order = edge?.node;
      if (!order?.id) continue;

      stats.scannedOrderCount += 1;

      await replaceAwaitingPartsTagWithPackaged({
        client,
        order,
      });

      const trackerStage = deriveTrackerStage({
        explicitTag: '',
        tags: order.tags,
        cancelledAt: order.cancelledAt,
        displayFulfillmentStatus: order.displayFulfillmentStatus,
        orderNote: order.note,
      });
      sessionsStore.saveOrderTrackerSnapshot({
        shop,
        orderId: order.id,
        barcode: normalizeScanBarcode(order.name || order.id),
        orderNumber: order.name || order.id,
        orderCreatedAt: null,
        currentStage: trackerStage,
        workflowStatus: order.cancelledAt ? 'CANCELLED' : (order.displayFulfillmentStatus || ''),
        lineItems: [],
        legacyEvents: extractTrackerEventsFromOrderNote(order.note || ''),
        appendEventIfStageChanged: false,
      });

      if (shouldExcludeOrderFromAwaitingPartsQueue(order)) {
        const resolvedCount = sessionsStore.resolveAwaitingPartsForOrder({
          shop,
          orderId: order.id,
          resolvedAt: nowIso,
        });
        if (resolvedCount > 0) {
          stats.resolvedOrderCount += 1;
        }
        continue;
      }

      const isAwaitingPartsTagged = hasAwaitingPartsTag(order.tags);
      if (!isAwaitingPartsTagged) {
        const resolvedCount = sessionsStore.resolveAwaitingPartsForOrder({
          shop,
          orderId: order.id,
          resolvedAt: nowIso,
        });
        if (resolvedCount > 0) {
          stats.resolvedOrderCount += 1;
        }
        continue;
      }

      const latestAwaitingPartsSnapshot = extractLatestAwaitingPartsSnapshot(order.note || '');
      if (!latestAwaitingPartsSnapshot) {
        const resolvedCount = sessionsStore.resolveAwaitingPartsForOrder({
          shop,
          orderId: order.id,
          resolvedAt: nowIso,
        });
        if (resolvedCount > 0) {
          stats.resolvedOrderCount += 1;
        }
        stats.skippedAwaitingPartsOrderCount += 1;
        continue;
      }

      const hasOpenAwaitingParts = Array.isArray(latestAwaitingPartsSnapshot.items)
        && latestAwaitingPartsSnapshot.items.length > 0;
      if (hasOpenAwaitingParts) {
        stats.awaitingPartsOrderCount += 1;
      }

      const typedItems = buildTypedAwaitingPartsItems({
        items: latestAwaitingPartsSnapshot.items,
        skus: latestAwaitingPartsSnapshot.skus,
        skuMap,
      });

      const upsertResult = sessionsStore.upsertAwaitingPartsItems({
        shop,
        orderId: order.id,
        orderNumber: order.name || order.id,
        reportedBy: latestAwaitingPartsSnapshot.reportedBy || null,
        items: typedItems,
        createdAt: latestAwaitingPartsSnapshot.createdAt || nowIso,
      });

      stats.upsertedOrderCount += 1;
      stats.awaitingPartsSkuCount += Number(upsertResult?.openItemCount || 0);
    }

    hasNextPage = Boolean(ordersConnection?.pageInfo?.hasNextPage);
    after = hasNextPage ? ordersConnection?.pageInfo?.endCursor || null : null;
  }

  return stats;
}

async function ensureAwaitingPartsNoteSync({ client, shop }) {
  if (!client || !shop) {
    return {
      scannedOrderCount: 0,
      awaitingPartsOrderCount: 0,
      upsertedOrderCount: 0,
      resolvedOrderCount: 0,
      skippedAwaitingPartsOrderCount: 0,
      awaitingPartsSkuCount: 0,
    };
  }

  const existingPromise = awaitingPartsSyncPromises.get(shop);
  if (existingPromise) {
    return existingPromise;
  }

  const syncPromise = syncAwaitingPartsFromOrderNotes({ client, shop })
    .finally(() => {
      awaitingPartsSyncPromises.delete(shop);
    });

  awaitingPartsSyncPromises.set(shop, syncPromise);
  return syncPromise;
}

async function syncOrderTrackerMetafield({
  client,
  orderId,
  trackerToken,
  existingTrackerToken,
}) {
  if (!client || !orderId || !trackerToken) {
    return false;
  }

  const normalizedTrackerToken = String(trackerToken || '').trim();
  const normalizedExistingToken = String(existingTrackerToken || '').trim();
  if (!normalizedTrackerToken || normalizedExistingToken === normalizedTrackerToken) {
    return false;
  }

  const mutation = `
    mutation setOrderTrackerMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          namespace
          key
          value
          updatedAt
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const response = await client.graphql(mutation, {
    variables: {
      metafields: [
        {
          ownerId: orderId,
          namespace: TRACKER_METAFIELD_NAMESPACE,
          key: TRACKER_METAFIELD_KEY,
          type: 'single_line_text_field',
          value: normalizedTrackerToken,
        },
      ],
    },
  });

  const userErrors = response.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    const message = userErrors.map((error) => error.message).join('; ');
    throw new Error(`Failed to sync order tracker metafield: ${message}`);
  }

  return true;
}

async function persistOrderTrackerSnapshot({
  req,
  client,
  shop,
  order,
  barcode,
  lineItems,
  explicitTag = '',
  appendEventIfStageChanged = false,
  staff = null,
}) {
  if (!shop || !order?.id || !barcode) {
    return { trackerToken: null, trackerUrl: null };
  }

  const trackerStage = deriveTrackerStage({
    explicitTag,
    tags: order.tags,
    cancelledAt: order.cancelledAt,
    displayFulfillmentStatus: order.displayFulfillmentStatus,
    orderNote: order.note,
  });
  const legacyEvents = extractTrackerEventsFromOrderNote(order.note || '');
  const isAwaitingPartsTagged = hasAwaitingPartsTag(order.tags);
  const shouldExcludeFromAwaitingPartsQueue = shouldExcludeOrderFromAwaitingPartsQueue(order);

  const trackerSnapshot = sessionsStore.saveOrderTrackerSnapshot({
    shop,
    orderId: order.id,
    barcode,
    orderNumber: order.name,
    orderCreatedAt: order.createdAt || null,
    currentStage: trackerStage,
    workflowStatus: order.cancelledAt
      ? 'CANCELLED'
      : (order.displayFulfillmentStatus || ''),
    lineItems: normalizeTrackerLineItems(lineItems),
    legacyEvents,
    appendEventIfStageChanged,
    sourceTag: explicitTag || null,
    staff,
  });

  if (shouldExcludeFromAwaitingPartsQueue || !isAwaitingPartsTagged) {
    sessionsStore.resolveAwaitingPartsForOrder({
      shop,
      orderId: order.id,
      resolvedAt: new Date().toISOString(),
    });
  }

  if (!trackerSnapshot?.publicToken) {
    return { trackerToken: null, trackerUrl: null };
  }

  try {
    await syncOrderTrackerMetafield({
      client,
      orderId: order.id,
      trackerToken: trackerSnapshot.publicToken,
      existingTrackerToken: order.trackerTokenMetafield?.value,
    });
  } catch (err) {
    console.error(`Failed to sync tracker metafield for order ${order.id}:`, err);
  }

  const trackerBaseUrl = getTrackerBaseUrl(req);
  return {
    trackerToken: trackerSnapshot.publicToken,
    trackerUrl: `${trackerBaseUrl}/track/${trackerSnapshot.publicToken}`,
  };
}

function getSafeHypArOrderQuery(value, fallback = 'status:open') {
  const rawValue = String(value || '').trim();
  return (rawValue || fallback).replace(/"/g, '\\"');
}

function getSafeHypArOrderSortKey(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized === 'UPDATED_AT' ? 'UPDATED_AT' : 'CREATED_AT';
}

function getShopifyProductLegacyId(productId) {
  const normalized = normalizeShopifyProductId(productId);
  const match = normalized.match(/\/Product\/(\d+)$/i);
  return match ? match[1] : '';
}

function sanitizeShopifySearchValue(value) {
  return String(value || '')
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeShopifyOrderQueries(queries = []) {
  const seen = new Set();
  return (Array.isArray(queries) ? queries : [])
    .map((query) => String(query || '').trim())
    .filter((query) => {
      if (!query || seen.has(query)) return false;
      seen.add(query);
      return true;
    });
}

function buildHypArProductIdOrderSearchQueries() {
  return Array.from(HYP_AR_RECEIVER_PRODUCT_IDS || [])
    .map(getShopifyProductLegacyId)
    .filter(Boolean)
    .flatMap((productId) => [
      `product_id:"${productId}" status:any`,
      `product_id:${productId} status:any`,
    ]);
}

const HYP_AR_HISTORICAL_ORDER_SEARCH_QUERIES = [
  ...buildHypArProductIdOrderSearchQueries(),
  'HYP-AR status:any',
  'HYPAR status:any',
  'HYP AR status:any',
  'sku:HYP-AR* status:any',
  'sku:HYPAR* status:any',
  'sku:HYP* status:any',
];

async function fetchHypArReceiverProductSearchQueries({ client } = {}) {
  if (!client) return [];

  const queries = [];
  const productQuery = `
    query getHypArReceiverProduct($id: ID!) {
      product(id: $id) {
        id
        title
        variants(first: 250) {
          edges {
            node {
              id
              sku
              title
            }
          }
        }
      }
    }
  `;

  for (const productId of HYP_AR_RECEIVER_PRODUCT_IDS || []) {
    try {
      const response = await client.graphql(productQuery, {
        variables: { id: normalizeShopifyProductId(productId) },
      });
      const product = response.data?.product;
      if (!product?.id) continue;

      const title = sanitizeShopifySearchValue(product.title);
      if (title) {
        queries.push(`"${title}" status:any`);
      }

      const variantEdges = Array.isArray(product.variants?.edges) ? product.variants.edges : [];
      variantEdges.forEach((edge) => {
        const sku = sanitizeShopifySearchValue(edge?.node?.sku);
        if (sku) {
          queries.push(`sku:"${sku}" status:any`);
        }
      });
    } catch (err) {
      console.error(`Failed to fetch HYP-AR receiver product ${productId}:`, err);
    }
  }

  return dedupeShopifyOrderQueries(queries);
}

async function listHypArOpenOrders({
  client,
  maxOrders = 1000,
  pageSize = 100,
  shopifyQuery = 'status:open',
  sortKey = 'CREATED_AT',
  reverse = false,
} = {}) {
  const safeMaxOrders = Math.max(1, Math.min(2000, Math.floor(Number(maxOrders) || 1000)));
  const safePageSize = Math.max(1, Math.min(250, Math.floor(Number(pageSize) || 100)));
  const safeShopifyQuery = getSafeHypArOrderQuery(shopifyQuery, 'status:open');
  const safeSortKey = getSafeHypArOrderSortKey(sortKey);
  const safeReverse = reverse ? 'true' : 'false';
  const query = `
    query getHypArOpenOrders($first: Int!, $after: String) {
      orders(first: $first, after: $after, query: "${safeShopifyQuery}", sortKey: ${safeSortKey}, reverse: ${safeReverse}) {
        edges {
          cursor
          node {
            id
            name
            createdAt
            tags
            ${ORDER_WORKFLOW_STATUS_FIELDS}
            ${getHypArOrderLineItemFields()}
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const orders = [];
  const seenOrderIds = new Set();
  let after = null;
  let hasNextPage = true;
  let pagesFetched = 0;

  while (hasNextPage && orders.length < safeMaxOrders) {
    const first = Math.min(safePageSize, safeMaxOrders - orders.length);
    const response = await client.graphql(query, {
      variables: { first, after },
    });
    pagesFetched += 1;

    const connection = response.data?.orders || {};
    const edges = Array.isArray(connection.edges) ? connection.edges : [];
    edges.forEach((edge) => {
      const order = edge?.node || null;
      if (!order?.id || seenOrderIds.has(order.id)) return;
      seenOrderIds.add(order.id);
      orders.push(order);
    });

    hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
    after = hasNextPage ? connection.pageInfo?.endCursor || null : null;
    if (hasNextPage && !after) break;
  }

  return {
    orders,
    pagesFetched,
    hasMore: hasNextPage && orders.length >= safeMaxOrders,
    maxOrders: safeMaxOrders,
  };
}

async function listHypArHistoricalSearchOrders({ client, maxOrdersPerQuery = 1000 } = {}) {
  const safeMaxOrdersPerQuery = Math.max(50, Math.min(2000, Math.floor(Number(maxOrdersPerQuery) || 1000)));
  const ordersById = new Map();
  const searches = [];
  const productSearchQueries = await fetchHypArReceiverProductSearchQueries({ client });
  const searchQueries = dedupeShopifyOrderQueries([
    ...HYP_AR_HISTORICAL_ORDER_SEARCH_QUERIES,
    ...productSearchQueries,
  ]);

  for (const shopifyQuery of searchQueries) {
    try {
      const result = await listHypArOpenOrders({
        client,
        maxOrders: safeMaxOrdersPerQuery,
        shopifyQuery,
        sortKey: 'UPDATED_AT',
        reverse: true,
      });
      let matchedHypOrderCount = 0;

      result.orders.forEach((order) => {
        const lineItems = buildCurrentOrderLineItems(order.lineItems?.edges || []);
        const receiverUnits = buildHypArReceiverUnits(lineItems);
        if (!receiverUnits.length || !order?.id) return;

        matchedHypOrderCount += 1;
        ordersById.set(order.id, order);
      });

      searches.push({
        query: shopifyQuery,
        scannedOrderCount: result.orders.length,
        matchedHypOrderCount,
        pagesFetched: result.pagesFetched,
        hasMore: result.hasMore,
        error: null,
      });
    } catch (err) {
      console.error(`HYP-AR historical search failed for query "${shopifyQuery}":`, err);
      searches.push({
        query: shopifyQuery,
        scannedOrderCount: 0,
        matchedHypOrderCount: 0,
        pagesFetched: 0,
        hasMore: false,
        error: err.message || 'Historical search failed',
      });
    }
  }

  return {
    orders: Array.from(ordersById.values()),
    searches,
  };
}

async function syncHypArOrderFromShopify({ shop, order }) {
  if (!shop || !order?.id) {
    return {
      orderId: '',
      receiverCount: 0,
      createdOrUpdated: false,
      archivedCount: 0,
    };
  }

  const workflowStatus = getShopifyWorkflowStatus(order);
  const archiveReason = getHypArArchiveReasonForOrder(order);
  const lineItems = buildCurrentOrderLineItems(order.lineItems?.edges || []);
  const receiverUnits = buildHypArReceiverUnits(lineItems);
  const activeSourceKeys = receiverUnits.map((receiver) => receiver.sourceKey);
  const excludedSourceKeys = buildHypArExcludedSourceKeys(lineItems);
  const excludedArchivedCount = sessionsStore.archiveHypReceiversBySourceKeys({
    shop,
    orderId: order.id,
    sourceKeys: excludedSourceKeys,
    reason: 'excluded_accessory',
  });
  let archivedCount = 0;
  if (!archiveReason || receiverUnits.length > 0) {
    archivedCount = sessionsStore.archiveMissingHypReceiversForOrder({
      shop,
      orderId: order.id,
      activeSourceKeys,
      reason: 'removed',
    });
  }

  if (!receiverUnits.length) {
    let terminalArchivedCount = 0;
    if (archiveReason) {
      terminalArchivedCount = sessionsStore.archiveHypReceiversForOrder({
        shop,
        orderId: order.id,
        reason: archiveReason,
        workflowStatus,
      });
    }

    return {
      orderId: order.id,
      receiverCount: 0,
      createdOrUpdated: false,
      archivedCount: excludedArchivedCount + archivedCount + terminalArchivedCount,
    };
  }

  const receivers = sessionsStore.upsertHypReceiversForOrder({
    shop,
    orderId: order.id,
    orderNumber: order.name || order.id,
    orderCreatedAt: order.createdAt || null,
    workflowStatus,
    receivers: receiverUnits,
    initialStageKey: 'op1',
    initialStageLabel: 'OP1',
    reactivateArchived: !archiveReason,
  });

  let terminalArchivedCount = 0;
  if (archiveReason) {
    terminalArchivedCount = sessionsStore.archiveHypReceiversForOrder({
      shop,
      orderId: order.id,
      reason: archiveReason,
      workflowStatus,
    });
  }

  return {
    orderId: order.id,
    receiverCount: receiverUnits.length,
    createdOrUpdated: receivers.length > 0,
    archivedCount: excludedArchivedCount + archivedCount + terminalArchivedCount,
  };
}

async function syncHypArProductionFromShopify({
  client,
  shop,
  maxOpenOrders = 1000,
  maxHistoricalOrders = 2000,
  maxHistoricalSearchOrders = 1000,
  includeHistoricalOrders = true,
  includeTargetedHistoricalOrders = true,
} = {}) {
  const stats = {
    scannedOpenOrders: 0,
    openOrderPagesFetched: 0,
    openOrderHasMore: false,
    maxOpenOrders,
    scannedHistoricalOrders: 0,
    historicalOrderPagesFetched: 0,
    historicalOrderHasMore: false,
    maxHistoricalOrders,
    targetedHistoricalSearches: [],
    targetedHistoricalOrderCount: 0,
    targetedHistoricalHypOrderCount: 0,
    targetedHistoricalReceiverCount: 0,
    maxHistoricalSearchOrders,
    hypOrderCount: 0,
    receiverCount: 0,
    historicalHypOrderCount: 0,
    historicalReceiverCount: 0,
    archivedCount: 0,
    refreshedTrackedOrderCount: 0,
    includeHistoricalOrders: Boolean(includeHistoricalOrders),
    includeTargetedHistoricalOrders: Boolean(includeTargetedHistoricalOrders),
  };

  const openResult = await listHypArOpenOrders({
    client,
    maxOrders: maxOpenOrders,
  });
  stats.scannedOpenOrders = openResult.orders.length;
  stats.openOrderPagesFetched = openResult.pagesFetched;
  stats.openOrderHasMore = openResult.hasMore;
  stats.maxOpenOrders = openResult.maxOrders;

  const seenOpenOrderIds = new Set();
  for (const order of openResult.orders) {
    if (!order?.id) continue;
    seenOpenOrderIds.add(order.id);
    const result = await syncHypArOrderFromShopify({ shop, order });
    stats.archivedCount += Number(result.archivedCount || 0);
    if (result.receiverCount > 0) {
      stats.hypOrderCount += 1;
      stats.receiverCount += result.receiverCount;
    }
  }

  if (includeHistoricalOrders) {
    const historicalResult = await listHypArOpenOrders({
      client,
      maxOrders: maxHistoricalOrders,
      shopifyQuery: 'status:any',
      sortKey: 'UPDATED_AT',
      reverse: true,
    });
    stats.scannedHistoricalOrders = historicalResult.orders.length;
    stats.historicalOrderPagesFetched = historicalResult.pagesFetched;
    stats.historicalOrderHasMore = historicalResult.hasMore;
    stats.maxHistoricalOrders = historicalResult.maxOrders;

    for (const order of historicalResult.orders) {
      if (!order?.id || seenOpenOrderIds.has(order.id)) continue;
      if (!getHypArArchiveReasonForOrder(order)) continue;

      const result = await syncHypArOrderFromShopify({ shop, order });
      seenOpenOrderIds.add(order.id);
      stats.archivedCount += Number(result.archivedCount || 0);
      if (result.receiverCount > 0) {
        stats.historicalHypOrderCount += 1;
        stats.historicalReceiverCount += result.receiverCount;
      }
    }
  }

  if (includeTargetedHistoricalOrders) {
    const targetedHistoricalResult = await listHypArHistoricalSearchOrders({
      client,
      maxOrdersPerQuery: maxHistoricalSearchOrders,
    });
    stats.targetedHistoricalSearches = targetedHistoricalResult.searches;
    stats.targetedHistoricalOrderCount = targetedHistoricalResult.orders.length;

    for (const order of targetedHistoricalResult.orders) {
      if (!order?.id || seenOpenOrderIds.has(order.id)) continue;

      const result = await syncHypArOrderFromShopify({ shop, order });
      seenOpenOrderIds.add(order.id);
      stats.archivedCount += Number(result.archivedCount || 0);
      if (result.receiverCount > 0) {
        stats.targetedHistoricalHypOrderCount += 1;
        stats.targetedHistoricalReceiverCount += result.receiverCount;
      }
    }
  }

  const activeReceivers = sessionsStore.listHypReceivers({
    shop,
    includeArchived: false,
    limit: 5000,
  });
  const activeOrderIds = Array.from(new Set(
    activeReceivers
      .map((receiver) => String(receiver.orderId || '').trim())
      .filter(Boolean)
  ));

  for (const orderId of activeOrderIds) {
    if (seenOpenOrderIds.has(orderId)) continue;

    try {
      const order = await fetchHypArOrderById({ client, orderId });
      if (!order?.id) continue;

      const result = await syncHypArOrderFromShopify({ shop, order });
      stats.refreshedTrackedOrderCount += 1;
      stats.archivedCount += Number(result.archivedCount || 0);
    } catch (err) {
      console.error(`Failed to refresh tracked HYP-AR order ${orderId}:`, err);
    }
  }

  return stats;
}

function parseBooleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return Boolean(fallback);
}

function getHypArProductionSyncOptions(source = {}, defaults = {}) {
  return {
    maxOpenOrders: Math.max(50, Math.min(2000, Math.floor(Number(source.maxOpenOrders) || Number(defaults.maxOpenOrders) || 1000))),
    maxHistoricalOrders: Math.max(50, Math.min(2000, Math.floor(Number(source.maxHistoricalOrders) || Number(defaults.maxHistoricalOrders) || 2000))),
    maxHistoricalSearchOrders: Math.max(50, Math.min(2000, Math.floor(Number(source.maxHistoricalSearchOrders) || Number(defaults.maxHistoricalSearchOrders) || 1000))),
    includeHistoricalOrders: parseBooleanOption(source.includeHistoricalOrders, defaults.includeHistoricalOrders !== undefined ? defaults.includeHistoricalOrders : true),
    includeTargetedHistoricalOrders: parseBooleanOption(source.includeTargetedHistoricalOrders, defaults.includeTargetedHistoricalOrders !== undefined ? defaults.includeTargetedHistoricalOrders : true),
  };
}

function serializeHypArSyncJob(job = null) {
  if (!job) {
    return {
      status: 'idle',
      running: false,
      startedAt: null,
      completedAt: null,
      stats: null,
      error: null,
    };
  }

  return {
    status: job.status || 'idle',
    running: job.status === 'running',
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    stats: job.stats || null,
    error: job.error || null,
  };
}

function startHypArProductionBackgroundSync({ session, shop, options = {} } = {}) {
  const normalizedShop = String(shop || '').trim();
  if (!normalizedShop || !session) return null;

  const existingJob = hypArProductionSyncJobs.get(normalizedShop);
  if (existingJob?.status === 'running') {
    return existingJob;
  }
  const force = parseBooleanOption(options.force, false);
  const existingCompletedAt = existingJob?.completedAt ? Date.parse(existingJob.completedAt) : Number.NaN;
  if (!force && Number.isFinite(existingCompletedAt) && Date.now() - existingCompletedAt < HYP_AR_BACKGROUND_SYNC_MIN_INTERVAL_MS) {
    return existingJob;
  }

  const job = {
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    stats: null,
    error: null,
  };
  hypArProductionSyncJobs.set(normalizedShop, job);

  const client = shopifyClient(session);
  job.promise = syncHypArProductionFromShopify({
    client,
    shop: normalizedShop,
    ...getHypArProductionSyncOptions(options, {
      includeHistoricalOrders: false,
      includeTargetedHistoricalOrders: false,
    }),
  })
    .then((stats) => {
      job.status = 'completed';
      job.stats = stats;
      job.completedAt = new Date().toISOString();
      return stats;
    })
    .catch((err) => {
      console.error('Background HYP-AR production sync failed:', err);
      job.status = 'failed';
      job.error = err.message || 'Failed to sync HYP-AR orders from Shopify';
      job.completedAt = new Date().toISOString();
      return null;
    });

  return job;
}

function includesMissingBundleFieldError(err) {
  const raw = String(err?.message || '').toLowerCase();
  if (!raw.includes('lineitemgroup')) return false;
  return raw.includes('cannot query field') || raw.includes("doesn't exist");
}

function includesMissingPurchasingEntityFieldError(err) {
  const raw = String(err?.message || '').toLowerCase();
  if (!raw.includes('purchasingentity') && !raw.includes('purchasingcompany')) return false;
  return raw.includes('cannot query field')
    || raw.includes("doesn't exist")
    || raw.includes('unknown type')
    || raw.includes('no such type')
    || raw.includes('access denied')
    || raw.includes('required access');
}

function includesProductImageFieldError(err) {
  const raw = JSON.stringify(err?.response?.body || err?.response || err?.body || err?.message || err || '').toLowerCase();
  return (
    (raw.includes('image') || raw.includes('featuredimage') || raw.includes('product'))
    && (
      raw.includes("doesn't exist")
      || raw.includes('field')
      || raw.includes('access denied')
      || raw.includes('required access')
    )
  );
}

function getPickListOrderQuery({ includeBundleGroup, includePurchasingEntity = false, includeProductImages = false }) {
  return `
      query getOrderForPickList($query: String!) {
        orders(first: ${ORDER_LOOKUP_CANDIDATE_LIMIT}, query: $query) {
          edges {
            node {
              id
              name
              createdAt
              note
              tags
              ${ORDER_WORKFLOW_STATUS_FIELDS}
              ${ORDER_TRACKER_METAFIELD_FIELD}
              ${includePurchasingEntity ? `
              purchasingEntity {
                __typename
                ... on PurchasingCompany {
                  company {
                    id
                    name
                  }
                  location {
                    id
                    name
                  }
                }
              }` : ''}
              shippingAddress {
                country
                countryCodeV2
              }
              lineItems(first: 200) {
                edges {
                  node {
                    id
                    title
                    sku
                    quantity
                    currentQuantity
                    discountedTotalSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    originalTotalSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    variantTitle
                    product {
                      id
                    }
                    variant {
                      barcode
                      product {
                        id
                        ${includeProductImages ? `
                        featuredImage {
                          url
                          altText
                        }` : ''}
                      }
                      ${includeProductImages ? `
                      image {
                        url
                        altText
                      }` : ''}
                    }
                    ${includeBundleGroup ? `
                    lineItemGroup {
                      id
                      title
                      quantity
                    }` : ''}
                  }
                }
              }
            }
          }
        }
      }
    `;
}

async function fetchPickListOrderResponse({
  client,
  variables,
  includePurchasingEntity = false,
  includeProductImages = false,
} = {}) {
  let includeBundleGroup = true;
  let usePurchasingEntity = Boolean(includePurchasingEntity);
  let useProductImages = Boolean(includeProductImages);
  let bundleMetadataSupported = true;
  let purchasingEntitySupported = usePurchasingEntity;
  let productImagesSupported = useProductImages;

  while (true) {
    try {
      const response = await client.graphql(getPickListOrderQuery({
        includeBundleGroup,
        includePurchasingEntity: usePurchasingEntity,
        includeProductImages: useProductImages,
      }), {
        variables,
      });

      return {
        response,
        bundleMetadataSupported,
        purchasingEntitySupported,
        productImagesSupported,
      };
    } catch (err) {
      if (useProductImages && includesProductImageFieldError(err)) {
        useProductImages = false;
        productImagesSupported = false;
        continue;
      }

      if (includeBundleGroup && includesMissingBundleFieldError(err)) {
        includeBundleGroup = false;
        bundleMetadataSupported = false;
        continue;
      }

      if (usePurchasingEntity && includesMissingPurchasingEntityFieldError(err)) {
        usePurchasingEntity = false;
        purchasingEntitySupported = false;
        continue;
      }

      throw err;
    }
  }
}

async function ensureGeckoboardDataset({ authHeader, datasetId }) {
  if (geckoboardDatasetChecked) return;

  const getRes = await fetch(`https://api.geckoboard.com/datasets/${datasetId}`, {
    method: 'GET',
    headers: { Authorization: authHeader },
  });

  if (getRes.ok) {
    geckoboardDatasetChecked = true;
    return;
  }

  if (getRes.status !== 404) {
    const body = await getRes.text();
    throw new Error(`Geckoboard dataset check failed ${getRes.status}: ${body}`);
  }

  const createRes = await fetch(`https://api.geckoboard.com/datasets/${datasetId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({
      fields: {
        timestamp: { type: 'datetime' },
        order_number: { type: 'string' },
        order_id: { type: 'string' },
        barcode: { type: 'string' },
        tag: { type: 'string' },
        staff: { type: 'string' }
      },
    }),
  });

  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Geckoboard dataset create failed ${createRes.status}: ${body}`);
  }

  geckoboardDatasetChecked = true;
}

router.post('/api/tag-order', async (req, res) => {
  try {
    const { barcode, tag, reason } = req.body;
    if (!barcode || !tag) {
      return res.status(400).json({ success: false, error: 'Missing barcode or tag' });
    }

    const normalizedReason = String(reason || '').trim();
    if (tag === 'on_hold' && !normalizedReason) {
      return res.status(400).json({ success: false, error: 'Missing On Hold reason' });
    }

    const shop = req.cookies.shop;
    if (!shop) {
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

    const userId = req.cookies.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Username needs to be set' });
    }

    const session = sessionsStore.get(shop);
    if (!session) {
      return res.status(401).json({ success: false, error: 'No session found' });
    }

    const staff = userId;
    let orderNoteWarning = null;
    let geckoboardEventSent = false;
    let geckoboardEventWarning = null;
    const normalizedBarcode = normalizeScanBarcode(barcode);
    const client = shopifyClient(session);

    console.log(`Looking up order ${barcode} for shop ${shop}`);

    // --------------------------------------------------
    // 1️⃣ Find order (GraphQL)
    // --------------------------------------------------
    const query = `
      query getOrder($query: String!) {
        orders(first: ${ORDER_LOOKUP_CANDIDATE_LIMIT}, query: $query) {
          edges {
            node {
              id
              name
              createdAt
              note
              tags
              ${ORDER_WORKFLOW_STATUS_FIELDS}
              ${ORDER_TRACKER_METAFIELD_FIELD}
              lineItems(first: 200) {
                edges {
                  node {
                    id
                    title
                    sku
                    quantity
                    currentQuantity
                    discountedTotalSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    originalTotalSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    variantTitle
                    product {
                      id
                    }
                    variant {
                      id
                      barcode
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await client.graphql(query, {
      variables: {
        query: buildOrderSearchQuery(normalizedBarcode),
      },
    });

    const orderEdge = selectExactOrderEdge(response.data?.orders?.edges, normalizedBarcode);
    if (!orderEdge) {
      return res.json({ success: false, error: `Order ${barcode} not found` });
    }

    const order = orderEdge.node;
    const latestWaitingQcStaff = tag == "qc_fail"
      ? resolveLatestWaitingQcStaff({
          shop,
          normalizedBarcode,
          orderId: order.id,
          orderNote: order.note || '',
        })
      : null;
    const attributedStaff = tag == "qc_fail"
      ? (latestWaitingQcStaff || staff)
      : staff;
    const lineItemArray = buildCurrentOrderLineItems(order.lineItems?.edges || []);
    const workflowBlock = getOrderWorkflowBlock(order);
    if (workflowBlock) {
      const trackerInfo = await persistOrderTrackerSnapshot({
        req,
        client,
        shop,
        order,
        barcode: normalizedBarcode,
        lineItems: lineItemArray,
        explicitTag: '',
        appendEventIfStageChanged: true,
      });
      return res.status(409).json({
        success: false,
        error: workflowBlock.message,
        workflowBlocked: true,
        workflowBlockCode: workflowBlock.code,
        workflowStatus: workflowBlock.status,
        orderNumber: order.name,
        trackerToken: trackerInfo.trackerToken,
        trackerUrl: trackerInfo.trackerUrl,
      });
    }

    // ---------
    // -----------------------------------------
    // 2️⃣ Merge tags safely
    // --------------------------------------------------
    let tagsArray = [];
    
    // load all current tags
    if (Array.isArray(order.tags)) {
      tagsArray = [...order.tags];
    } else if (typeof order.tags === 'string') {
      tagsArray = order.tags.split(',').map(t => t.trim());
    }

    // check if new tag is already set, if so, we don't want to add a duplicate timeline comment
    var newTag = !tagsArray.includes(tag)

    // redefine tagArray
    tagsArray = [tag]; 
    

    // --------------------------------------------------
    // 3️⃣ Update tags (GraphQL)
    // --------------------------------------------------
    const updateMutation = `
      mutation updateOrder($id: ID!, $tags: [String!]) {
        orderUpdate(input: { id: $id, tags: $tags }) {
          order { id tags }
          userErrors { field message }
        }
      }
    `;

    const updateResult = await client.graphql(updateMutation, {
      variables: {
        id: order.id,
        tags: tagsArray,
      },
    });

    if (updateResult.data?.orderUpdate?.userErrors?.length) {
      console.error(updateResult.data.orderUpdate.userErrors);
      return res.json({ success: false, error: 'Failed to update order' });
    }

    console.log(`Order ${barcode} tagged with "${tag}" by ${attributedStaff}`);

    if (tag == "awaiting_parts") {
      // await sendGoogleChatMessage(
      //   process.env.GCHAT_WEBHOOK_URL,
      //   `🏷️ Order ${order.name} tagged "${tag}" by ${staff}`
      // );
      // await sendGoogleChatMessage(
      //   process.env.GCHAT_ALL_ACTIVITY_WEBHOOK_URL,
      //   `🏷️ Order ${order.name} tagged "${tag}" by ${staff}`
      // );
    } else {
      const activityMessage = tag == "on_hold" && normalizedReason
        ? `🏷️ Order ${order.name} tagged "${tag}" by ${attributedStaff} — ${normalizedReason}`
        : `🏷️ Order ${order.name} tagged "${tag}" by ${attributedStaff}`;

       await sendGoogleChatMessage(
        process.env.GCHAT_ALL_ACTIVITY_WEBHOOK_URL,
        activityMessage
      );

      
      if (newTag || tag == "wholesale_adapter_built" || tag == "on_hold") {
        const timestamp = new Date()
          .toISOString()
          .replace('T', ' ')
          .slice(0, 16);

        var orderNoteBlock = "";

        if (tag == "racked_up") {
          orderNoteBlock = [
            '~',
            `ORDER READY TO BE BUILT — ${timestamp}`,
            `Team Member: ${staff}`,
            '',
          ].join('\n');
        } else if (tag == "waiting_qc") {
            orderNoteBlock = [
            '~',
            `ORDER BUILT - AWAITING QUALITY CHECKS — ${timestamp}`,
            `Team Member: ${staff}`,
            '',
          ].join('\n');
        } else if (tag == "qc_passed") {
            orderNoteBlock = [
            '~',
            `QUALITY CHECKS PASSED - AWAITING SHIPPING — ${timestamp}`,
            `Team Member: ${staff}`,
            '',
          ].join('\n');
        } else if (tag == "qc_fail") {
            orderNoteBlock = [
            '~',
            `QUALITY CHECKS ESCALATED - AWAITING REBUILD — ${timestamp}`,
            `Team Member: ${attributedStaff}`,
            '',
          ].join('\n');
        } else if (tag == "packaged") {
            orderNoteBlock = [
            '~',
            `ORDER PACKAGED - AWAITING COURIER COLLECTION — ${timestamp}`,
            `Team Member: ${staff}`,
            '',
          ].join('\n');
        } else if (tag == "wholesale_adapter_built") {
            orderNoteBlock = [
            '~',
            `WHOLESALE ADAPTER BUILT — ${timestamp}`,
            `Team Member: ${staff}`,
            '',
          ].join('\n');
        } else if (tag == "on_hold") {
            orderNoteBlock = [
            '~',
            `ON HOLD — ${timestamp}`,
            `Team Member: ${staff}`,
            `Reason: ${normalizedReason}`,
            '',
          ].join('\n');
        }

        if (orderNoteBlock) {
          const noteResult = await appendOrderNoteOrWarn(client, order.id, orderNoteBlock, {
            route: '/api/tag-order',
            orderNumber: order.name,
            barcode,
            tag,
          });
          if (noteResult.success) {
            order.note = `${order.note || ''}${orderNoteBlock}`;
          } else {
            orderNoteWarning = noteResult.error;
          }
        }
      } else {
      console.log("Skipped as already tagged")
      }
    }
    
    const geckoboardResult = await trySendGeckoboardEvent({
      timestamp: new Date().toISOString(),
      order_number: order.name,
      order_id: order.id,
      barcode: normalizedBarcode,
      tag,
      staff: attributedStaff,
    });
    geckoboardEventSent = geckoboardResult.sent;
    geckoboardEventWarning = geckoboardResult.warning;

    if (tag == "racked_up") {
      try {
        sessionsStore.resolveAwaitingPartsForOrder({
          shop,
          orderId: order.id,
          resolvedAt: new Date().toISOString(),
        });
      } catch (awaitingPartsResolveErr) {
        console.error('Failed to clear awaiting_parts items for racked_up order:', awaitingPartsResolveErr);
      }
    }

    if (tag == "waiting_qc") {
      try {
        sessionsStore.recordWaitingQcEvent({
          barcode: normalizedBarcode,
          staff,
        });
      } catch (waitingQcStoreErr) {
      console.error('Failed to store waiting_qc event:', waitingQcStoreErr);
      }
    }

    const trackerInfo = await persistOrderTrackerSnapshot({
      req,
      client,
      shop,
      order: {
        ...order,
        tags: [tag],
      },
      barcode: normalizedBarcode,
      lineItems: lineItemArray,
      explicitTag: tag,
      appendEventIfStageChanged: true,
      staff: attributedStaff,
    });
    const updatedTrackerStage = deriveTrackerStage({
      explicitTag: tag,
      tags: [tag],
      cancelledAt: order.cancelledAt,
      displayFulfillmentStatus: order.displayFulfillmentStatus,
      orderNote: order.note,
    });

    let wholesaleAdapterBuiltCount = null;
    if (tag == "wholesale_adapter_built") {
      const nextCount = (wholesaleAdapterBuiltScanCounts.get(normalizedBarcode) || 0) + 1;
      wholesaleAdapterBuiltScanCounts.set(normalizedBarcode, nextCount);
      wholesaleAdapterBuiltCount = nextCount;
      try {
        sessionsStore.recordWholesaleBuildEvent({
          shop,
          barcode: normalizedBarcode,
          orderId: order.id,
          orderNumber: order.name,
          staff,
        });
      } catch (wholesaleEventStoreErr) {
        console.error('Failed to store wholesale_adapter_built event marker:', wholesaleEventStoreErr);
      }
    }
    const qcBuilderStaff = tag == "waiting_qc"
      ? staff
      : resolveLatestWaitingQcStaff({
          shop,
          normalizedBarcode,
          orderId: order.id,
          orderNote: order.note || '',
        });

    return res.json({
      success: true,
      orderNumber: order.name,
      orderTags: [tag],
      orderStatus: order.cancelledAt ? 'CANCELLED' : (order.displayFulfillmentStatus || ''),
      currentStage: {
        key: updatedTrackerStage.key,
        label: updatedTrackerStage.label,
      },
      lineItems: lineItemArray,
      staff: attributedStaff,
      qcBuilderStaff,
      wholesaleAdapterBuiltCount,
      orderNoteWarning,
      geckoboardEventSent,
      geckoboardEventWarning,
      trackerToken: trackerInfo.trackerToken,
      trackerUrl: trackerInfo.trackerUrl,
    });

  } catch (err) {
    console.error('Error in /api/tag-order:', err);
    if (err.response) {
      console.error('API Response Dump:', JSON.stringify(err.response, null, 2));
    }
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

router.post('/api/awaiting-parts', async (req, res) => {
  try {
    const { orderId, skus, items } = req.body;

    var barcode = orderId;
    const requestedItems = Array.isArray(items)
      ? items
      : (Array.isArray(skus) ? skus.map((sku) => ({ sku, quantity: 1 })) : null);

    if (!barcode || !Array.isArray(requestedItems)) {
      return res.status(400).json({
        success: false,
        error: 'Missing barcode or awaiting-parts items',
      });
    }

    const shop = req.cookies.shop;
    if (!shop) {
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

    const userId = req.cookies.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Username needs to be set' });
    }

    const session = sessionsStore.get(shop);
    if (!session) {
      return res.status(401).json({ success: false, error: 'No session found' });
    }

    const staff = userId || 'Unknown';
    const client = shopifyClient(session);

    // --------------------------------------------------
    // 1️⃣ Find order by name / barcode (GraphQL search)
    // --------------------------------------------------
    const findOrderQuery = `
      query findOrder($query: String!) {
        orders(first: ${ORDER_LOOKUP_CANDIDATE_LIMIT}, query: $query) {
          edges {
            node {
              id
              name
              note
              tags
              cancelledAt
              displayFulfillmentStatus
            }
          }
        }
      }
    `;

    const findRes = await client.graphql(findOrderQuery, {
      variables: {
        query: buildOrderSearchQuery(barcode),
      },
    });

    const orderEdge = selectExactOrderEdge(findRes.data?.orders?.edges, barcode);
    if (!orderEdge) {
      return res.status(404).json({
        success: false,
        error: `Order ${barcode} not found`,
      });
    }

    const order = orderEdge.node;

    // --------------------------------------------------
    // 2️⃣ Build append-only AWAITING PARTS block
    // --------------------------------------------------
    const timestamp = new Date()
      .toISOString()
      .replace('T', ' ')
      .slice(0, 16);

    const normalizedAwaitingPartsItems = requestedItems.map((item) => ({
      sku: normalizeSku(item?.sku || item?.partSku),
      quantity: Math.max(1, Number(item?.quantity) || 1),
    })).filter((item) => item.sku);
    const nextTags = normalizedAwaitingPartsItems.length > 0
      ? ['awaiting_parts']
      : [];

    const awaitingPartsBlock = [
      '~',
      `AWAITING PARTS — ${timestamp}`,
      `Team Member: ${staff}`,
      ...normalizedAwaitingPartsItems.map((item) =>
        item.quantity > 1
          ? `- ${item.sku} | QTY ${item.quantity}`
          : `- ${item.sku}`
      ),
      '',
    ].join('\n');

    const updatedNote = (order.note || '') + awaitingPartsBlock;

    // --------------------------------------------------
    // 3️⃣ Append to order note (GraphQL)
    // --------------------------------------------------
    const updateNoteMutation = `
      mutation updateOrderAwaitingParts($id: ID!, $note: String, $tags: [String!]) {
        orderUpdate(input: { id: $id, note: $note, tags: $tags }) {
          userErrors {
            field
            message
          }
        }
      }
    `;

    let orderNoteWarning = null;
    try {
      const updateRes = await client.graphql(updateNoteMutation, {
        variables: {
          id: order.id,
          note: updatedNote,
          tags: nextTags,
        },
      });

      const userErrors = updateRes.data?.orderUpdate?.userErrors || [];
      if (userErrors.length) {
        throw new Error(userErrors.map((entry) => entry.message).join('; '));
      }
    } catch (noteErr) {
      orderNoteWarning = noteErr.message || 'Failed to update order note';
      console.error('Awaiting parts order note update failed; continuing action:', {
        orderId: order.id,
        orderNumber: order.name,
        barcode,
        error: orderNoteWarning,
      });

      const updateTagsOnlyMutation = `
        mutation updateOrderAwaitingPartsTags($id: ID!, $tags: [String!]) {
          orderUpdate(input: { id: $id, tags: $tags }) {
            userErrors {
              field
              message
            }
          }
        }
      `;
      const tagUpdateRes = await client.graphql(updateTagsOnlyMutation, {
        variables: {
          id: order.id,
          tags: nextTags,
        },
      });
      const tagUserErrors = tagUpdateRes.data?.orderUpdate?.userErrors || [];
      if (tagUserErrors.length) {
        console.error(tagUserErrors);
        return res.status(500).json({
          success: false,
          error: 'Failed to update order tags',
          orderNoteWarning,
        });
      }
    }

    let typedAwaitingPartsItems = normalizedAwaitingPartsItems.map((item) => ({
      partSku: normalizeSku(item.sku),
      partTypeRaw: 'UNKNOWN',
      partTypeGroup: 'UNKNOWN',
      quantity: Math.max(1, Number(item.quantity) || 1),
    }));
    let pickListSheet = null;
    let printQueueUpdate = {
      addedSkus: [],
      alreadyQueuedSkus: [],
      blockedByQueued: [],
      notPrintableSkus: [],
      missingSkus: [],
      createdCount: 0,
      createdPartCount: 0,
      error: null,
    };

    if (normalizedAwaitingPartsItems.length > 0) {
      try {
        pickListSheet = await fetchPickListSheet();
        typedAwaitingPartsItems = normalizedAwaitingPartsItems.map((item) => {
          const normalizedSku = normalizeSku(item.sku);
          const sheetRow = pickListSheet.skuMap.get(normalizedSku);
          const partTypeRaw = normalizePickType(sheetRow?.type);
          return {
            partSku: normalizedSku,
            partTypeRaw,
            partTypeGroup: getWaitingPartsTypeGroup(partTypeRaw),
            quantity: Math.max(1, Number(item.quantity) || 1),
          };
        });
      } catch (sheetErr) {
        console.error('Failed to enrich awaiting parts items with sheet types:', sheetErr);
        printQueueUpdate.error = 'Failed to load the sheet, so the print queue was not updated.';
      }
    }

    if (normalizedAwaitingPartsItems.length > 0 && pickListSheet?.skuMap) {
      try {
        printQueueUpdate = syncAwaitingPartsToPrintQueue({
          shop,
          staff,
          items: normalizedAwaitingPartsItems,
          skuMap: pickListSheet.skuMap,
        });
      } catch (printQueueErr) {
        console.error('Failed to sync awaiting parts to print queue:', printQueueErr);
        printQueueUpdate.error = printQueueErr.message || 'Failed to update the print queue.';
      }
    }

    sessionsStore.upsertAwaitingPartsItems({
      shop,
      orderId: order.id,
      orderNumber: order.name,
      reportedBy: staff,
      items: typedAwaitingPartsItems,
      createdAt: new Date().toISOString(),
    });

    const existingTrackerRecord = sessionsStore.getOrderTrackerByOrderId(order.id);
    const fallbackTrackerStageKey = Array.isArray(existingTrackerRecord?.events)
      ? [...existingTrackerRecord.events]
          .reverse()
          .find((event) => String(event?.stageKey || '').trim() && String(event?.stageKey || '').trim() !== 'awaiting_parts')
          ?.stageKey
      : '';
    const fallbackTrackerStage = TRACKER_STAGES[fallbackTrackerStageKey] || TRACKER_STAGES.received;
    const statusDerivedStage = deriveTrackerStage({
      explicitTag: normalizedAwaitingPartsItems.length > 0 ? 'awaiting_parts' : '',
      tags: normalizedAwaitingPartsItems.length > 0 ? nextTags : [],
      cancelledAt: order.cancelledAt,
      displayFulfillmentStatus: order.displayFulfillmentStatus,
      orderNote: normalizedAwaitingPartsItems.length > 0 ? updatedNote : '',
    });
    const nextTrackerStage = normalizedAwaitingPartsItems.length > 0
      ? statusDerivedStage
      : (statusDerivedStage.key !== 'received' ? statusDerivedStage : fallbackTrackerStage);

    sessionsStore.saveOrderTrackerSnapshot({
      shop,
      orderId: order.id,
      barcode: normalizeScanBarcode(existingTrackerRecord?.barcode || order.name || order.id),
      orderNumber: existingTrackerRecord?.orderNumber || order.name,
      orderCreatedAt: existingTrackerRecord?.orderCreatedAt || null,
      currentStage: nextTrackerStage,
      workflowStatus: order.cancelledAt
        ? 'CANCELLED'
        : (order.displayFulfillmentStatus || existingTrackerRecord?.workflowStatus || null),
      lineItems: Array.isArray(existingTrackerRecord?.lineItems) ? existingTrackerRecord.lineItems : [],
      legacyEvents: nextTrackerStage.key === 'awaiting_parts'
        ? extractTrackerEventsFromOrderNote(updatedNote)
        : [],
      appendEventIfStageChanged: false,
      sourceTag: normalizedAwaitingPartsItems.length > 0 ? 'awaiting_parts' : 'awaiting_parts_cleared',
      staff,
    });

    if (nextTrackerStage.key !== 'awaiting_parts') {
      sessionsStore.resolveAwaitingPartsForOrder({
        shop,
        orderId: order.id,
        resolvedAt: new Date().toISOString(),
      });
    }

    // --------------------------------------------------
    // 4️⃣ Notify Google Chat (non-blocking)
    // --------------------------------------------------
    if (normalizedAwaitingPartsItems.length > 0) {
      try {
        await sendGoogleChatMessage(
          process.env.GCHAT_WEBHOOK_URL,
          [
            `⏳ Awaiting parts for order ${order.name}`,
            `Reported by: ${staff}`,
            '',
            ...normalizedAwaitingPartsItems.map((item) =>
              item.quantity > 1
                ? `, ${item.sku} x${item.quantity}`
                : `, ${item.sku}`
            ),
          ].join('\n')
        );
      } catch (chatErr) {
        console.error('Google Chat notification failed:', chatErr);
        // ❗ Intentionally ignored
      }
    }

    return res.json({
      success: true,
      orderNumber: order.name,
      orderTags: nextTags,
      orderStatus: order.cancelledAt
        ? 'CANCELLED'
        : (order.displayFulfillmentStatus || existingTrackerRecord?.workflowStatus || ''),
      currentStage: {
        key: nextTrackerStage.key,
        label: nextTrackerStage.label,
      },
      skus: normalizedAwaitingPartsItems.map((item) => item.sku),
      awaitingPartsSelection: normalizedAwaitingPartsItems,
      awaitingPartsItems: typedAwaitingPartsItems,
      printQueueUpdate,
      orderNoteWarning,
    });

  } catch (err) {
    console.error('Error in /api/awaiting-parts:', err);
    if (err.response) {
      console.error('API Response Dump:', JSON.stringify(err.response, null, 2));
    }
    return res.status(500).json({
      success: false,
      error: 'Server error',
    });
  }
});

router.post('/api/awaiting-parts/mark-fulfilled', async (req, res) => {
  try {
    const { orderId, orderNumber } = req.body || {};
    const normalizedOrderId = String(orderId || '').trim();
    const normalizedOrderNumber = String(orderNumber || '').trim();

    if (!normalizedOrderId || !normalizedOrderNumber) {
      return res.status(400).json({
        success: false,
        error: 'Missing orderId or orderNumber',
      });
    }

    const shop = req.cookies.shop;
    if (!shop) {
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

    const userId = req.cookies.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Username needs to be set' });
    }

    const session = sessionsStore.get(shop);

    const trackerRecord = sessionsStore.getOrderTrackerByOrderId(normalizedOrderId);
    const trackerLineItems = Array.isArray(trackerRecord?.lineItems) ? trackerRecord.lineItems : [];
    const trackerBarcode = normalizeScanBarcode(
      trackerRecord?.barcode || normalizedOrderNumber || normalizedOrderId
    );
    let remoteTagUpdated = false;
    let remoteTagError = null;

    if (session?.accessToken) {
      try {
        const client = shopifyClient(session);
        const updateTagMutation = `
          mutation markAwaitingPartsOrderFulfilled($id: ID!, $tags: [String!]) {
            orderUpdate(input: { id: $id, tags: $tags }) {
              userErrors {
                field
                message
              }
            }
          }
        `;

        const updateTagResponse = await client.graphql(updateTagMutation, {
          variables: {
            id: normalizedOrderId,
            tags: ['packaged'],
          },
        });

        const userErrors = updateTagResponse.data?.orderUpdate?.userErrors || [];
        if (userErrors.length) {
          const message = userErrors.map((error) => error.message).join('; ');
          throw new Error(message || 'Failed to update Shopify tags');
        }

        remoteTagUpdated = true;
      } catch (err) {
        remoteTagError = err.message || 'Failed to update Shopify tags';
        console.error(`Failed to mark order ${normalizedOrderId} as packaged in Shopify:`, err);
      }
    }

    const resolvedItemCount = sessionsStore.resolveAwaitingPartsForOrder({
      shop,
      orderId: normalizedOrderId,
      resolvedAt: new Date().toISOString(),
    });

    sessionsStore.saveOrderTrackerSnapshot({
      shop,
      orderId: normalizedOrderId,
      barcode: trackerBarcode,
      orderNumber: trackerRecord?.orderNumber || normalizedOrderNumber,
      orderCreatedAt: trackerRecord?.orderCreatedAt || null,
      currentStage: TRACKER_STAGES.fulfilled,
      workflowStatus: 'FULFILLED',
      lineItems: trackerLineItems,
      legacyEvents: [],
      appendEventIfStageChanged: true,
      sourceTag: 'manual_fulfilled',
      staff: userId,
    });

    return res.json({
      success: true,
      orderId: normalizedOrderId,
      orderNumber: trackerRecord?.orderNumber || normalizedOrderNumber,
      resolvedItemCount,
      remoteTagUpdated,
      remoteTagError,
    });
  } catch (err) {
    console.error('Error in /api/awaiting-parts/mark-fulfilled:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.get('/api/awaiting-parts-summary', async (req, res) => {
  try {
    const shop = req.cookies.shop;
    if (!shop) {
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

    const session = sessionsStore.get(shop);
    if (!session) {
      return res.status(401).json({ success: false, error: 'No session found' });
    }

    const rawTypeFilter = String(req.query.type || '').trim();
    const typeGroupFilter = rawTypeFilter ? getWaitingPartsTypeGroup(rawTypeFilter) : '';
    const requestedNoteSync = String(req.query.sync || '').trim() === '1';
    const shouldSyncFromNotes = requestedNoteSync && ALLOW_AWAITING_PARTS_NOTE_SYNC;
    let syncStats = null;
    let syncError = requestedNoteSync && !ALLOW_AWAITING_PARTS_NOTE_SYNC
      ? 'Legacy awaiting-parts note rebuild is disabled. The summary is loaded from stored structured records.'
      : null;

    if (shouldSyncFromNotes) {
      try {
        const client = shopifyClient(session);
        syncStats = await ensureAwaitingPartsNoteSync({ client, shop });
      } catch (err) {
        console.error('Awaiting parts note sync failed:', err);
        syncError = err.message || 'Failed to sync awaiting-parts notes';
      }
    }

    const summary = sessionsStore.getAwaitingPartsSummary({
      shop,
      typeGroup: typeGroupFilter,
    });

    return res.json({
      success: true,
      typeGroupFilter: typeGroupFilter || null,
      filters: summary.filters,
      items: summary.items,
      syncStats,
      syncError,
    });
  } catch (err) {
    console.error('Error in /api/awaiting-parts-summary:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

function buildHypArProductionPayload({ shop, includeArchived = false, syncStats = null, syncError = null } = {}) {
  const hiddenArchiveReasons = new Set(['excluded_accessory', 'manual_deleted']);
  const isVisibleReceiverRecord = (receiver) => !hiddenArchiveReasons.has(String(receiver?.archiveReason || '').trim());
  const activeReceivers = sessionsStore.listHypReceivers({
    shop,
    includeArchived: false,
    limit: 5000,
  }).filter(isVisibleReceiverRecord);
  const visibleReceivers = includeArchived
    ? sessionsStore.listHypReceivers({
        shop,
        includeArchived: true,
        limit: 5000,
      }).filter(isVisibleReceiverRecord)
    : activeReceivers;
  const archivedCount = includeArchived
    ? visibleReceivers.filter((receiver) => receiver.archivedAt).length
    : sessionsStore.listHypReceivers({
        shop,
        includeArchived: true,
        limit: 5000,
      }).filter((receiver) => receiver.archivedAt && isVisibleReceiverRecord(receiver)).length;

  return {
    success: true,
    includeArchived,
    stages: HYP_AR_STAGES,
    receivers: visibleReceivers,
    summary: {
      activeReceiverCount: activeReceivers.length,
      archivedReceiverCount: archivedCount,
      builtReceiverCount: activeReceivers.filter((receiver) => receiver.currentStageKey === 'built').length,
      op1RequiredCount: activeReceivers.filter((receiver) => receiver.currentStageKey === 'op1').length,
      stageCounts: buildHypArStageCounts(activeReceivers),
      op1BySku: buildHypArOp1SkuSummary(activeReceivers),
    },
    syncStats,
    syncError,
  };
}

router.get('/api/hyp-ar-production', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const includeArchived = String(req.query.includeArchived || '').trim() === '1';
    const shouldSync = String(req.query.sync || '0').trim() === '1';
    const syncOptions = getHypArProductionSyncOptions(req.query || {});
    let syncStats = null;
    let syncError = null;

    if (shouldSync) {
      try {
        const client = shopifyClient(auth.session);
        syncStats = await syncHypArProductionFromShopify({
          client,
          shop: auth.shop,
          ...syncOptions,
        });
      } catch (err) {
        console.error('HYP-AR production sync failed:', err);
        syncError = err.message || 'Failed to sync HYP-AR orders from Shopify';
      }
    }

    return res.json(buildHypArProductionPayload({
      shop: auth.shop,
      includeArchived,
      syncStats,
      syncError,
    }));
  } catch (err) {
    console.error('Error in /api/hyp-ar-production:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.post('/api/hyp-ar-production/sync', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const job = startHypArProductionBackgroundSync({
      session: auth.session,
      shop: auth.shop,
      options: req.body || {},
    });

    return res.json({
      success: true,
      sync: serializeHypArSyncJob(job),
    });
  } catch (err) {
    console.error('Error in POST /api/hyp-ar-production/sync:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.get('/api/hyp-ar-production/sync', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    return res.json({
      success: true,
      sync: serializeHypArSyncJob(hypArProductionSyncJobs.get(auth.shop)),
    });
  } catch (err) {
    console.error('Error in GET /api/hyp-ar-production/sync:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.post('/api/hyp-ar-production/:id/stage', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const receiverId = Number(req.params.id);
    const stageKey = normalizeHypArStageKey(req.body?.stageKey);
    const stage = getHypArStage(stageKey);
    if (!Number.isInteger(receiverId) || receiverId <= 0 || !stage) {
      return res.status(400).json({
        success: false,
        error: 'Missing receiver or stage',
      });
    }

    const receiver = sessionsStore.updateHypReceiverStage({
      shop: auth.shop,
      id: receiverId,
      stageKey: stage.key,
      stageLabel: stage.label,
      staff: auth.userId,
    });

    if (!receiver) {
      return res.status(404).json({
        success: false,
        error: 'Receiver not found or archived',
      });
    }

    return res.json({
      success: true,
      receiver,
      stages: HYP_AR_STAGES,
    });
  } catch (err) {
    console.error('Error in /api/hyp-ar-production/:id/stage:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.delete('/api/hyp-ar-production/:id', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const receiverId = Number(req.params.id);
    if (!Number.isInteger(receiverId) || receiverId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing receiver',
      });
    }

    const receiver = sessionsStore.archiveHypReceiverById({
      shop: auth.shop,
      id: receiverId,
      reason: 'manual_deleted',
    });

    if (!receiver) {
      return res.status(404).json({
        success: false,
        error: 'Receiver not found',
      });
    }

    return res.json({
      success: true,
      receiver,
    });
  } catch (err) {
    console.error('Error in DELETE /api/hyp-ar-production/:id:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.get('/api/print-catalog', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const queueKey = getPrintQueueKeyFromRequest(req);
    const queueConfig = getPrintQueueConfig(queueKey);
    const pickListSheet = await fetchPickListSheet();
    const items = buildPrintCatalogFromSheet({
      skuMap: pickListSheet.skuMap,
      queueKey,
    });

    return res.json({
      success: true,
      queueKey,
      queue: queueConfig,
      items,
      sheetFetchedAt: pickListSheet.fetchedAt,
      sheetSkuCount: pickListSheet.sourceRowCount,
      notesEnabled: pickListSheet.notesEnabled || false,
      notesLoaded: pickListSheet.notesLoaded || false,
      notesError: pickListSheet.notesError || null,
    });
  } catch (err) {
    console.error('Error in /api/print-catalog:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.get('/api/part-explorer-catalog', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const pickListSheet = await fetchPickListSheet();
    const items = buildPartExplorerCatalogFromSheet({
      skuMap: pickListSheet.skuMap,
    });

    return res.json({
      success: true,
      items,
      sheetFetchedAt: pickListSheet.fetchedAt,
      sheetSkuCount: pickListSheet.sourceRowCount,
      notesEnabled: pickListSheet.notesEnabled || false,
      notesLoaded: pickListSheet.notesLoaded || false,
      notesError: pickListSheet.notesError || null,
    });
  } catch (err) {
    console.error('Error in /api/part-explorer-catalog:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.get('/api/print-queue', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const queueKey = getPrintQueueKeyFromRequest(req);
    const queueConfig = getPrintQueueConfig(queueKey);
    const items = sessionsStore.getPrintQueueItems({
      shop: auth.shop,
      queueKey,
      completeLimit: 80,
    });
    const itemsWithAwaitingParts = attachAwaitingPartsMatchesToPrintQueueItems({
      shop: auth.shop,
      items,
    });

    return res.json({
      success: true,
      queueKey,
      queue: queueConfig,
      stages: getPrintQueueStages(queueKey),
      items: itemsWithAwaitingParts,
    });
  } catch (err) {
    console.error('Error in /api/print-queue:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.post('/api/print-queue/catalog', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const queueKey = getPrintQueueKeyFromRequest(req);
    const sku = normalizeSku(req.body?.sku);
    if (!sku) {
      return res.status(400).json({
        success: false,
        error: 'Missing SKU',
      });
    }

    const pickListSheet = await fetchPickListSheet();
    const sheetRow = pickListSheet.skuMap.get(sku);
    if (!sheetRow) {
      return res.status(404).json({
        success: false,
        error: `SKU ${sku} not found in pick list sheet`,
      });
    }

    if (!isPrintableSheetRow(sheetRow, queueKey)) {
      return res.status(400).json({
        success: false,
        error: `SKU ${sku} is not a ${getPrintQueueTypeLabel(queueKey)} item`,
      });
    }

    const requestedQuantity = req.body?.quantity == null || req.body?.quantity === ''
      ? null
      : parsePositiveInteger(req.body.quantity, 1);

    const queueItems = buildPrintQueueItemsForCatalogSku({
      skuMap: pickListSheet.skuMap,
      sku,
      quantity: requestedQuantity,
      queueKey,
    });

    if (!queueItems.length) {
      return res.status(400).json({
        success: false,
        error: `No eligible ${getPrintQueueTypeLabel(queueKey)} print jobs found for ${sku}`,
      });
    }

    const createdItems = sessionsStore.addPrintQueueItems({
      shop: auth.shop,
      createdBy: auth.userId,
      items: queueItems,
    });
    const createdPartCount = createdItems.reduce((count, item) => (
      count + 1 + (Array.isArray(item.childItems) ? item.childItems.length : 0)
    ), 0);

    return res.json({
      success: true,
      createdItems,
      createdCount: createdItems.length,
      createdPartCount,
      rootSku: sku,
      requestedQuantity,
      sheetFetchedAt: pickListSheet.fetchedAt,
      sheetSkuCount: pickListSheet.sourceRowCount,
      queueKey,
      queue: getPrintQueueConfig(queueKey),
    });
  } catch (err) {
    console.error('Error in /api/print-queue/catalog:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.post('/api/print-queue/custom', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const queueKey = getPrintQueueKeyFromRequest(req);
    const title = String(req.body?.title || '').trim();
    if (!title) {
      return res.status(400).json({
        success: false,
        error: 'Missing custom file name',
      });
    }

    const quantity = parsePositiveInteger(req.body?.quantity, 1);
    const customFileUrl = String(req.body?.customFileUrl || '').trim();
    if (customFileUrl && !/^https?:\/\//i.test(customFileUrl)) {
      return res.status(400).json({
        success: false,
        error: 'Custom file link must start with http:// or https://',
      });
    }

    const createdItems = sessionsStore.addPrintQueueItems({
      shop: auth.shop,
      createdBy: auth.userId,
      items: [{
        queueKey,
        sourceType: 'custom',
        title,
        typeRaw: 'CUSTOM',
        quantity,
        customFileName: String(req.body?.customFileName || title).trim(),
        customFileUrl,
        notes: String(req.body?.notes || '').trim(),
        stageKey: DEFAULT_PRINT_QUEUE_STAGE,
      }],
    });

    return res.json({
      success: true,
      queueKey,
      queue: getPrintQueueConfig(queueKey),
      createdItems,
      createdCount: createdItems.length,
    });
  } catch (err) {
    console.error('Error in /api/print-queue/custom:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.get('/api/print-queue/settings', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    return res.json({
      success: true,
      settings: sessionsStore.getPrintQueueSettings({ shop: auth.shop }),
    });
  } catch (err) {
    console.error('Error in /api/print-queue/settings:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.post('/api/print-queue/settings', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const driveFolderIds = normalizeGoogleDriveFolderIds(
      req.body?.driveFolderIds || req.body?.driveFolderValue || req.body?.driveFolderId
    );
    const stlExtensions = String(req.body?.stlExtensions || 'stl,3mf').trim();

    const settings = sessionsStore.updatePrintQueueSettings({
      shop: auth.shop,
      driveFolderIds,
      stlExtensions,
      updatedBy: auth.userId,
    });

    return res.json({
      success: true,
      settings,
    });
  } catch (err) {
    console.error('Error in /api/print-queue/settings:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.get('/api/print-queue/orientations', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    return res.json({
      success: true,
      orientations: sessionsStore.listPrintPartOrientations({ shop: auth.shop, limit: 100 }),
    });
  } catch (err) {
    console.error('Error in /api/print-queue/orientations:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.get('/api/print-queue/orientations/:sku', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const sku = normalizeSku(req.params.sku);
    if (!sku) {
      return res.status(400).json({
        success: false,
        error: 'Missing SKU',
      });
    }

    const printQueueSettings = sessionsStore.getPrintQueueSettings({ shop: auth.shop });
    const driveFile = await getDriveModelFileForSku(sku, printQueueSettings);
    const orientation = sessionsStore.getPrintPartOrientation({ shop: auth.shop, sku });

    return res.json({
      success: true,
      sku,
      driveFile: driveFile ? {
        id: driveFile.id,
        name: driveFile.name,
        modifiedTime: driveFile.modifiedTime || '',
        size: driveFile.size || '',
        webViewLink: driveFile.webViewLink || '',
      } : null,
      orientation,
      status: getOrientationFileStatus(orientation, driveFile),
    });
  } catch (err) {
    console.error('Error in /api/print-queue/orientations/:sku:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.post('/api/print-queue/orientations/:sku', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const sku = normalizeSku(req.params.sku);
    if (!sku) {
      return res.status(400).json({
        success: false,
        error: 'Missing SKU',
      });
    }

    const printQueueSettings = sessionsStore.getPrintQueueSettings({ shop: auth.shop });
    const driveFile = await getDriveModelFileForSku(sku, printQueueSettings);
    if (!driveFile) {
      return res.status(404).json({
        success: false,
        error: `No STL/3MF file found for ${sku}`,
      });
    }

    const orientation = sessionsStore.savePrintPartOrientation({
      shop: auth.shop,
      sku,
      driveFile,
      orientation: req.body?.orientation || {},
      lockMode: 'LOCKED_XY_ROTATION_FREE_TRANSLATION',
      updatedBy: auth.userId,
    });

    return res.json({
      success: true,
      sku,
      driveFile: {
        id: driveFile.id,
        name: driveFile.name,
        modifiedTime: driveFile.modifiedTime || '',
        size: driveFile.size || '',
        webViewLink: driveFile.webViewLink || '',
      },
      orientation,
      status: getOrientationFileStatus(orientation, driveFile),
    });
  } catch (err) {
    console.error('Error in POST /api/print-queue/orientations/:sku:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.get('/api/print-queue/stl/:sku/download', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const sku = normalizeSku(req.params.sku);
    if (!sku) {
      return res.status(400).json({
        success: false,
        error: 'Missing SKU',
      });
    }

    const printQueueSettings = sessionsStore.getPrintQueueSettings({ shop: auth.shop });
    const download = await openDriveModelFileStreamForSku(sku, printQueueSettings);
    if (!download) {
      return res.status(404).json({
        success: false,
        error: `No STL/3MF file found for ${sku}`,
      });
    }

    const filename = String(download.file?.name || `${sku}.stl`).replace(/[\r\n"]/g, '_');
    const fileExtension = path.extname(filename).replace(/^\./, '').toLowerCase();
    const rawRequested = ['1', 'true', 'source', 'raw'].includes(
      String(req.query?.raw || req.query?.orientation || '').trim().toLowerCase()
    );
    const savedOrientation = sessionsStore.getPrintPartOrientation({ shop: auth.shop, sku });
    const orientationStatus = getOrientationFileStatus(savedOrientation, download.file);
    const contentType = download.response.headers.get('content-type') || 'application/octet-stream';
    const contentLength = download.response.headers.get('content-length') || download.file?.size || '';

    if (!rawRequested && fileExtension === 'stl' && orientationStatus === 'current') {
      const sourceBuffer = await download.response.buffer();
      const orientedBuffer = transformStlBufferOrientation(sourceBuffer, savedOrientation.orientation);

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', orientedBuffer.length);
      res.setHeader('X-Drive-File-Id', String(download.file?.id || ''));
      res.setHeader('X-Print-Orientation-Applied', 'true');
      return res.send(orientedBuffer);
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Drive-File-Id', String(download.file?.id || ''));
    res.setHeader('X-Print-Orientation-Applied', 'false');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    download.response.body.on('error', (streamErr) => {
      console.error(`Google Drive STL stream failed for ${sku}:`, streamErr);
      if (!res.headersSent) {
        res.status(500).end('Failed to stream STL file');
      } else {
        res.destroy(streamErr);
      }
    });
    return download.response.body.pipe(res);
  } catch (err) {
    console.error('Error in /api/print-queue/stl/:sku/download:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.get('/api/print-queue/qc/:sku/pdf', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const sku = normalizeSku(req.params.sku);
    if (!sku) {
      return res.status(400).json({
        success: false,
        error: 'Missing SKU',
      });
    }

    const printQueueSettings = sessionsStore.getPrintQueueSettings({ shop: auth.shop });
    const download = await openDriveQcPdfStreamForSku(sku, printQueueSettings);
    if (!download) {
      return res.status(404).json({
        success: false,
        error: `No QC PDF found for ${sku}`,
      });
    }

    const filename = String(download.file?.name || `${sku}.pdf`).replace(/[\r\n"]/g, '_');
    const contentLength = download.response.headers.get('content-length') || download.file?.size || '';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('X-Drive-File-Id', String(download.file?.id || ''));
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    download.response.body.on('error', (streamErr) => {
      console.error(`Google Drive QC PDF stream failed for ${sku}:`, streamErr);
      if (!res.headersSent) {
        res.status(500).end('Failed to stream QC PDF');
      } else {
        res.destroy(streamErr);
      }
    });
    return download.response.body.pipe(res);
  } catch (err) {
    console.error('Error in /api/print-queue/qc/:sku/pdf:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.get('/api/print-queue/preform-builds/:buildId/:artifact/download', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const buildId = String(req.params.buildId || '').trim();
    const artifact = String(req.params.artifact || '').trim().toLowerCase();

    if (artifact === 'zip') {
      const artifacts = getExistingPreformBuildArtifacts(buildId);
      if (artifacts.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'No downloadable files found for this PreForm build',
        });
      }

      const filename = `${artifacts[0].buildId}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      const archive = new ZipArchive({ zlib: { level: 9 } });
      archive.on('error', (archiveErr) => {
        console.error(`PreForm build zip failed for ${buildId}:`, archiveErr);
        if (!res.headersSent) {
          res.status(500).end('Failed to create build zip');
        } else {
          res.destroy(archiveErr);
        }
      });

      archive.pipe(res);
      artifacts.forEach((artifactInfo) => {
        archive.file(artifactInfo.filePath, { name: artifactInfo.filename });
      });
      await archive.finalize();
      return;
    }

    const artifactInfo = resolvePreformBuildArtifact(buildId, artifact);
    if (!artifactInfo) {
      return res.status(400).json({
        success: false,
        error: 'Invalid PreForm build download',
      });
    }

    if (!fs.existsSync(artifactInfo.filePath)) {
      return res.status(404).json({
        success: false,
        error: 'PreForm build file not found',
      });
    }

    const stats = fs.statSync(artifactInfo.filePath);
    res.setHeader('Content-Type', artifactInfo.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${artifactInfo.filename}"`);
    res.setHeader('Content-Length', String(stats.size));

    const stream = fs.createReadStream(artifactInfo.filePath);
    stream.on('error', (streamErr) => {
      console.error(`PreForm build download failed for ${buildId}:`, streamErr);
      if (!res.headersSent) {
        res.status(500).end('Failed to download build file');
      } else {
        res.destroy(streamErr);
      }
    });
    return stream.pipe(res);
  } catch (err) {
    console.error('Error in /api/print-queue/preform-builds/:buildId/:artifact/download:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.post('/api/print-queue/preform-build', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const queueKey = getPrintQueueKeyFromRequest(req);
    if (queueKey !== DEFAULT_PRINT_QUEUE_KEY) {
      return res.status(400).json({
        success: false,
        error: 'PreForm build preparation is only available for the SLS / Adapter print queue.',
      });
    }

    const queueItems = sessionsStore.getActivePrintQueueItems({
      shop: auth.shop,
      queueKey,
    });
    const needsPrintedItems = queueItems.filter((item) => item.stageKey === DEFAULT_PRINT_QUEUE_STAGE);
    if (!needsPrintedItems.length) {
      return res.status(400).json({
        success: false,
        error: 'No jobs are currently in Needs Printed',
      });
    }

    const printQueueSettings = sessionsStore.getPrintQueueSettings({ shop: auth.shop });
    const orientationRequired = await findPrintQueueOrientationRequirements({
      shop: auth.shop,
      items: needsPrintedItems,
      settings: printQueueSettings,
    });
    if (orientationRequired.length > 0) {
      return res.status(409).json({
        success: false,
        code: 'PRINT_ORIENTATION_REQUIRED',
        error: 'Every STL must be manually oriented before preparing a PreForm build.',
        orientationRequired,
      });
    }

    const orientationSkus = Array.from(new Set(needsPrintedItems.flatMap(collectPrintQueueSkus)));
    printQueueSettings.partOrientations = sessionsStore.getPrintPartOrientationsForSkus({
      shop: auth.shop,
      skus: orientationSkus,
    });
    const buildResult = await preparePreformBuildFromQueueItems(needsPrintedItems, printQueueSettings);
    const movedItemIds = [];
    const hasBuildIssues = Boolean(buildResult.hasBuildIssues)
      || Number(buildResult.manifest?.missingFiles?.length || 0) > 0
      || Number(buildResult.manifest?.skippedCustomItems?.length || 0) > 0;

    if (buildResult.preform?.formFilePath && req.body?.moveToInBuild !== false && !hasBuildIssues) {
      const queueItemIds = Array.isArray(buildResult.manifest?.queueItemIds)
        ? buildResult.manifest.queueItemIds
        : [];
      queueItemIds.forEach((id) => {
        const updatedItem = sessionsStore.updatePrintQueueItemStage({
          shop: auth.shop,
          id: Number(id),
          stageKey: 'in_build',
        });
        if (updatedItem) movedItemIds.push(updatedItem.id);
      });
    }

    return res.json({
      success: true,
      mode: buildResult.mode,
      manifest: buildResult.manifest,
      manifestPath: buildResult.manifestPath,
      preform: buildResult.preform,
      hasBuildIssues,
      partialBuild: Boolean(buildResult.partialBuild),
      downloads: getPreformBuildDownloads(buildResult),
      movedItemIds,
    });
  } catch (err) {
    console.error('Error in /api/print-queue/preform-build:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.post('/api/print-queue/:id/stage', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing print item id',
      });
    }

    const existingItem = sessionsStore.getPrintQueueItem({
      shop: auth.shop,
      id,
    });
    if (!existingItem) {
      return res.status(404).json({
        success: false,
        error: 'Print queue item not found',
      });
    }

    const stageKey = normalizeStageKey(req.body?.stageKey, existingItem.queueKey);
    if (!stageKey) {
      return res.status(400).json({
        success: false,
        error: 'Missing valid stage for this print queue',
      });
    }

    const item = sessionsStore.updatePrintQueueItemStage({
      shop: auth.shop,
      id,
      stageKey,
    });

    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Print queue item not found',
      });
    }

    return res.json({
      success: true,
      item,
    });
  } catch (err) {
    console.error('Error in /api/print-queue/:id/stage:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.delete('/api/print-queue/:id', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing print item id',
      });
    }

    const result = sessionsStore.removePrintQueueItem({
      shop: auth.shop,
      id,
      removedBy: auth.userId,
    });

    if (result.reason === 'not_found') {
      return res.status(404).json({
        success: false,
        error: 'Print queue item not found',
      });
    }

    return res.json({
      success: true,
      item: result.item,
    });
  } catch (err) {
    console.error('Error in DELETE /api/print-queue/:id:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.post('/api/print-queue/:id/put-away', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing print item id',
      });
    }

    const result = sessionsStore.putAwayPrintQueueItem({
      shop: auth.shop,
      id,
    });

    if (result.reason === 'not_found') {
      return res.status(404).json({
        success: false,
        error: 'Print queue item not found',
      });
    }

    if (result.reason === 'not_complete') {
      return res.status(400).json({
        success: false,
        error: 'Only complete print jobs can be put away',
      });
    }

    const printedSkus = collectPrintQueueSkus(result.item);
    const awaitingRows = sessionsStore.getOpenAwaitingPartsItemsForSkus({
      shop: auth.shop,
      skus: printedSkus,
    });
    const awaitingPartsMatches = summarizeAwaitingPartsMatches(awaitingRows);
    let awaitingPartsChatSent = false;
    let awaitingPartsChatError = null;

    const webhookUrl = String(process.env.GCHAT_WEBHOOK_URL || '').trim();
    if (webhookUrl) {
      try {
        await sendGoogleChatMessage(
          webhookUrl,
          formatPrintPutAwayAwaitingPartsChat({
            item: result.item,
            matches: awaitingPartsMatches,
            staff: auth.userId,
          })
        );
        awaitingPartsChatSent = true;
      } catch (chatErr) {
        awaitingPartsChatError = chatErr.message || 'Failed to send Google Chat message';
        console.error('Google Chat print put-away notification failed:', chatErr);
      }
    } else {
      awaitingPartsChatError = 'GCHAT_WEBHOOK_URL is not configured';
    }

    return res.json({
      success: true,
      item: result.item,
      awaitingPartsMatches,
      awaitingPartsChatSent,
      awaitingPartsChatError,
    });
  } catch (err) {
    console.error('Error in /api/print-queue/:id/put-away:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.post('/api/qc-fail', async (req, res) => {
  try {
    const { orderId, sku, reason } = req.body;
    const barcode = orderId;

    if (!barcode || !sku || !reason) {
      return res.status(400).json({
        success: false,
        error: 'Missing orderId, sku, or reason',
      });
    }

    const shop = req.cookies.shop;
    if (!shop) {
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

    const userId = req.cookies.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Username needs to be set' });
    }

    const session = sessionsStore.get(shop);
    if (!session) {
      return res.status(401).json({ success: false, error: 'No session found' });
    }

    const staff = userId || 'Unknown';
    const normalizedBarcode = normalizeScanBarcode(barcode);
    const client = shopifyClient(session);

    const findOrderQuery = `
      query findOrder($query: String!) {
        orders(first: ${ORDER_LOOKUP_CANDIDATE_LIMIT}, query: $query) {
          edges {
            node {
              id
              name
              note
            }
          }
        }
      }
    `;

    const findRes = await client.graphql(findOrderQuery, {
      variables: {
        query: buildOrderSearchQuery(normalizedBarcode),
      },
    });

    const orderEdge = selectExactOrderEdge(findRes.data?.orders?.edges, normalizedBarcode);
    if (!orderEdge) {
      return res.status(404).json({
        success: false,
        error: `Order ${barcode} not found`,
      });
    }

    const order = orderEdge.node;
    const latestWaitingQcStaff = resolveLatestWaitingQcStaff({
      shop,
      normalizedBarcode,
      orderId: order.id,
      orderNote: order.note || '',
    });

    const qcFailCreatedAt = new Date();
    const timestamp = qcFailCreatedAt
      .toISOString()
      .replace('T', ' ')
      .slice(0, 16);
    const normalizedReason = String(reason).trim();
    const normalizedSku = normalizeSku(sku);

    const qcFailBlock = [
      '~',
      `QC FAIL — ${timestamp}`,
      `Team Member: ${staff}`,
      `SKU: ${normalizedSku}`,
      `Reason: ${normalizedReason}`,
      '',
    ].join('\n');

    const updatedNote = (order.note || '') + qcFailBlock;

    const updateNoteMutation = `
      mutation updateOrderNote($id: ID!, $note: String) {
        orderUpdate(input: { id: $id, note: $note }) {
          userErrors {
            field
            message
          }
        }
      }
    `;

    //  DONT UPDATE ORDER NOTES AS WE DONT WANT CUSTOMER SEEING THIS.
    // const updateRes = await client.graphql(updateNoteMutation, {
    //   variables: {
    //     id: order.id,
    //     note: updatedNote,
    //   },
    // });

    // if (updateRes.data?.orderUpdate?.userErrors?.length) {
    //   console.error(updateRes.data.orderUpdate.userErrors);
    //   return res.status(500).json({
    //     success: false,
    //     error: 'Failed to update order note',
    //   });
    // }

    const qcFailRecord = sessionsStore.recordQcFailReason({
      shop,
      barcode: normalizedBarcode,
      orderId: order.id,
      orderNumber: order.name,
      sku: normalizedSku,
      reason: normalizedReason,
      reportedBy: staff,
      builtBy: latestWaitingQcStaff || '',
      createdAt: qcFailCreatedAt.toISOString(),
    });

    try {
      await sendGoogleChatMessage(
        process.env.GCHAT_QC_FAIL_URL,
        [
          `QC fail reported for order ${order.name}`,
          `Reported by: ${staff}`,
          `Built by: ${latestWaitingQcStaff || 'No waiting_qc record found'}`,
          `SKU: ${normalizedSku}`,
          `Reason: ${normalizedReason}`,
        ].join('\n')
      );
    } catch (chatErr) {
      console.error('Google Chat notification failed:', chatErr);
    }

    return res.json({
      success: true,
      orderNumber: order.name,
      sku: normalizedSku,
      qcFailReason: qcFailRecord,
      latestWaitingQcStaff: latestWaitingQcStaff || null,
    });
  } catch (err) {
    console.error('Error in /api/qc-fail:', err);
    if (err.response) {
      console.error('API Response Dump:', JSON.stringify(err.response, null, 2));
    }
    return res.status(500).json({
      success: false,
      error: 'Server error',
    });
  }
});

router.post('/api/pick-list/shipping/lookup', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const normalizedBarcode = normalizeScanBarcode(req.body?.barcode);
    if (!normalizedBarcode) {
      return res.status(400).json({ success: false, error: 'Missing barcode' });
    }

    const client = shopifyClient(auth.session);
    const order = await findOrderForShipping({ client, barcode: normalizedBarcode });
    if (!order) {
      return res.status(404).json({ success: false, error: `Order ${normalizedBarcode} not found` });
    }

    const workflowBlock = getOrderWorkflowBlock(order);
    const payment = getOrderPaymentState(order);
    if ((workflowBlock && !canManageShippingDespiteWorkflowBlock(workflowBlock)) || !payment.canShip) {
      return res.json({
        success: true,
        orderNumber: order.name,
        payment,
        workflowBlocked: Boolean(workflowBlock),
        workflowWarning: workflowBlock?.message || '',
        shipmentFound: false,
        attemptedIdentifiers: buildShippingOrderIdentifiers({ order, barcode: normalizedBarcode }),
        existingLabels: [],
      });
    }

    const identifiers = buildShippingOrderIdentifiers({ order, barcode: normalizedBarcode });
    const lookup = await lookupShipmentForOrder({ identifiers });
    let shipment = lookup.shipment || null;
    if (shipment?.shipmentId) {
      try {
        shipment = await getShipmentById(shipment.shipmentId) || shipment;
      } catch (detailErr) {
        console.warn('[ShipStation package types] Could not refresh shipment before package type lookup', {
          shipmentId: shipment.shipmentId,
          error: detailErr.message || String(detailErr),
        });
      }
    }
    const existingLabels = shipment?.shipmentId
      ? await getKnownShippingLabelsForShipment({
          shop: auth.shop,
          barcode: normalizedBarcode,
          orderNumber: order.name,
          shipmentId: shipment.shipmentId,
          reusableOnly: false,
        })
      : [];
    let packageTypes = [];
    let packageTypesError = '';
    let packageTypesAttempts = [];
    if (shipment && isUkCountryCode(shipment?.shipTo?.countryCode)) {
      try {
        const packageTypeResult = await listPackageTypesForShipment(shipment);
        packageTypes = packageTypeResult.packageTypes || [];
        packageTypesAttempts = packageTypeResult.attempts || [];
        if (!packageTypes.length) {
          packageTypesError = 'ShipStation did not return package types for this carrier.';
        }
        console.log('[ShipStation package types] Lookup completed', {
          shipmentId: shipment.shipmentId,
          carrierId: shipment.carrierId,
          carrierCode: shipment.carrierCode,
          carrierFriendlyName: shipment.carrierFriendlyName,
          packageTypeCount: packageTypes.length,
          attempts: packageTypesAttempts,
        });
      } catch (packageErr) {
        packageTypesError = packageErr.message || 'Could not load ShipStation package types.';
        console.error('[ShipStation package types] Failed to load carrier packages', {
          shipmentId: shipment.shipmentId,
          carrierId: shipment.carrierId,
          carrierCode: shipment.carrierCode,
          carrierFriendlyName: shipment.carrierFriendlyName,
          error: packageTypesError,
        });
      }
    }

    return res.json({
      success: true,
      orderNumber: order.name,
      payment,
      shipmentFound: Boolean(shipment),
      shipment,
      packageTypes,
      packageTypesError,
      packageTypesAttempts,
      selectedAttemptLabel: lookup.selectedAttemptLabel || '',
      attemptedIdentifiers: lookup.attemptedIdentifiers || identifiers,
      attemptedQueries: lookup.attemptedQueries || [],
      candidates: lookup.candidates || [],
      existingLabels: existingLabels.map(summarizeShippingLabel),
    });
  } catch (err) {
    console.error('Error in /api/pick-list/shipping/lookup:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
    });
  }
});

router.post('/api/pick-list/shipping/rates', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const normalizedBarcode = normalizeScanBarcode(req.body?.barcode);
    const shipmentId = String(req.body?.shipmentId || '').trim();
    const weightGrams = Math.floor(Number(req.body?.weightGrams) || 0);
    const packageDimensions = normalizeShippingPackageDimensionsInput(req.body?.packageDimensions);
    const shippingPackages = normalizeShippingPackagesInput(req.body?.packages, {
      weightGrams,
      packageDimensions,
    });
    const selectedPackageCode = String(req.body?.packageCode || '').trim();
    const shippingPackagesWithPackageCode = selectedPackageCode
      ? shippingPackages.map((pkg) => ({ ...pkg, packageCode: selectedPackageCode }))
      : shippingPackages;
    if (!normalizedBarcode || !shipmentId) {
      return res.status(400).json({ success: false, error: 'Missing barcode or shipment id' });
    }
    if (!shippingPackages.length) {
      return res.status(400).json({ success: false, error: 'Enter valid package weights and package sizes.' });
    }

    console.log('[ShipStation rate check] Starting rate check', {
      shop: auth.shop,
      barcode: normalizedBarcode,
      shipmentId,
      packageCount: shippingPackagesWithPackageCode.length,
      packageCode: selectedPackageCode,
      rawRequestBody: req.body,
      packages: shippingPackagesWithPackageCode,
    });

    const client = shopifyClient(auth.session);
    const order = await findOrderForShipping({ client, barcode: normalizedBarcode });
    if (!order) {
      return res.status(404).json({ success: false, error: `Order ${normalizedBarcode} not found` });
    }

    const workflowBlock = getOrderWorkflowBlock(order);
    if (workflowBlock && !canManageShippingDespiteWorkflowBlock(workflowBlock)) {
      return res.status(409).json({ success: false, error: workflowBlock.message, workflowBlocked: true });
    }

    const payment = getOrderPaymentState(order);
    if (!payment.canShip) {
      return res.status(409).json({ success: false, error: payment.message, payment });
    }

    console.log('[ShipStation rate check] Shopify order accepted for rating', {
      barcode: normalizedBarcode,
      orderNumber: order.name,
      financialStatus: payment.financialStatus,
      shipmentId,
      packageCount: shippingPackagesWithPackageCode.length,
      packageCode: selectedPackageCode,
      packages: shippingPackagesWithPackageCode,
    });

    const updatedShipment = await updateShipmentPackages({
      shipmentId,
      packages: shippingPackagesWithPackageCode,
    });
    let ratedShipment = updatedShipment;
    let ratePackageCode = ratedShipment?.packages?.[0]?.packageCode || ratedShipment?.packageCode || selectedPackageCode || '';
    let rateResult = null;
    let rateError = null;

    try {
      rateResult = await getShipmentRatesDetailed(shipmentId, {
        carrierId: ratedShipment?.carrierId || '',
        selectedServiceCode: ratedShipment?.serviceCode || '',
        packageCode: ratePackageCode,
        preferredCurrency: 'GBP',
      });
    } catch (err) {
      rateError = err;
    }

    let rates = Array.isArray(rateResult?.rates) ? rateResult.rates : [];
    let retryInfo = null;
    const cityAsStateFallback = getEmptyStateCityFallback(updatedShipment);

    if ((rateError || !rates.length) && cityAsStateFallback) {
      const firstAttemptDiagnostics = rateError?.rateDiagnostics || rateResult?.diagnostics || null;
      retryInfo = {
        attempted: true,
        applied: false,
        reason: 'ship_to.stateProvince was empty and the first ShipStation rate attempt did not return a usable rate.',
        stateProvince: cityAsStateFallback,
        city: updatedShipment?.shipTo?.city || cityAsStateFallback,
        firstAttempt: firstAttemptDiagnostics,
        retryAttempt: null,
      };

      console.log('[ShipStation rate check] Retrying with city as state/province fallback', {
        barcode: normalizedBarcode,
        orderNumber: order.name,
        shipmentId,
        city: retryInfo.city,
        stateProvince: cityAsStateFallback,
        firstAttemptError: rateError?.message || '',
        firstAttemptRateCount: rates.length,
      });

      try {
        ratedShipment = await updateShipmentPackages({
          shipmentId,
          packages: shippingPackagesWithPackageCode,
          shipToStateProvince: cityAsStateFallback,
        });
        retryInfo.applied = true;
        ratePackageCode = ratedShipment?.packages?.[0]?.packageCode || ratedShipment?.packageCode || selectedPackageCode || '';
        rateResult = await getShipmentRatesDetailed(shipmentId, {
          carrierId: ratedShipment?.carrierId || '',
          selectedServiceCode: ratedShipment?.serviceCode || '',
          packageCode: ratePackageCode,
          preferredCurrency: 'GBP',
        });
        rates = Array.isArray(rateResult?.rates) ? rateResult.rates : [];
        retryInfo.retryAttempt = rateResult?.diagnostics || null;
        rateError = null;
      } catch (retryErr) {
        retryInfo.retryAttempt = retryErr.rateDiagnostics || null;
        retryErr.rateDiagnostics = {
          ...(retryErr.rateDiagnostics || {}),
          retry: {
            emptyStateCityFallback: retryInfo,
          },
        };
        throw retryErr;
      }
    }

    if (rateError) {
      throw rateError;
    }

    const rateDiagnostics = buildShippingRateRouteDiagnostics({
      rateResult,
      shipment: ratedShipment,
      ratePackageCode,
      packages: shippingPackages,
      retryInfo,
    });
    console.log('[ShipStation rate check] Rate check completed', {
      barcode: normalizedBarcode,
      orderNumber: order.name,
      shipmentId,
      updatedShipmentId: ratedShipment?.shipmentId || '',
      packageCount: ratedShipment?.packages?.length || shippingPackages.length,
      cityAsStateFallbackApplied: Boolean(retryInfo?.applied),
      rateCount: rates.length,
      rates: rates.map((rate) => summarizeShippingRate(rate)),
    });

    if (!rates.length) {
      if (isRoyalMailShippingEntity(ratedShipment)) {
        return res.json({
          success: true,
          orderNumber: order.name,
          payment,
          shipment: ratedShipment,
          expiresAt: null,
          rates: [],
          noRateReason: 'Royal Mail service is available, but ShipStation does not return a quote through the API.',
          rateDiagnostics,
        });
      }

      return res.status(422).json({
        success: false,
        error: 'ShipStation did not return any valid rates for this shipment.',
        shipment: ratedShipment,
        rateError: true,
        rateDiagnostics,
      });
    }

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const quoteRecords = rates.map((rate) => sessionsStore.createShippingQuote({
      shop: auth.shop,
      barcode: normalizedBarcode,
      orderNumber: order.name,
      shipment: ratedShipment,
      rate,
      weightGrams: shippingPackagesWithPackageCode.reduce((sum, pkg) => sum + Math.max(1, Number(pkg.weightGrams) || 1), 0),
      expiresAt,
    })).filter(Boolean);

    const quoteByRateId = new Map(quoteRecords.map((quote) => [quote.rateId, quote]));

    return res.json({
      success: true,
      orderNumber: order.name,
      payment,
      shipment: ratedShipment,
      expiresAt,
      rates: rates.map((rate) => summarizeShippingRate(rate, quoteByRateId.get(rate.rateId))),
      rateDiagnostics,
    });
  } catch (err) {
    console.error('Error in /api/pick-list/shipping/rates:', {
      error: err.message || String(err),
      stack: err.stack,
      barcode: req.body?.barcode,
      shipmentId: req.body?.shipmentId,
      weightGrams: req.body?.weightGrams,
      packageDimensions: req.body?.packageDimensions,
      packageCode: req.body?.packageCode,
      packages: req.body?.packages,
    });
    const rateDiagnostics = err.rateDiagnostics || {
      request: {
        method: err.method || '',
        url: err.url || '',
        body: {
          barcode: req.body?.barcode,
          shipmentId: req.body?.shipmentId,
          weightGrams: req.body?.weightGrams,
          packageDimensions: req.body?.packageDimensions,
          packageCode: req.body?.packageCode,
          packages: req.body?.packages,
        },
      },
      response: {
        status: err.status || null,
        errors: [err.message || 'Server error'].filter(Boolean),
        rawErrors: err.data || null,
      },
    };
    return res.status(500).json({
      success: false,
      error: err.message || 'Server error',
      rateError: true,
      rateDiagnostics,
    });
  }
});

router.post('/api/pick-list/shipping/labels', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const quoteId = String(req.body?.quoteId || '').trim();
    if (!quoteId) {
      return res.status(400).json({ success: false, error: 'Missing quote id' });
    }

    const quote = sessionsStore.getShippingQuote({ shop: auth.shop, quoteId });
    if (!quote) {
      return res.status(404).json({ success: false, error: 'Shipping quote not found. Rate the shipment again.' });
    }
    if (quote.isExpired) {
      return res.status(409).json({ success: false, error: 'Shipping quote expired. Rate the shipment again.' });
    }

    const client = shopifyClient(auth.session);
    const order = await findOrderForShipping({ client, barcode: quote.barcode });
    if (!order) {
      return res.status(404).json({ success: false, error: `Order ${quote.barcode} not found` });
    }

    const workflowBlock = getOrderWorkflowBlock(order);
    if (workflowBlock && !canManageShippingDespiteWorkflowBlock(workflowBlock)) {
      return res.status(409).json({ success: false, error: workflowBlock.message, workflowBlocked: true });
    }

    const payment = getOrderPaymentState(order);
    if (!payment.canShip) {
      return res.status(409).json({ success: false, error: payment.message, payment });
    }

    const purchaseBlock = getShippingLabelPurchaseBlock(order);
    if (purchaseBlock) {
      return res.status(409).json({
        success: false,
        error: purchaseBlock.message,
        purchaseBlocked: true,
        currentStage: purchaseBlock.currentStage,
        payment,
      });
    }

    const knownLabels = await getKnownShippingLabelsForShipment({
      shop: auth.shop,
      barcode: quote.barcode,
      orderNumber: order.name || quote.orderNumber,
      shipmentId: quote.shipmentId,
      requireRemote: true,
    });
    const existingLabel = knownLabels.find(isReusableShippingLabel);
    if (existingLabel) {
      sessionsStore.markShippingQuotePurchased({
        shop: auth.shop,
        quoteId,
        labelId: existingLabel.labelId,
      });
      return res.json({
        success: true,
        reusedExistingLabel: true,
        label: summarizeShippingLabel(existingLabel),
        payment,
      });
    }

    const purchasedLabel = await purchaseLabelForRate(quote.rateId);
    if (!purchasedLabel?.labelId) {
      throw new Error('ShipStation did not return a purchased label id.');
    }

    let labelRecord = sessionsStore.upsertShippingLabel({
      shop: auth.shop,
      barcode: quote.barcode,
      orderNumber: order.name || quote.orderNumber,
      quoteId,
      label: purchasedLabel,
      rate: quote.rate,
    });
    sessionsStore.markShippingQuotePurchased({
      shop: auth.shop,
      quoteId,
      labelId: purchasedLabel.labelId,
    });

    labelRecord = await tryPrintStoredShippingLabel({
      shop: auth.shop,
      label: labelRecord,
    });

    return res.json({
      success: true,
      reusedExistingLabel: false,
      label: summarizeShippingLabel(labelRecord),
      payment,
    });
  } catch (err) {
    console.error('Error in /api/pick-list/shipping/labels:', err);
    return res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

router.post('/api/pick-list/shipping/labels/:labelId/print', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const labelId = String(req.params.labelId || '').trim();
    const label = sessionsStore.getShippingLabel({ shop: auth.shop, labelId });
    if (!label) {
      return res.status(404).json({ success: false, error: 'Shipping label not found.' });
    }
    if (!isReusableShippingLabel(label)) {
      return res.status(409).json({ success: false, error: 'This shipping label has been voided.' });
    }

    const updatedLabel = await printStoredShippingLabel({
      shop: auth.shop,
      label,
      useIdempotency: false,
    });

    return res.json({
      success: true,
      label: summarizeShippingLabel(updatedLabel),
    });
  } catch (err) {
    console.error('Error in /api/pick-list/shipping/labels/:labelId/print:', err);
    const labelId = String(req.params.labelId || '').trim();
    const auth = req.cookies?.shop ? { shop: req.cookies.shop } : null;
    if (auth?.shop && labelId) {
      try {
        const updatedLabel = sessionsStore.updateShippingLabelPrintResult({
          shop: auth.shop,
          labelId,
          printStatus: 'error',
          printError: err.message || 'PrintNode print failed',
        });
        return res.status(500).json({
          success: false,
          error: err.message || 'Server error',
          label: summarizeShippingLabel(updatedLabel),
        });
      } catch (storeErr) {
        console.error('Failed to store print error:', storeErr);
      }
    }
    return res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

router.post('/api/pick-list/shipping/labels/:labelId/void', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const labelId = String(req.params.labelId || '').trim();
    const label = sessionsStore.getShippingLabel({ shop: auth.shop, labelId });
    if (!label) {
      return res.status(404).json({ success: false, error: 'Shipping label not found.' });
    }
    if (!isReusableShippingLabel(label)) {
      return res.status(409).json({
        success: false,
        error: 'This shipping label has already been voided or cannot be voided.',
        label: summarizeShippingLabel(label),
      });
    }

    const result = await voidLabelById(labelId);
    if (!result.approved) {
      return res.status(409).json({
        success: false,
        error: result.message || 'ShipStation did not approve the label void.',
        label: summarizeShippingLabel(label),
      });
    }

    let updatedLabel = sessionsStore.updateShippingLabelStatus({
      shop: auth.shop,
      labelId,
      status: 'voided',
      label: {
        ...(label.label || {}),
        status: 'voided',
        voidResult: result.raw,
      },
    }) || label;

    try {
      updatedLabel = await refreshStoredShippingLabel({ shop: auth.shop, label: updatedLabel });
    } catch (refreshErr) {
      console.error('Failed to refresh voided ShipStation label:', refreshErr);
    }

    return res.json({
      success: true,
      label: summarizeShippingLabel(updatedLabel),
      voidResult: result,
    });
  } catch (err) {
    console.error('Error in /api/pick-list/shipping/labels/:labelId/void:', err);
    return res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

router.get('/api/pick-list/shipping/labels/:labelId/download', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const labelId = String(req.params.labelId || '').trim();
    const label = sessionsStore.getShippingLabel({ shop: auth.shop, labelId });
    if (!label) {
      return res.status(404).json({ success: false, error: 'Shipping label not found.' });
    }
    if (!isReusableShippingLabel(label)) {
      return res.status(409).json({ success: false, error: 'This shipping label has been voided.' });
    }

    const { download } = await downloadStoredShippingLabelPdf({
      shop: auth.shop,
      label,
    });
    const fileName = `${String(label.orderNumber || label.barcode || label.labelId).replace(/[^A-Za-z0-9_-]+/g, '_')}-label.pdf`;
    res.setHeader('Content-Type', download.contentType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(download.buffer);
  } catch (err) {
    console.error('Error in /api/pick-list/shipping/labels/:labelId/download:', err);
    return res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

router.post('/api/wholesale-progress', async (req, res) => {
  try {
    const { barcode, progressByItemKey } = req.body || {};
    const normalizedBarcode = normalizeScanBarcode(barcode);
    if (!normalizedBarcode) {
      return res.status(400).json({ success: false, error: 'Missing barcode' });
    }

    if (!progressByItemKey || typeof progressByItemKey !== 'object' || Array.isArray(progressByItemKey)) {
      return res.status(400).json({ success: false, error: 'Missing progressByItemKey object' });
    }

    const shop = req.cookies.shop;
    if (!shop) {
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

    const session = sessionsStore.get(shop);
    if (!session) {
      return res.status(401).json({ success: false, error: 'No session found' });
    }

    const totalProgressCount = Object.values(progressByItemKey || {}).reduce((sum, value) => (
      sum + Math.max(0, Number(value) || 0)
    ), 0);

    sessionsStore.setWholesaleBuildProgress({
      shop,
      barcode: normalizedBarcode,
      progressByItemKey,
    });

    if (totalProgressCount > 0 && !sessionsStore.getWholesaleBuildEvent({ shop, barcode: normalizedBarcode })) {
      try {
        const staff = String(req.cookies.userId || '').trim() || 'Unknown';
        const client = shopifyClient(session);
        const queryVariables = {
          query: `${normalizedBarcode} status:any`,
        };

        let bundleMetadataSupported = true;
        let orderResponse;

        try {
          orderResponse = await client.graphql(getPickListOrderQuery({ includeBundleGroup: true }), {
            variables: queryVariables,
          });
        } catch (err) {
          if (!includesMissingBundleFieldError(err)) {
            throw err;
          }

          bundleMetadataSupported = false;
          orderResponse = await client.graphql(getPickListOrderQuery({ includeBundleGroup: false }), {
            variables: queryVariables,
          });
        }

        const orderEdge = selectExactOrderEdge(orderResponse.data?.orders?.edges, normalizedBarcode);
        const order = orderEdge?.node || null;

        if (order?.id) {
          const existingOrderEventRecorded = hasWholesaleAdapterBuiltNote(order.note || '');
          if (existingOrderEventRecorded) {
            sessionsStore.recordWholesaleBuildEvent({
              shop,
              barcode: normalizedBarcode,
              orderId: order.id,
              orderNumber: order.name,
              staff,
            });
          } else {
            const timestamp = new Date()
              .toISOString()
              .replace('T', ' ')
              .slice(0, 16);
            const orderNoteBlock = [
              '~',
              `WHOLESALE ADAPTER BUILT — ${timestamp}`,
              `Team Member: ${staff}`,
              '',
            ].join('\n');

            const noteResult = await appendOrderNoteOrWarn(client, order.id, orderNoteBlock, {
              route: '/api/pick-list',
              orderNumber: order.name,
              barcode: normalizedBarcode,
              tag: 'wholesale_adapter_built',
            });
            if (noteResult.success) {
              order.note = `${order.note || ''}${orderNoteBlock}`;
            }

            const lineItemArray = buildCurrentOrderLineItems(order.lineItems?.edges || []);
            await persistOrderTrackerSnapshot({
              req,
              client,
              shop,
              order,
              barcode: normalizedBarcode,
              lineItems: lineItemArray,
              explicitTag: 'wholesale_adapter_built',
              appendEventIfStageChanged: true,
              staff,
            });

            const geckoboardResult = await trySendGeckoboardEvent({
              timestamp: new Date().toISOString(),
              order_number: order.name,
              order_id: order.id,
              barcode: normalizedBarcode,
              tag: 'wholesale_adapter_built',
              staff,
            });
            if (!geckoboardResult.sent && geckoboardResult.warning) {
              console.error('Wholesale progress Geckoboard event was not sent:', geckoboardResult.warning);
            }

            const nextCount = (wholesaleAdapterBuiltScanCounts.get(normalizedBarcode) || 0) + 1;
            wholesaleAdapterBuiltScanCounts.set(normalizedBarcode, nextCount);

            sessionsStore.recordWholesaleBuildEvent({
              shop,
              barcode: normalizedBarcode,
              orderId: order.id,
              orderNumber: order.name,
              staff,
            });
          }
        }
      } catch (eventErr) {
        console.error('Failed to record wholesale_adapter_built event from wholesale progress:', eventErr);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Error in /api/wholesale-progress:', err);
    return res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

router.post('/api/pick-list', async (req, res) => {
  try {
    const { barcode } = req.body || {};
    const normalizedBarcode = normalizeScanBarcode(barcode);

    if (!normalizedBarcode) {
      return res.status(400).json({ success: false, error: 'Missing barcode' });
    }

    const shop = req.cookies.shop;
    if (!shop) {
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

    const session = sessionsStore.get(shop);
    if (!session) {
      return res.status(401).json({ success: false, error: 'No session found' });
    }

    const client = shopifyClient(session);

    const queryVariables = {
      query: buildOrderSearchQuery(normalizedBarcode),
    };

    const {
      response: orderResponse,
      bundleMetadataSupported,
      purchasingEntitySupported,
      productImagesSupported,
    } = await fetchPickListOrderResponse({
      client,
      variables: queryVariables,
      includePurchasingEntity: true,
      includeProductImages: true,
    });

    const orderEdge = selectExactOrderEdge(orderResponse.data?.orders?.edges, normalizedBarcode);
    if (!orderEdge) {
      return res.status(404).json({ success: false, error: `Order ${normalizedBarcode} not found` });
    }

    const order = orderEdge.node;
    await replaceAwaitingPartsTagWithPackaged({
      client,
      order,
    });
    const workflowBlock = getOrderWorkflowBlock(order);
    const orderLineItems = buildCurrentOrderLineItems(order.lineItems?.edges || []);
    const hpaTankShippingWarning = buildHpaTankShippingWarning({
      order,
      lineItems: orderLineItems,
    });
    const wholesaleOrderWarning = buildWholesaleOrderWarning(order);
    const currentTrackerStage = deriveTrackerStage({
      explicitTag: '',
      tags: order.tags,
      cancelledAt: order.cancelledAt,
      displayFulfillmentStatus: order.displayFulfillmentStatus,
      orderNote: order.note,
    });

    const pickListSheet = await fetchPickListSheet();
    const pickListResult = buildPickListForOrder({
      skuMap: pickListSheet.skuMap,
      lineItems: orderLineItems,
    });
    let awaitingPartsItems = sessionsStore.getOpenAwaitingPartsItemsForOrder({
      shop,
      orderId: order.id,
    });
    const awaitingPartsSkus = awaitingPartsItems.map((item) => item.partSku);
    const wholesaleProgressByItemKey = sessionsStore.getWholesaleBuildProgress({
      shop,
      barcode: normalizedBarcode,
    });
    const verifyProgressByItemKey = sessionsStore.getVerifyOrderProgress({
      shop,
      barcode: normalizedBarcode,
    });
    const pickedRowCounts = sessionsStore.getPickListPickedProgress({
      shop,
      barcode: normalizedBarcode,
    });
    const trackerInfo = await persistOrderTrackerSnapshot({
      req,
      client,
      shop,
      order,
      barcode: normalizedBarcode,
      lineItems: orderLineItems,
      explicitTag: '',
      appendEventIfStageChanged: true,
    });
    const trackerRecord = sessionsStore.getOrderTrackerByOrderId(order.id);
    const qcBuilderStaff = resolveLatestWaitingQcStaff({
      shop,
      normalizedBarcode,
      orderId: order.id,
      orderNote: order.note || '',
    });
    const qcFailReasons = sessionsStore.getQcFailReasonsForOrder({
      shop,
      barcode: normalizedBarcode,
      orderId: order.id,
      limit: 20,
    });
    const orderTimeline = buildInternalOrderTimeline({
      trackerRecord,
      orderNote: order.note || '',
    });

    return res.json({
      success: true,
      barcode: normalizedBarcode,
      orderNumber: order.name,
      orderTags: normalizeOrderTags(order.tags),
      orderStatus: order.cancelledAt ? 'CANCELLED' : (order.displayFulfillmentStatus || ''),
      orderFinancialStatus: order.displayFinancialStatus || '',
      currentStage: {
        key: currentTrackerStage.key,
        label: currentTrackerStage.label,
      },
      orderNote: order.note || '',
      orderHumanNote: stripAppOrderNoteBlocks(order.note || ''),
      orderTimeline,
      qcBuilderStaff,
      qcFailReasons,
      sheetFetchedAt: pickListSheet.fetchedAt,
      sheetSkuCount: pickListSheet.sourceRowCount,
      notesEnabled: pickListSheet.notesEnabled || false,
      notesLoaded: pickListSheet.notesLoaded || false,
      notesError: pickListSheet.notesError || null,
      bundleMetadataSupported,
      purchasingEntitySupported,
      productImagesSupported,
      workflowBlocked: Boolean(workflowBlock),
      workflowBlockCode: workflowBlock?.code || null,
      workflowStatus: workflowBlock?.status || null,
      workflowWarning: workflowBlock?.message || '',
      awaitingPartsItems,
      awaitingPartsSkus,
      trackerToken: trackerInfo.trackerToken,
      trackerUrl: trackerInfo.trackerUrl,
      wholesaleProgressByItemKey,
      verifyProgressByItemKey,
      pickedRowCounts,
      hpaTankShippingWarning,
      wholesaleOrderWarning,
      orderItems: orderLineItems,
      lineItems: pickListResult.lineItems,
      totals: pickListResult.totals,
    });
  } catch (err) {
    console.error('Error in /api/pick-list:', err);
    return res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

router.post('/api/pick-list/bag-labels/print', async (req, res) => {
  try {
    const shop = req.cookies.shop;
    if (!shop) {
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

    const session = sessionsStore.get(shop);
    if (!session) {
      return res.status(401).json({ success: false, error: 'No session found' });
    }

    const labels = Array.isArray(req.body?.labels) ? req.body.labels : [];
    const {
      pdfBuffer,
      labels: normalizedLabels,
      labelCount,
      pageSize,
      rotatedText,
    } = buildBagLabelsPdf(labels);
    const orderNumber = String(req.body?.orderNumber || req.body?.barcode || '').trim();
    console.info('[Bag labels] built PDF for PrintNode', {
      orderNumber,
      labelCount,
      pageSize,
      rotatedText,
      pdfBytes: pdfBuffer.length,
    });
    const printResult = await printBagLabelsPdf({
      orderNumber,
      pdfBuffer,
    });

    return res.json({
      success: true,
      labelCount,
      labels: normalizedLabels,
      printNodeJobId: printResult.printNodeJobId,
      printStatus: printResult.printStatus,
      printOptions: printResult.printOptions,
    });
  } catch (err) {
    console.error('Error in /api/pick-list/bag-labels/print:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to print bag labels' });
  }
});

router.post('/api/pick-list/bag-labels/pdf', async (req, res) => {
  try {
    const shop = req.cookies.shop;
    if (!shop) {
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

    const session = sessionsStore.get(shop);
    if (!session) {
      return res.status(401).json({ success: false, error: 'No session found' });
    }

    const labels = Array.isArray(req.body?.labels) ? req.body.labels : [];
    const {
      pdfBuffer,
      labelCount,
      pageSize,
      rotatedText,
    } = buildBagLabelsPdf(labels);
    const orderNumber = String(req.body?.orderNumber || req.body?.barcode || 'bag-labels')
      .trim()
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'bag-labels';
    console.info('[Bag labels] built preview PDF', {
      orderNumber,
      labelCount,
      pageSize,
      rotatedText,
      pdfBytes: pdfBuffer.length,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${orderNumber}-bag-labels.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Bag-Label-Count', String(labelCount));
    res.setHeader('X-Bag-Label-Width-Mm', String(pageSize.widthMm));
    res.setHeader('X-Bag-Label-Height-Mm', String(pageSize.heightMm));
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('Error in /api/pick-list/bag-labels/pdf:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to build bag label PDF' });
  }
});

router.get('/api/pick-list/bag-labels/printer-capabilities', async (req, res) => {
  try {
    const shop = req.cookies.shop;
    if (!shop) {
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

    const session = sessionsStore.get(shop);
    if (!session) {
      return res.status(401).json({ success: false, error: 'No session found' });
    }

    const printer = await getBagLabelPrinterCapabilities();
    const configuredMedia = String(process.env.PRINTNODE_BAG_LABEL_MEDIA || '').trim();
    const configuredPaper = String(process.env.PRINTNODE_BAG_LABEL_PAPER || '').trim();
    console.info('[PrintNode bag labels] loaded printer capabilities', {
      printerId: printer.printerId,
      name: printer.name,
      configuredMedia,
      configuredPaper,
      medias: printer.capabilities.medias,
      papers: Object.keys(printer.capabilities.papers || {}),
      bins: printer.capabilities.bins,
      dpis: printer.capabilities.dpis,
      nup: printer.capabilities.nup,
    });
    return res.json({
      success: true,
      printer,
      configuredMedia,
      configuredPaper,
    });
  } catch (err) {
    console.error('Error in /api/pick-list/bag-labels/printer-capabilities:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to load bag label printer capabilities' });
  }
});

router.get('/api/order-flow/overview', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const client = shopifyClient(auth.session);
    const overview = await buildOrderFlowOverview({
      client,
      shop: auth.shop,
      query: req.query || {},
    });

    return res.json({
      success: true,
      ...overview,
    });
  } catch (err) {
    console.error('Error in /api/order-flow/overview:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to load Monitor overview',
    });
  }
});

router.get('/api/dashboard/daily-output', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const summary = sessionsStore.getDailyOperationsSummary({
      shop: auth.shop,
      date: req.query?.date || null,
    });

    return res.json({
      success: true,
      ...summary,
    });
  } catch (err) {
    console.error('Error in /api/dashboard/daily-output:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to load dashboard output summary',
    });
  }
});

router.post('/api/order-flow/snooze', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const issueKey = String(req.body?.issueKey || '').trim();
    if (!issueKey) {
      return res.status(400).json({
        success: false,
        error: 'Missing issueKey',
      });
    }

    const snooze = sessionsStore.snoozeOrderFlowIssue({
      shop: auth.shop,
      issueKey,
      orderId: req.body?.orderId || null,
      orderNumber: req.body?.orderNumber || null,
      issueType: req.body?.type || null,
      stageKey: req.body?.stageKey || null,
      reason: req.body?.reason || null,
      snoozedBy: auth.userId,
      stack: 'snoozed',
    });

    return res.json({
      success: true,
      snooze,
    });
  } catch (err) {
    console.error('Error in /api/order-flow/snooze:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to snooze warning',
    });
  }
});

router.post('/api/order-flow/stack', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const issueKey = String(req.body?.issueKey || '').trim();
    const stack = normalizeOrderFlowExceptionStack(req.body?.stack);
    if (!issueKey) {
      return res.status(400).json({
        success: false,
        error: 'Missing issueKey',
      });
    }

    const snooze = sessionsStore.snoozeOrderFlowIssue({
      shop: auth.shop,
      issueKey,
      orderId: req.body?.orderId || null,
      orderNumber: req.body?.orderNumber || null,
      issueType: req.body?.type || null,
      stageKey: req.body?.stageKey || null,
      reason: req.body?.reason || null,
      snoozedBy: auth.userId,
      stack,
    });

    return res.json({
      success: true,
      stack,
      exception: snooze,
    });
  } catch (err) {
    console.error('Error in /api/order-flow/stack:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to move warning',
    });
  }
});

router.post('/api/order-flow/unsnooze', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const issueKey = String(req.body?.issueKey || '').trim();
    if (!issueKey) {
      return res.status(400).json({
        success: false,
        error: 'Missing issueKey',
      });
    }

    const restoredCount = sessionsStore.unsnoozeOrderFlowIssue({
      shop: auth.shop,
      issueKey,
    });

    return res.json({
      success: true,
      restoredCount,
    });
  } catch (err) {
    console.error('Error in /api/order-flow/unsnooze:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to restore warning',
    });
  }
});

router.post('/api/order-flow/delete', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res, { requireUser: true });
    if (!auth) return;

    const issueKey = String(req.body?.issueKey || '').trim();
    if (!issueKey) {
      return res.status(400).json({
        success: false,
        error: 'Missing issueKey',
      });
    }

    const deletedCount = sessionsStore.deleteOrderFlowIssue({
      shop: auth.shop,
      issueKey,
      deletedBy: auth.userId,
    });

    return res.json({
      success: true,
      deletedCount,
    });
  } catch (err) {
    console.error('Error in /api/order-flow/delete:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to delete warning',
    });
  }
});

router.get('/api/pick-list/new-order-queue', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const client = shopifyClient(auth.session);
    const queue = await listNewOrderQueueOrders({
      client,
      maxOrders: req.query?.maxOrders,
      pageSize: req.query?.pageSize,
    });
    const orders = queue.orders;

    return res.json({
      success: true,
      count: orders.length,
      orders,
      pagesFetched: queue.pagesFetched,
      hasMore: queue.hasMore,
      maxOrders: queue.maxOrders,
    });
  } catch (err) {
    console.error('Error in /api/pick-list/new-order-queue:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to load new order queue',
    });
  }
});

router.post('/api/pick-list/packing-slip/print', async (req, res) => {
  try {
    const auth = resolveAuthenticatedRequest(req, res);
    if (!auth) return;

    const normalizedBarcode = normalizeScanBarcode(req.body?.barcode);
    if (!normalizedBarcode) {
      return res.status(400).json({ success: false, error: 'Missing barcode' });
    }

    const client = shopifyClient(auth.session);
    const order = await findOrderForShipping({ client, barcode: normalizedBarcode });
    if (!order) {
      return res.status(404).json({ success: false, error: `Order ${normalizedBarcode} not found` });
    }

    const packingLabel = buildPackingOrderLabelPdf({
      orderNumber: order.name || normalizedBarcode,
      customerName: buildPackingLabelCustomerName(order),
      country: buildPackingLabelCountry(order),
    });
    const printResult = await printPackingSlipPdf({
      shop: auth.shop,
      orderNumber: packingLabel.orderNumber,
      pdfBuffer: packingLabel.pdfBuffer,
    });

    return res.json({
      success: true,
      orderNumber: packingLabel.orderNumber,
      customerName: packingLabel.customerName,
      country: packingLabel.country,
      packingSlipSource: 'generated_4x6_qr_label',
      pageSize: packingLabel.pageSize,
      printResult,
    });
  } catch (err) {
    console.error('Error in /api/pick-list/packing-slip/print:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to print packing label',
    });
  }
});

router.post('/api/pick-list-picked-progress', async (req, res) => {
  try {
    const { barcode, pickedRowCounts } = req.body || {};
    const normalizedBarcode = normalizeScanBarcode(barcode);

    if (!normalizedBarcode) {
      return res.status(400).json({ success: false, error: 'Missing barcode' });
    }

    if (!pickedRowCounts || typeof pickedRowCounts !== 'object' || Array.isArray(pickedRowCounts)) {
      return res.status(400).json({ success: false, error: 'Missing pickedRowCounts object' });
    }

    const shop = req.cookies.shop;
    if (!shop) {
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

    const session = sessionsStore.get(shop);
    if (!session) {
      return res.status(401).json({ success: false, error: 'No session found' });
    }

    sessionsStore.setPickListPickedProgress({
      shop,
      barcode: normalizedBarcode,
      pickedRowCounts,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Error in /api/pick-list-picked-progress:', err);
    return res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

router.post('/api/pick-list-verify-progress', async (req, res) => {
  try {
    const { barcode, progressByItemKey } = req.body || {};
    const normalizedBarcode = normalizeScanBarcode(barcode);

    if (!normalizedBarcode) {
      return res.status(400).json({ success: false, error: 'Missing barcode' });
    }

    if (!progressByItemKey || typeof progressByItemKey !== 'object' || Array.isArray(progressByItemKey)) {
      return res.status(400).json({ success: false, error: 'Missing progressByItemKey object' });
    }

    const shop = req.cookies.shop;
    if (!shop) {
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

    const session = sessionsStore.get(shop);
    if (!session) {
      return res.status(401).json({ success: false, error: 'No session found' });
    }

    sessionsStore.setVerifyOrderProgress({
      shop,
      barcode: normalizedBarcode,
      progressByItemKey,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Error in /api/pick-list-verify-progress:', err);
    return res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

router.post('/api/put-away-sku', async (req, res) => {
  try {
    const { sku } = req.body || {};
    const normalizedSku = normalizeSku(sku);

    if (!normalizedSku) {
      return res.status(400).json({ success: false, error: 'Missing SKU' });
    }

    const shop = req.cookies.shop;
    if (!shop) {
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

    const session = sessionsStore.get(shop);
    if (!session) {
      return res.status(401).json({ success: false, error: 'No session found' });
    }

    const pickListSheet = await fetchPickListSheet();
    const item = buildPutAwaySkuLookup({
      skuMap: pickListSheet.skuMap,
      sku: normalizedSku,
    });

    if (!item) {
      return res.status(404).json({
        success: false,
        error: `SKU ${normalizedSku} not found in pick list sheet`,
        sku: normalizedSku,
        sheetFetchedAt: pickListSheet.fetchedAt,
        sheetSkuCount: pickListSheet.sourceRowCount,
      });
    }

    return res.json({
      success: true,
      item,
      sheetFetchedAt: pickListSheet.fetchedAt,
      sheetSkuCount: pickListSheet.sourceRowCount,
      notesEnabled: pickListSheet.notesEnabled || false,
      notesLoaded: pickListSheet.notesLoaded || false,
      notesError: pickListSheet.notesError || null,
    });
  } catch (err) {
    console.error('Error in /api/put-away-sku:', err);
    return res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

router.get('/api/order-tracker/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) {
      return res.status(400).json({ success: false, error: 'Missing tracker reference' });
    }

    const normalizedOrderId = normalizeTrackerOrderId(token);
    const trackerRecord = sessionsStore.getOrderTrackerByToken(token)
      || (normalizedOrderId
        ? (sessionsStore.getOrderTrackerByOrderId(normalizedOrderId)
          || await findOrCreateTrackerRecordByOrderId({ req, orderId: normalizedOrderId }))
        : null);
    if (!trackerRecord) {
      return res.status(404).json({ success: false, error: 'Tracker not found' });
    }

    const liveTrackerRecord = await refreshTrackerRecordFromShopify({ req, trackerRecord });

    let trackingLinks = [];
    let awaitingPartsItems = [];
    let hypReceivers = [];
    let hypReceiverEvents = [];
    const currentStageKey = String(liveTrackerRecord?.currentStageKey || '').trim();
    if (currentStageKey === 'awaiting_parts') {
      awaitingPartsItems = sessionsStore.getOpenAwaitingPartsItemsForOrder({
        shop: liveTrackerRecord.shop,
        orderId: liveTrackerRecord.orderId,
      });
    }

    hypReceivers = sessionsStore.getHypReceiversForOrder({
      shop: liveTrackerRecord.shop,
      orderId: liveTrackerRecord.orderId,
      includeArchived: false,
    });
    if (hypReceivers.length > 0) {
      hypReceiverEvents = sessionsStore.getHypReceiverEventsForOrder({
        shop: liveTrackerRecord.shop,
        orderId: liveTrackerRecord.orderId,
      });
    }

    if (currentStageKey === 'fulfilled' || currentStageKey === 'partially_fulfilled') {
      const session = sessionsStore.get(liveTrackerRecord.shop);
      if (session) {
        try {
          const client = shopifyClient(session);
          trackingLinks = await fetchOrderTrackingLinks({
            client,
            orderId: liveTrackerRecord.orderId,
          });
        } catch (trackingErr) {
          console.error(`Failed to fetch tracking links for ${liveTrackerRecord.orderId}:`, trackingErr);
        }
      }
    }

    res.set('Cache-Control', 'no-store');

    return res.json({
      success: true,
      tracker: buildPublicTrackerPayload(liveTrackerRecord, {
        trackingLinks,
        awaitingPartsItems,
        hypReceivers,
        hypReceiverEvents,
      }),
    });
  } catch (err) {
    console.error('Error in /api/order-tracker/:token:', err);
    return res.status(500).json({ success: false, error: err.message || 'Server error' });
  }
});

router.get('/track/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend/public', 'order_tracker.html'));
});


module.exports = router;
