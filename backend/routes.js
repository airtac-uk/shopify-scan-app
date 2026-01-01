// routes.js
const express = require('express');
const router = express.Router();
const cookieParser = require('cookie-parser');
const sessionsStore = require('./sessionsStore'); // your SQLite session store
const { initShopify, shopifyClient } = require('./shopifyClient');
const fetch = require('node-fetch'); // for OAuth token exchange

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

    // Set cookie for frontend
    res.cookie('shop', shop, { httpOnly: false, sameSite: 'lax' });

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

    const session = sessionsStore.get(shop);
    if (!session) {
      return res.status(401).json({ success: false, error: 'No session found' });
    }

    const staff = session.associated_user || 'Unknown';
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
              tags
              lineItems(first: 200) {
                edges {
                  node {
                    id
                    title
                    sku
                    quantity
                    variantTitle
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

    const lineItemArray = order.lineItems.edges.map(edge => ({
      id: edge.node.id,
      title: edge.node.title,
      sku: edge.node.sku,
      quantity: edge.node.quantity,
      variantTitle: edge.node.variantTitle,
    }));

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

    console.log(`Order ${barcode} tagged with "${tag}" by ${staff}`);

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
        `🏷️ Order ${order.name} tagged "${tag}" by ${staff}`
      );

      
      if (newTag) {
        const timestamp = new Date()
          .toISOString()
          .replace('T', ' ')
          .slice(0, 16);

        var orderNoteBlock = "";

        if (tag == "racked") {
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
            `Team Member: ${staff}`,
            '',
          ].join('\n');
        } else if (tag == "packaged") {
            orderNoteBlock = [
            '~',
            `ORDER PACKAGED - AWAITING COURIER COLLECTION — ${timestamp}`,
            `Team Member: ${staff}`,
            '',
          ].join('\n');
        }

        appendOrderNote(client, order.id, orderNoteBlock)
      } else {
        console.log("Skipped as already tagged")
      }
    }
    

    return res.json({
      success: true,
      orderNumber: order.name,
      lineItems: lineItemArray,
      staff,
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
    const { orderId, skus } = req.body;

    var barcode = orderId;

    if (!barcode || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing barcode or SKUs',
      });
    }

    const shop = req.cookies.shop;
    if (!shop) {
      return res.status(401).json({ success: false, error: 'Not logged in' });
    }

    const session = sessionsStore.get(shop);
    if (!session) {
      return res.status(401).json({ success: false, error: 'No session found' });
    }

    const staff = session.associated_user|| 'Unknown';
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

    const awaitingPartsBlock = [
      '~',
      `AWAITING PARTS — ${timestamp}`,
      `Team Member: ${staff}`,
      ...skus.map(sku => `- ${sku}`),
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
          ...skus.map(sku => `, ${sku}`),
        ].join('\n')
      );
    } catch (chatErr) {
      console.error('Google Chat notification failed:', chatErr);
      // ❗ Intentionally ignored
    }

    return res.json({
      success: true,
      orderNumber: order.name,
      skus,
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


module.exports = router;