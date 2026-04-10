// backend/shopifyClient.js

let shopify;
let shopifyApiFactory = null;
let shopifyApiVersion = null;
let ShopifySession = null;
let shopifyModuleLoaded = false;

function ensureShopifyModuleLoaded() {
  if (shopifyApiFactory && shopifyApiVersion && ShopifySession) {
    return;
  }

  if (!shopifyModuleLoaded) {
    console.log('Loading Shopify API module...');
    shopifyModuleLoaded = true;
  }

  require('@shopify/shopify-api/adapters/node');
  const shopifyApiPackage = require('@shopify/shopify-api');

  shopifyApiFactory = shopifyApiPackage.shopifyApi;
  shopifyApiVersion = shopifyApiPackage.ApiVersion;
  ShopifySession = shopifyApiPackage.Session;
  console.log('Shopify API module loaded.');
}

/**
 * Initialize Shopify API
 */
function initShopify() {
  if (shopify) {
    return shopify;
  }

  ensureShopifyModuleLoaded();

  const scopes = String(process.env.SHOPIFY_SCOPES || '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  const hostName = String(process.env.HOST || '').replace(/^https?:\/\//, '');

  shopify = shopifyApiFactory({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes,
    hostName,
    apiVersion: shopifyApiVersion.October24,
    isEmbeddedApp: false,
    // isOnline: true // Consider defining this default here if needed
  });

  console.log('Shopify API initialized.');
  return shopify;
}

/**
 * Returns the initialized Shopify API object
 */
function getShopify() {
  return shopify || initShopify();
}

/**
 * Returns a REST + GraphQL client for a given session
 * @param {object} sessionData - { shop, accessToken, isOnline?, id? }
 */
function shopifyClient(sessionData) {
  console.log('Creating Shopify client for session:', sessionData);

  const shopifyApiInstance = getShopify();
  if (!sessionData?.shop || !sessionData?.accessToken) {
    throw new Error('Invalid session passed to shopifyClient');
  }

  // 1. Create the session object using the correct constructor signature (Object param)
  // Note: You can often just pass sessionData directly if it matches the shape, 
  // but explicitly creating the Session ensures it's valid.
  const session = new ShopifySession({
    id: sessionData.id || sessionData.shop, // unique session ID
    shop: sessionData.shop,
    accessToken: sessionData.accessToken,
    state: sessionData.state || '',
    isOnline: sessionData.isOnline || false,
  });

  // 2. ✅ FIX: Use 'new', Capitalize 'Rest'/'Graphql', and pass { session } object
  const restClient = new shopifyApiInstance.clients.Rest({ session });
  const graphqlClient = new shopifyApiInstance.clients.Graphql({ session });

  // Bind GraphQL query to REST client for convenience
  restClient.graphql = graphqlClient.request.bind(graphqlClient);

  console.log('Shopify client created successfully.');

  return restClient;
}

module.exports = { initShopify, getShopify, shopifyClient };
