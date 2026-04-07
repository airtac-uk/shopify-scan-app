// routes.js
const express = require('express');
const router = express.Router();
const path = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const sessionsStore = require('./sessionsStore'); // your SQLite session store
const { initShopify, shopifyClient } = require('./shopifyClient');
const fetch = require('node-fetch'); // for OAuth token exchange
const {
  fetchPickListSheet,
  buildPickListForOrder,
  normalizeSku,
  normalizePickType,
  getWaitingPartsTypeGroup,
} = require('./pickListService');
const {
  deriveTrackerStage,
  extractTrackerEventsFromOrderNote,
  extractLatestAwaitingPartsSnapshot,
  normalizeTrackerLineItems,
  buildPublicTrackerPayload,
  buildInternalOrderTimeline,
} = require('./orderTrackerService');

router.use(cookieParser());

// Initialize Shopify API once
initShopify();

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


// ---------------------
// 1️⃣ /auth - start OAuth
// ---------------------
router.get('/auth', async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).send('Missing shop parameter');

    console.log('Starting OAuth for shop:', shop);

    // Build Shopify OAuth URL manually
    const scopes = process.env.SHOPIFY_SCOPES.split(',').join(',');
    const redirectUri = `${process.env.HOST}/auth/callback`;
    const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${redirectUri}&state=nonce&grant_options[]=per-user`;

    console.log('Redirecting to Shopify auth URL:', installUrl);
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

    // Store session in SQLite
    sessionsStore.set(shop, { shop, accessToken, isOnline: false, associated_user: data.associated_user.first_name });

    try {
      const client = shopifyClient({ shop, accessToken, isOnline: false });
      await ensureOrdersCreateWebhookSubscription({ client, shop, req });
    } catch (webhookErr) {
      console.error(`Failed to ensure orders/create webhook for ${shop}:`, webhookErr);
    }

    // Set cookie for frontend
    res.cookie('shop', shop, { httpOnly: false, sameSite: 'lax' });
    res.cookie('userId', data.associated_user.first_name, { httpOnly: false, sameSite: 'lax' });


    console.log('Session stored successfully, redirecting to scan page');
    res.redirect('/scan.html');

  } catch (err) {
    console.error('Error in /auth/callback:', err);
    res.status(500).send('OAuth failed');
  }
});

router.get('/api/auth/status', async (req, res) => {

  const shop = req.cookies.shop;
  if (!shop) 
    {
      console.log("Cookie has no shop")
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

  const session = sessionsStore.get(shop);
  if (!session) {
    console.log("Cookie has no session")
    return res.status(401).json({ success: false, error: 'No session found' });
  }

  try {
    const client = shopifyClient(session);
    await ensureOrdersCreateWebhookSubscription({ client, shop, req });
  } catch (webhookErr) {
    console.error(`Failed to ensure orders/create webhook for ${shop}:`, webhookErr);
  }


  res.json({ authenticated: true, shop: req.cookies.shop });
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

let geckoboardDatasetChecked = false;
const wholesaleAdapterBuiltScanCounts = new Map();
const webhookRegistrationCheckedShops = new Set();
const awaitingPartsSyncPromises = new Map();
const BLOCKED_FULFILLMENT_STATUSES = new Set(['FULFILLED', 'PARTIALLY_FULFILLED', 'RESTOCKED']);
const ORDER_WORKFLOW_STATUS_FIELDS = `
              displayFulfillmentStatus
              cancelledAt
              cancelReason
`;
const TRACKER_METAFIELD_NAMESPACE = String(process.env.SHOPIFY_TRACKER_METAFIELD_NAMESPACE || 'airtac').trim();
const TRACKER_METAFIELD_KEY = String(process.env.SHOPIFY_TRACKER_METAFIELD_KEY || 'tracker_token').trim();
const ORDER_TRACKER_METAFIELD_FIELD = `
              trackerTokenMetafield: metafield(namespace: "${TRACKER_METAFIELD_NAMESPACE}", key: "${TRACKER_METAFIELD_KEY}") {
                value
              }
