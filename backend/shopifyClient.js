// backend/shopifyClient.js

// 🔴 Load Node runtime adapter first
require('@shopify/shopify-api/adapters/node');

const { shopifyApi, ApiVersion, Session } = require('@shopify/shopify-api');

let shopify;

/**
 * Initialize Shopify API
 */
function initShopify() {
  shopify = shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SHOPIFY_SCOPES.split(','),
    hostName: process.env.HOST.replace(/^https?:\/\//, ''),
    apiVersion: ApiVersion.October24,
    isEmbeddedApp: false, 
    // isOnline: true // Consider defining this default here if needed
  });

  console.log('Shopify API initialized.');
}

/**
 * Returns the initialized Shopify API object
 */
function getShopify() {
  if (!shopify) throw new Error('Shopify API not initialised');
  return shopify;
}

/**
 * Returns a REST + GraphQL client for a given session
 * @param {object} sessionData - { shop, accessToken, isOnline?, id? }
 */
function shopifyClient(sessionData) {
  console.log('Creating Shopify client for session:', sessionData);

  if (!shopify) throw new Error('Shopify API not initialised');
  if (!sessionData?.shop || !sessionData?.accessToken) {
    throw new Error('Invalid session passed to shopifyClient');
  }

  // 1. Create the session object using the correct constructor signature (Object param)
  // Note: You can often just pass sessionData directly if it matches the shape, 
  // but explicitly creating the Session ensures it's valid.
  const session = new Session({
    id: sessionData.id || sessionData.shop, // unique session ID
    shop: sessionData.shop,
    accessToken: sessionData.accessToken,
    state: sessionData.state || '',
    isOnline: sessionData.isOnline || false,
  });

  // 2. ✅ FIX: Use 'new', Capitalize 'Rest'/'Graphql', and pass { session } object
  const restClient = new shopify.clients.Rest({ session });
  const graphqlClient = new shopify.clients.Graphql({ session });

  // Bind GraphQL query to REST client for convenience
  restClient.graphql = graphqlClient.request.bind(graphqlClient);

  console.log('Shopify client created successfully.');

  return restClient;
}

module.exports = { initShopify, getShopify, shopifyClient };