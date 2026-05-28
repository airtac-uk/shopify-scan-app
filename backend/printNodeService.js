const crypto = require('crypto');
const fetch = require('node-fetch');

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getPrintNodeConfig() {
  const apiKey = String(process.env.PRINTNODE_API_KEY || '').trim();
  const printerId = Number(process.env.PRINTNODE_PRINTER_ID);
  const baseUrl = trimTrailingSlash(process.env.PRINTNODE_API_BASE_URL || 'https://api.printnode.com');

  if (!apiKey) {
    throw new Error('PRINTNODE_API_KEY is not configured.');
  }

  if (!Number.isInteger(printerId) || printerId <= 0) {
    throw new Error('PRINTNODE_PRINTER_ID is not configured.');
  }

  return { apiKey, printerId, baseUrl };
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

function buildPrintNodeIdempotencyKey({ shop, labelId, printerId }) {
  return crypto
    .createHash('sha256')
    .update([shop, labelId, printerId].map((value) => String(value || '').trim()).join('|'))
    .digest('hex')
    .slice(0, 48);
}

async function printPdfLabel({
  shop,
  labelId,
  orderNumber = '',
  pdfBuffer,
} = {}) {
  const { apiKey, printerId, baseUrl } = getPrintNodeConfig();
  const normalizedLabelId = String(labelId || '').trim();
  if (!normalizedLabelId) throw new Error('Missing label id for PrintNode print job.');
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error('Missing PDF data for PrintNode print job.');
  }

  const idempotencyKey = buildPrintNodeIdempotencyKey({ shop, labelId: normalizedLabelId, printerId });
  const response = await fetch(`${baseUrl}/printjobs`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      printerId,
      title: `ShipStation label ${orderNumber || normalizedLabelId}`,
      contentType: 'pdf_base64',
      content: pdfBuffer.toString('base64'),
      source: 'shopify-scan-app',
    }),
  });

  const text = await response.text();
  const data = text ? safeJsonParse(text) : null;

  if (response.status === 409) {
    return {
      printNodeJobId: null,
      printStatus: 'already_submitted',
      idempotencyKey,
      raw: data || text,
    };
  }

  if (!response.ok) {
    const message = data?.message || data?.error || text || response.statusText;
    throw new Error(`PrintNode error ${response.status}: ${message}`);
  }

  return {
    printNodeJobId: typeof data === 'number' || typeof data === 'string'
      ? String(data)
      : String(data?.id || data?.printJobId || ''),
    printStatus: 'submitted',
    idempotencyKey,
    raw: data || text,
  };
}

module.exports = {
  printPdfLabel,
};