`;

function normalizeScanBarcode(barcode) {
  return normalizeSku(barcode);
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

      const bundleGroup = node.lineItemGroup
        ? {
            id: String(node.lineItemGroup.id || '').trim(),
            title: String(node.lineItemGroup.title || '').trim(),
            quantity: Number(node.lineItemGroup.quantity) || null,
          }
        : null;

      return {
        id: node.id || `ORDER_LINE_${index + 1}`,
        title: node.title || '',
        sku: node.sku || '',
        quantity,
        variantTitle: node.variantTitle || '',
        upc: node.variant?.barcode || '',
        bundleGroup,
      };
    })
    .filter(Boolean);
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
        lineItems(first: 200) {
          edges {
            node {
              id
              title
              sku
              quantity
              currentQuantity
              variantTitle
              variant {
                barcode
              }
            }
          }
        }
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

    edges.forEach((edge) => {
      const order = edge?.node;
      if (!order?.id) return;

      stats.scannedOrderCount += 1;

      const trackerStage = deriveTrackerStage({
        explicitTag: '',
        tags: order.tags,
        cancelledAt: order.cancelledAt,
        displayFulfillmentStatus: order.displayFulfillmentStatus,
        orderNote: order.note,
      });

      if (trackerStage.key !== 'awaiting_parts') {
        const resolvedCount = sessionsStore.resolveAwaitingPartsForOrder({
          shop,
          orderId: order.id,
          resolvedAt: nowIso,
        });
        if (resolvedCount > 0) {
          stats.resolvedOrderCount += 1;
        }
        return;
      }

      stats.awaitingPartsOrderCount += 1;

      const latestAwaitingPartsSnapshot = extractLatestAwaitingPartsSnapshot(order.note || '');
      if (!latestAwaitingPartsSnapshot?.skus?.length) {
        stats.skippedAwaitingPartsOrderCount += 1;
        return;
      }

      const typedItems = buildTypedAwaitingPartsItems({
        items: latestAwaitingPartsSnapshot.items,
        skus: latestAwaitingPartsSnapshot.skus,
        skuMap,
      });
      if (!typedItems.length) {
        stats.skippedAwaitingPartsOrderCount += 1;
        return;
      }

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
    });

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
  });

  if (trackerStage.key !== 'awaiting_parts') {
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

function includesMissingBundleFieldError(err) {
  const raw = String(err?.message || '').toLowerCase();
  if (!raw.includes('lineitemgroup')) return false;
  return raw.includes('cannot query field') || raw.includes("doesn't exist");
}

function getPickListOrderQuery({ includeBundleGroup }) {
  return `
      query getOrderForPickList($query: String!) {
        orders(first: 1, query: $query) {
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
                    variantTitle
                    variant {
                      barcode
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
    const { barcode, tag } = req.body;
    if (!barcode || !tag) {
      return res.status(400).json({ success: false, error: 'Missing barcode or tag' });
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
    const normalizedBarcode = normalizeScanBarcode(barcode);
    const latestWaitingQcStaff = tag == "qc_fail"
      ? sessionsStore.getLatestWaitingQcStaffByBarcode(normalizedBarcode)
      : null;
    const attributedStaff = tag == "qc_fail"
      ? (latestWaitingQcStaff || staff)
      : staff;
    const client = shopifyClient(session);

    console.log(`Looking up order ${barcode} for shop ${shop}`);

    // --------------------------------------------------
    // 1️⃣ Find order (GraphQL)
    // --------------------------------------------------
    const query = `
      query getOrder($query: String!) {
        orders(first: 1, query: $query) {
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
                    variantTitle
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
        query: `${barcode} status:any`,
      },
    });

    const orderEdge = response.data?.orders?.edges?.[0];
    if (!orderEdge) {
      return res.json({ success: false, error: `Order ${barcode} not found` });
    }

    const order = orderEdge.node;
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
       await sendGoogleChatMessage(
        process.env.GCHAT_ALL_ACTIVITY_WEBHOOK_URL,
        `🏷️ Order ${order.name} tagged "${tag}" by ${attributedStaff}`
      );

      
      if (newTag || tag == "wholesale_adapter_built") {
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
        }

        appendOrderNote(client, order.id, orderNoteBlock)
    } else {
      console.log("Skipped as already tagged")
    }
    }
    
    try {
      await sendGeckoboardEvent({
        timestamp: new Date().toISOString(),
        order_number: order.name,
        order_id: order.id,
        barcode,
        tag,
        staff: attributedStaff,
      });
    } catch (geckoboardErr) {
      console.error('Geckoboard event send failed:', geckoboardErr);
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
    });

    let wholesaleAdapterBuiltCount = null;
    if (tag == "wholesale_adapter_built") {
      const nextCount = (wholesaleAdapterBuiltScanCounts.get(normalizedBarcode) || 0) + 1;
      wholesaleAdapterBuiltScanCounts.set(normalizedBarcode, nextCount);
      wholesaleAdapterBuiltCount = nextCount;
    }

    return res.json({
      success: true,
      orderNumber: order.name,
      lineItems: lineItemArray,
      staff: attributedStaff,
      wholesaleAdapterBuiltCount,
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
    const requestedItems = Array.isArray(items) && items.length > 0
      ? items
      : (Array.isArray(skus) ? skus.map((sku) => ({ sku, quantity: 1 })) : []);

    if (!barcode || !requestedItems.length) {
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
        orders(first: 1, query: $query) {
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
        query: `${barcode} status:any`,
      },
    });

    const orderEdge = findRes.data?.orders?.edges?.[0];
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

    if (!normalizedAwaitingPartsItems.length) {
      return res.status(400).json({
        success: false,
        error: 'No valid awaiting-parts items selected',
      });
    }

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
      mutation updateOrderNote($id: ID!, $note: String) {
        orderUpdate(input: { id: $id, note: $note }) {
          userErrors {
            field
            message
          }
        }
      }
    `;

    const updateRes = await client.graphql(updateNoteMutation, {
      variables: {
        id: order.id,
        note: updatedNote,
      },
    });

    if (updateRes.data?.orderUpdate?.userErrors?.length) {
      console.error(updateRes.data.orderUpdate.userErrors);
      return res.status(500).json({
        success: false,
        error: 'Failed to update order note',
      });
    }

    let typedAwaitingPartsItems = normalizedAwaitingPartsItems.map((item) => ({
      partSku: normalizeSku(item.sku),
      partTypeRaw: 'UNKNOWN',
      partTypeGroup: 'UNKNOWN',
      quantity: Math.max(1, Number(item.quantity) || 1),
    }));

    try {
      const pickListSheet = await fetchPickListSheet();
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
    }

    sessionsStore.upsertAwaitingPartsItems({
      shop,
      orderId: order.id,
      orderNumber: order.name,
      reportedBy: staff,
      items: typedAwaitingPartsItems,
      createdAt: new Date().toISOString(),
    });

    // --------------------------------------------------
    // 4️⃣ Notify Google Chat (non-blocking)
    // --------------------------------------------------
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

    return res.json({
      success: true,
      orderNumber: order.name,
      skus: normalizedAwaitingPartsItems.map((item) => item.sku),
      awaitingPartsSelection: normalizedAwaitingPartsItems,
      awaitingPartsItems: typedAwaitingPartsItems,
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
    const shouldSyncFromNotes = String(req.query.sync || '').trim() === '1';
    let syncStats = null;
    let syncError = null;

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
    const latestWaitingQcStaff = sessionsStore.getLatestWaitingQcStaffByBarcode(normalizedBarcode);
    const client = shopifyClient(session);

    const findOrderQuery = `
      query findOrder($query: String!) {
        orders(first: 1, query: $query) {
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
        query: `${barcode} status:any`,
      },
    });

    const orderEdge = findRes.data?.orders?.edges?.[0];
    if (!orderEdge) {
      return res.status(404).json({
        success: false,
        error: `Order ${barcode} not found`,
      });
    }

    const order = orderEdge.node;

    const timestamp = new Date()
      .toISOString()
      .replace('T', ' ')
      .slice(0, 16);

    const qcFailBlock = [
      '~',
      `QC FAIL — ${timestamp}`,
      `Team Member: ${staff}`,
      `SKU: ${sku}`,
      `Reason: ${String(reason).trim()}`,
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

    try {
      await sendGoogleChatMessage(
        process.env.GCHAT_QC_FAIL_URL,
        [
          `QC fail reported for order ${order.name}`,
          `Reported by: ${staff}`,
          `Built by: ${latestWaitingQcStaff || 'No waiting_qc record found'}`,
          `SKU: ${sku}`,
          `Reason: ${String(reason).trim()}`,
        ].join('\n')
      );
    } catch (chatErr) {
      console.error('Google Chat notification failed:', chatErr);
    }

    return res.json({
      success: true,
      orderNumber: order.name,
      sku,
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

    sessionsStore.setWholesaleBuildProgress({
      shop,
      barcode: normalizedBarcode,
      progressByItemKey,
    });

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

    const orderEdge = orderResponse.data?.orders?.edges?.[0];
    if (!orderEdge) {
      return res.status(404).json({ success: false, error: `Order ${normalizedBarcode} not found` });
    }

    const order = orderEdge.node;
    const workflowBlock = getOrderWorkflowBlock(order);
    const orderLineItems = buildCurrentOrderLineItems(order.lineItems?.edges || []);

    const pickListSheet = await fetchPickListSheet();
    const pickListResult = buildPickListForOrder({
      skuMap: pickListSheet.skuMap,
      lineItems: orderLineItems,
    });
    let awaitingPartsItems = sessionsStore.getOpenAwaitingPartsItemsForOrder({
      shop,
      orderId: order.id,
    });
    if (!awaitingPartsItems.length) {
      const trackerStage = deriveTrackerStage({
        explicitTag: '',
        tags: order.tags,
        cancelledAt: order.cancelledAt,
        displayFulfillmentStatus: order.displayFulfillmentStatus,
        orderNote: order.note,
      });

      if (trackerStage.key === 'awaiting_parts') {
        const latestAwaitingPartsSnapshot = extractLatestAwaitingPartsSnapshot(order.note || '');
        awaitingPartsItems = Array.isArray(latestAwaitingPartsSnapshot?.items)
          ? latestAwaitingPartsSnapshot.items.map((item) => ({
              partSku: normalizeSku(item?.sku),
              quantity: Math.max(1, Number(item?.quantity) || 1),
            })).filter((item) => item.partSku)
          : [];
      }
    }
    const awaitingPartsSkus = awaitingPartsItems.map((item) => item.partSku);
    const wholesaleProgressByItemKey = sessionsStore.getWholesaleBuildProgress({
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
    const orderTimeline = buildInternalOrderTimeline({
      trackerRecord,
      orderNote: order.note || '',
    });

    return res.json({
      success: true,
      barcode: normalizedBarcode,
      orderNumber: order.name,
      orderNote: order.note || '',
      orderTimeline,
      sheetFetchedAt: pickListSheet.fetchedAt,
      sheetSkuCount: pickListSheet.sourceRowCount,
      notesEnabled: pickListSheet.notesEnabled || false,
      notesLoaded: pickListSheet.notesLoaded || false,
      notesError: pickListSheet.notesError || null,
      bundleMetadataSupported,
      workflowBlocked: Boolean(workflowBlock),
      workflowBlockCode: workflowBlock?.code || null,
      workflowStatus: workflowBlock?.status || null,
      workflowWarning: workflowBlock?.message || '',
      awaitingPartsItems,
      awaitingPartsSkus,
      trackerToken: trackerInfo.trackerToken,
      trackerUrl: trackerInfo.trackerUrl,
      wholesaleProgressByItemKey,
      orderItems: orderLineItems,
      lineItems: pickListResult.lineItems,
      totals: pickListResult.totals,
    });
  } catch (err) {
    console.error('Error in /api/pick-list:', err);
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
    const currentStageKey = String(liveTrackerRecord?.currentStageKey || '').trim();
    if (currentStageKey === 'awaiting_parts') {
      awaitingPartsItems = sessionsStore.getOpenAwaitingPartsItemsForOrder({
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
