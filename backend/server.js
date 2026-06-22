require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { initShopify } = require('./shopifyClient');
const sessionsStore = require('./sessionsStore');

console.log('Starting backend bootstrap...');
const app = express();

// Initialize Shopify
initShopify();
const routes = require('./routes');

// Middleware
app.use(cookieParser());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = Buffer.from(buf);
  },
}));

const protectedEmployeePages = new Set([
  '/scan.html',
  '/scan_usb.html',
  '/scan_photo.html',
  '/pick_list.html',
  '/dashboard.html',
  '/order_flow.html',
  '/putting_away.html',
  '/awaiting_parts.html',
  '/print_queue.html',
  '/fdm_print_queue.html',
  '/print_config.html',
]);

function isAuthenticatedPageRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  return protectedEmployeePages.has(String(req.path || '').toLowerCase());
}

function buildLoginRedirect(req) {
  const returnTo = req.originalUrl && req.originalUrl.startsWith('/')
    ? req.originalUrl
    : '/scan.html';
  return `/?returnTo=${encodeURIComponent(returnTo)}`;
}

app.use((req, res, next) => {
  if (!isAuthenticatedPageRequest(req)) {
    next();
    return;
  }

  const shop = String(req.cookies?.shop || '').trim();
  if (!shop || !sessionsStore.get(shop)) {
    res.redirect(buildLoginRedirect(req));
    return;
  }

  next();
});

app.use(express.static(path.join(__dirname, '..', 'frontend/public')));

// Use routes
app.use(routes); // <-- correct

// Fallback: serve index.html for frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend/public', 'index.html'));
});

// Start server
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
