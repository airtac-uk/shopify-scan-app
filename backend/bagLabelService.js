const DEFAULT_LABEL_WIDTH_MM = 54;
const DEFAULT_LABEL_HEIGHT_MM = 25;
const POINTS_PER_MM = 72 / 25.4;
const PAGE_MARGIN = 7;
const MAX_LABELS_PER_JOB = 200;

function parsePositiveDimension(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function getBagLabelPageSize() {
  const widthMm = parsePositiveDimension(process.env.BAG_LABEL_WIDTH_MM, DEFAULT_LABEL_WIDTH_MM);
  const heightMm = parsePositiveDimension(process.env.BAG_LABEL_HEIGHT_MM, DEFAULT_LABEL_HEIGHT_MM);
  return {
    widthMm,
    heightMm,
    width: widthMm * POINTS_PER_MM,
    height: heightMm * POINTS_PER_MM,
    margin: PAGE_MARGIN,
  };
}

function parseBooleanEnv(value, defaultValue = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function shouldRotateLabelText(pageSize) {
  const explicitValue = String(process.env.BAG_LABEL_ROTATE_TEXT ?? '').trim();
  if (explicitValue) {
    return parseBooleanEnv(explicitValue);
  }

  return pageSize.height > pageSize.width;
}

function normalizeLabelQuantity(value) {
  const quantity = Math.floor(Number(value));
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.min(quantity, MAX_LABELS_PER_JOB);
}

function sanitizeLabelText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBagLabelRows(labels = []) {
  const rows = [];
  let totalQuantity = 0;

  (labels || []).forEach((label) => {
    const text = sanitizeLabelText(label?.text || label?.title || label?.label);
    const quantity = normalizeLabelQuantity(label?.quantity);
    if (!text || quantity <= 0) return;
    if (totalQuantity >= MAX_LABELS_PER_JOB) return;

    const allowedQuantity = Math.min(quantity, MAX_LABELS_PER_JOB - totalQuantity);
    rows.push({ text, quantity: allowedQuantity });
    totalQuantity += allowedQuantity;
  });

  return rows;
}

function estimateTextWidth(text, fontSize) {
  return String(text || '').length * fontSize * 0.54;
}

function wrapText(text, fontSize, maxWidth) {
  const words = sanitizeLabelText(text).split(' ').filter(Boolean);
  const lines = [];
  let current = '';

  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word;
    if (estimateTextWidth(next, fontSize) <= maxWidth || !current) {
      current = next;
      return;
    }
    lines.push(current);
    current = word;
  });

  if (current) lines.push(current);
  return lines;
}

function trimLineToWidth(text, fontSize, maxWidth) {
  let value = sanitizeLabelText(text);
  if (estimateTextWidth(value, fontSize) <= maxWidth) return value;
  while (value.length > 3 && estimateTextWidth(`${value}...`, fontSize) > maxWidth) {
    value = value.slice(0, -1).trim();
  }
  return `${value}...`;
}

function typesetLabel(text, pageSize) {
  const maxWidth = pageSize.width - (pageSize.margin * 2);
  for (let fontSize = 14; fontSize >= 8; fontSize -= 0.5) {
    const lines = wrapText(text, fontSize, maxWidth);
    if (lines.length <= 3 && lines.every((line) => estimateTextWidth(line, fontSize) <= maxWidth)) {
      return { fontSize, lines };
    }
  }

  const fontSize = 8;
  const lines = wrapText(text, fontSize, maxWidth);
  if (lines.length <= 3) {
    return { fontSize, lines };
  }

  const firstLines = lines.slice(0, 2);
  const remaining = lines.slice(2).join(' ');
  return {
    fontSize,
    lines: [
      ...firstLines,
      trimLineToWidth(remaining, fontSize, maxWidth),
    ],
  };
}

function escapePdfText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function buildLabelContentStream(text, pageSize) {
  const rotateText = shouldRotateLabelText(pageSize);
  const layoutSize = rotateText
    ? {
        ...pageSize,
        width: pageSize.height,
        height: pageSize.width,
      }
    : pageSize;
  const { fontSize, lines } = typesetLabel(text, layoutSize);
  const lineHeight = fontSize * 1.18;
  const totalHeight = lines.length * lineHeight;
  const firstBaseline = (layoutSize.height / 2) + (totalHeight / 2) - fontSize;
  const maxWidth = layoutSize.width - (layoutSize.margin * 2);

  const content = [
    'q',
    '1 1 1 rg',
    `0 0 ${pageSize.width.toFixed(2)} ${pageSize.height.toFixed(2)} re f`,
    '0 0 0 rg',
  ];

  if (rotateText) {
    content.push(`0 1 -1 0 ${pageSize.width.toFixed(2)} 0 cm`);
  }

  content.push('BT', `/F1 ${fontSize.toFixed(2)} Tf`);

  lines.forEach((line, index) => {
    const safeLine = trimLineToWidth(line, fontSize, maxWidth);
    const x = Math.max(layoutSize.margin, (layoutSize.width - estimateTextWidth(safeLine, fontSize)) / 2);
    const y = firstBaseline - (index * lineHeight);
    content.push(`1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdfText(safeLine)}) Tj`);
  });

  content.push('ET', 'Q');
  return content.join('\n');
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

function buildBagLabelsPdf(labels = []) {
  const rows = normalizeBagLabelRows(labels);
  if (!rows.length) {
    throw new Error('No bag labels to print.');
  }

  const pages = [];
  const pageSize = getBagLabelPageSize();
  rows.forEach((row) => {
    for (let index = 0; index < row.quantity; index += 1) {
      pages.push(row.text);
    }
  });

  const objects = [];
  const rotatedText = shouldRotateLabelText(pageSize);
  objects[0] = '';
  objects[1] = '';
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';

  const pageObjectIds = [];
  pages.forEach((labelText) => {
    const contentObjectId = objects.length + 1;
    objects.push(makeStreamObject(buildLabelContentStream(labelText, pageSize)));
    const pageObjectId = objects.length + 1;
    pageObjectIds.push(pageObjectId);
    objects.push([
      '<< /Type /Page',
      '/Parent 2 0 R',
      `/MediaBox [0 0 ${pageSize.width.toFixed(2)} ${pageSize.height.toFixed(2)}]`,
      `/CropBox [0 0 ${pageSize.width.toFixed(2)} ${pageSize.height.toFixed(2)}]`,
      '/Resources << /Font << /F1 3 0 R >> >>',
      `/Contents ${contentObjectId} 0 R`,
      '>>',
    ].join(' '));
  });

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`;

  return {
    pdfBuffer: buildPdf(objects),
    labels: rows,
    labelCount: pages.length,
    pageSize: {
      widthMm: pageSize.widthMm,
      heightMm: pageSize.heightMm,
    },
    rotatedText,
  };
}

module.exports = {
  buildBagLabelsPdf,
  getBagLabelPageSize,
  normalizeBagLabelRows,
};
