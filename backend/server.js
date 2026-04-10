require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { initShopify } = require('./shopifyClient');

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
