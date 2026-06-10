const crypto = require('crypto');
const fetch = require('node-fetch');

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getPrintNodeConfig({ printerIdEnv = 'PRINTNODE_PRINTER_ID' } = {}) {
  const apiKey = String(process.env.PRINTNODE_API_KEY || '').trim();
  const printerId = Number(process.env[printerIdEnv]);
  const baseUrl = trimTrailingSlash(process.env.PRINTNODE_API_BASE_URL || 'https://api.printnode.com');

  if (!apiKey) {
    throw new Error('PRINTNODE_API_KEY is not configured.');
  }

  if (!Number.isInteger(printerId) || printerId <= 0) {
    throw new Error(`${printerIdEnv} is not configured.`);
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

function parseBooleanEnv(value, defaultValue = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function getBagLabelPrintOptions() {
  const options = {};
  const media = String(process.env.PRINTNODE_BAG_LABEL_MEDIA || '').trim();
  const paper = String(process.env.PRINTNODE_BAG_LABEL_PAPER || '').trim();
  const bin = String(process.env.PRINTNODE_BAG_LABEL_BIN || '').trim();
  const dpi = String(process.env.PRINTNODE_BAG_LABEL_DPI || '').trim();
  const rotate = Number(process.env.PRINTNODE_BAG_LABEL_ROTATE);
  const nup = Number(process.env.PRINTNODE_BAG_LABEL_NUP);

  if (media) options.media = media;
  if (paper) options.paper = paper;
  if (bin) options.bin = bin;
  if (dpi) options.dpi = dpi;
  if ([0, 90, 180, 270].includes(rotate)) options.rotate = rotate;
  if (Number.isInteger(nup) && nup > 0) options.nup = nup;
  if (parseBooleanEnv(process.env.PRINTNODE_BAG_LABEL_FIT_TO_PAGE, true)) {
    options.fit_to_page = true;
  }

  return options;
}

async function getBagLabelPrinterCapabilities() {
  const { apiKey, printerId, baseUrl } = getPrintNodeConfig({
    printerIdEnv: 'PRINTNODE_BAG_LABEL_PRINTER_ID',
  });

  const response = await fetch(`${baseUrl}/printers/${printerId}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
    },
  });

  const text = await response.text();
  const data = text ? safeJsonParse(text) : null;
  if (!response.ok) {
    const message = data?.message || data?.error || text || response.statusText;
    throw new Error(`PrintNode printer capability error ${response.status}: ${message}`);
  }

  const printer = Array.isArray(data) ? data[0] : data;
  const capabilities = printer?.capabilities || {};
  return {
    printerId,
    name: String(printer?.name || printer?.description || '').trim(),
    capabilities: {
      bins: Array.isArray(capabilities.bins) ? capabilities.bins : [],
      dpis: Array.isArray(capabilities.dpis) ? capabilities.dpis : [],
      medias: Array.isArray(capabilities.medias) ? capabilities.medias : [],
      papers: capabilities.papers && typeof capabilities.papers === 'object' ? capabilities.papers : {},
      nup: Array.isArray(capabilities.nup) ? capabilities.nup : [],
      extent: Array.isArray(capabilities.extent) ? capabilities.extent : [],
      copies: capabilities.copies || null,
      color: Boolean(capabilities.color),
    },
  };
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
  useIdempotency = true,
} = {}) {
  const { apiKey, printerId, baseUrl } = getPrintNodeConfig();
  const normalizedLabelId = String(labelId || '').trim();
  if (!normalizedLabelId) throw new Error('Missing label id for PrintNode print job.');
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error('Missing PDF data for PrintNode print job.');
  }

  const idempotencyKey = useIdempotency
    ? buildPrintNodeIdempotencyKey({ shop, labelId: normalizedLabelId, printerId })
    : '';
  const response = await fetch(`${baseUrl}/printjobs`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
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

async function printPackingSlipPdf({
  shop,
  orderNumber = '',
  shipmentId = '',
  pdfBuffer,
  useIdempotency = false,
} = {}) {
  const printerIdEnv = String(process.env.PRINTNODE_PACKING_SLIP_PRINTER_ID || '').trim()
    ? 'PRINTNODE_PACKING_SLIP_PRINTER_ID'
    : 'PRINTNODE_PRINTER_ID';
  const { apiKey, printerId, baseUrl } = getPrintNodeConfig({ printerIdEnv });
  const normalizedOrderNumber = String(orderNumber || '').trim();
  const normalizedShipmentId = String(shipmentId || '').trim();
  if (!normalizedOrderNumber && !normalizedShipmentId) {
    throw new Error('Missing order number or shipment id for packing label print job.');
  }
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error('Missing PDF data for packing label print job.');
  }

  const idempotencyKey = useIdempotency
    ? buildPrintNodeIdempotencyKey({
        shop,
        labelId: `packing-slip:${normalizedOrderNumber}:${normalizedShipmentId}`,
        printerId,
      })
    : '';
  const title = `Packing label ${normalizedOrderNumber || normalizedShipmentId}`;
  const response = await fetch(`${baseUrl}/printjobs`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify({
      printerId,
      title,
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

async function printBagLabelsPdf({
  orderNumber = '',
  pdfBuffer,
} = {}) {
  const { apiKey, printerId, baseUrl } = getPrintNodeConfig({
    printerIdEnv: 'PRINTNODE_BAG_LABEL_PRINTER_ID',
  });
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error('Missing PDF data for bag label print job.');
  }
  const options = getBagLabelPrintOptions();
  const title = `Bag labels ${orderNumber || new Date().toISOString()}`;

  console.info('[PrintNode bag labels] submitting print job', {
    printerId,
    title,
    pdfBytes: pdfBuffer.length,
    options,
  });

  const response = await fetch(`${baseUrl}/printjobs`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      printerId,
      title,
      contentType: 'pdf_base64',
      content: pdfBuffer.toString('base64'),
      source: 'shopify-scan-app',
      ...(Object.keys(options).length ? { options } : {}),
    }),
  });

  const text = await response.text();
  const data = text ? safeJsonParse(text) : null;

  if (!response.ok) {
    const message = data?.message || data?.error || text || response.statusText;
    console.warn('[PrintNode bag labels] print job failed', {
      printerId,
      status: response.status,
      message,
      options,
    });
    throw new Error(`PrintNode error ${response.status}: ${message}`);
  }

  const printNodeJobId = typeof data === 'number' || typeof data === 'string'
    ? String(data)
    : String(data?.id || data?.printJobId || '');

  console.info('[PrintNode bag labels] print job accepted', {
    printerId,
    printNodeJobId,
    options,
  });

  return {
    printNodeJobId,
    printStatus: 'submitted',
    printOptions: options,
    raw: data || text,
  };
}

module.exports = {
  getBagLabelPrinterCapabilities,
  printBagLabelsPdf,
  printPackingSlipPdf,
  printPdfLabel,
};
