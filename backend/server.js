require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { initShopify } = require('./shopifyClient');
const routes = require('./routes'); // <-- no () at the end

const app = express();

// Initialize Shopify
initShopify();

// Middleware
app.use(cookieParser());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend/public')));

// Use routes
app.use(routes); // <-- correct

// Fallback: serve index.html for frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend/public', 'index.html'));
});

// Start server
app.listen(3000, () => console.log('Server running on 3000'));