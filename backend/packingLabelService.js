const QRCode = require('qrcode');

const POINTS_PER_INCH = 72;
const LABEL_WIDTH = 4 * POINTS_PER_INCH;
const LABEL_HEIGHT = 6 * POINTS_PER_INCH;
const QR_QUIET_ZONE_MODULES = 4;

function sanitizePdfText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapePdfText(value) {
  return sanitizePdfText(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function estimateTextWidth(text, fontSize) {
  return sanitizePdfText(text).length * fontSize * 0.55;
}

function fitFontSize(text, maxWidth, maxSize, minSize) {
  for (let size = maxSize; size >= minSize; size -= 1) {
    if (estimateTextWidth(text, size) <= maxWidth) return size;
  }
  return minSize;
}

function trimToWidth(text, fontSize, maxWidth) {
  let value = sanitizePdfText(text);
  if (estimateTextWidth(value, fontSize) <= maxWidth) return value;
  while (value.length > 3 && estimateTextWidth(`${value}...`, fontSize) > maxWidth) {
    value = value.slice(0, -1).trim();
  }
  return `${value}...`;
}

function buildQrRectCommands(text, x, y, size) {
  const qr = QRCode.create(text, {
    errorCorrectionLevel: 'M',
    type: 'byte',
  });
  const matrixSize = qr.modules.size;
  const moduleCount = matrixSize + (QR_QUIET_ZONE_MODULES * 2);
  const moduleSize = size / moduleCount;
  const commands = [];

  for (let row = 0; row < matrixSize; row += 1) {
    for (let col = 0; col < matrixSize; col += 1) {
      if (!qr.modules.get(col, row)) continue;
      const rectX = x + ((col + QR_QUIET_ZONE_MODULES) * moduleSize);
      const rectY = y + ((matrixSize - 1 - row + QR_QUIET_ZONE_MODULES) * moduleSize);
      commands.push(`${rectX.toFixed(2)} ${rectY.toFixed(2)} ${moduleSize.toFixed(2)} ${moduleSize.toFixed(2)} re f`);
    }
  }

  return commands;
}

function textCommand(text, fontSize, x, y) {
  return [
    'BT',
    `/F1 ${fontSize.toFixed(2)} Tf`,
    `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`,
    `(${escapePdfText(text)}) Tj`,
    'ET',
  ].join('\n');
}

function centeredTextCommand(text, fontSize, y, maxWidth, pageWidth = LABEL_WIDTH) {
  const safeText = trimToWidth(text, fontSize, maxWidth);
  const x = Math.max(10, (pageWidth - estimateTextWidth(safeText, fontSize)) / 2);
  return textCommand(safeText, fontSize, x, y);
}

function makeStreamObject(stream) {
  const length = Buffer.byteLength(stream, 'binary');
  return `<< /Length ${length} >>\nstream\n${stream}\nendstream`;
}

function buildPdf(objects) {
  let pdf = '%PDF-1.4\n';
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'binary');
}

function buildPackingOrderLabelPdf({
  orderNumber,
  customerName = '',
  country = '',
} = {}) {
  const safeOrderNumber = sanitizePdfText(orderNumber).replace(/^#/, '').toUpperCase();
  if (!safeOrderNumber) throw new Error('Missing order number for packing label.');

  const safeCustomerName = sanitizePdfText(customerName) || 'No customer name';
  const safeCountry = sanitizePdfText(country).toUpperCase() || 'UNKNOWN COUNTRY';
  const margin = 14;
  const maxWidth = LABEL_WIDTH - (margin * 2);
  const orderFont = fitFontSize(safeOrderNumber, maxWidth, 58, 30);
  const nameFont = fitFontSize(safeCustomerName, maxWidth, 26, 15);
  const countryFont = fitFontSize(safeCountry, maxWidth, 30, 16);
  const qrSize = Math.min(LABEL_WIDTH - (margin * 2), LABEL_HEIGHT / 2);
  const qrX = (LABEL_WIDTH - qrSize) / 2;
  const qrY = LABEL_HEIGHT / 4;

  const content = [
    'q',
    '1 1 1 rg',
    `0 0 ${LABEL_WIDTH.toFixed(2)} ${LABEL_HEIGHT.toFixed(2)} re f`,
    '0 0 0 rg',
    centeredTextCommand(safeOrderNumber, orderFont, LABEL_HEIGHT - 55, maxWidth),
    ...buildQrRectCommands(safeOrderNumber, qrX, qrY, qrSize),
    centeredTextCommand(safeCustomerName, nameFont, 62, maxWidth),
    centeredTextCommand(safeCountry, countryFont, 24, maxWidth),
    'Q',
  ].join('\n');

  const objects = [];
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = '<< /Type /Pages /Kids [5 0 R] /Count 1 >>';
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
  objects[3] = makeStreamObject(content);
  objects[4] = [
    '<< /Type /Page',
    '/Parent 2 0 R',
    `/MediaBox [0 0 ${LABEL_WIDTH.toFixed(2)} ${LABEL_HEIGHT.toFixed(2)}]`,
    `/CropBox [0 0 ${LABEL_WIDTH.toFixed(2)} ${LABEL_HEIGHT.toFixed(2)}]`,
    '/Resources << /Font << /F1 3 0 R >> >>',
    '/Contents 4 0 R',
    '>>',
  ].join(' ');

  return {
    pdfBuffer: buildPdf(objects),
    orderNumber: safeOrderNumber,
    customerName: safeCustomerName,
    country: safeCountry,
    pageSize: {
      widthInches: 4,
      heightInches: 6,
    },
  };
}

module.exports = {
  buildPackingOrderLabelPdf,
};
