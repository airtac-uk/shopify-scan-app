const fetch = require('node-fetch');

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getShipStationConfig() {
  const apiKey = String(process.env.SHIPSTATION_API_KEY || '').trim();
  const baseUrl = trimTrailingSlash(process.env.SHIPSTATION_API_BASE_URL || 'https://api.shipstation.com');

  if (!apiKey) {
    throw new Error('SHIPSTATION_API_KEY is not configured.');
  }

  return { apiKey, baseUrl };
}

function buildShipStationUrl(pathOrUrl, query = null) {
  const { baseUrl } = getShipStationConfig();
  const rawPath = String(pathOrUrl || '').trim();
  const isAbsolute = /^https?:\/\//i.test(rawPath);
  const baseEndsWithV2 = /\/v2$/i.test(baseUrl);
  const path = baseEndsWithV2 && rawPath.startsWith('/v2/')
    ? rawPath.slice(3)
    : rawPath;
  const url = new URL(isAbsolute ? rawPath : `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`);

  if (query && typeof query === 'object') {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null || String(value).trim() === '') return;
      url.searchParams.set(key, String(value));
    });
  }

  return url.toString();
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

async function shipStationRequest(pathOrUrl, {
  method = 'GET',
  query = null,
  body = undefined,
  headers = {},
  raw = false,
} = {}) {
  const { apiKey } = getShipStationConfig();
  const url = buildShipStationUrl(pathOrUrl, query);
  const requestHeaders = {
    'api-key': apiKey,
    Accept: raw ? 'application/pdf,application/octet-stream,*/*' : 'application/json',
    ...headers,
  };

  const options = {
    method,
    headers: requestHeaders,
  };

  if (body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  if (raw) {
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ShipStation error ${response.status}: ${text || response.statusText}`);
    }
    return {
      buffer: await response.buffer(),
      contentType: response.headers.get('content-type') || 'application/pdf',
    };
  }

  const text = await response.text();
  const data = text ? (safeJsonParse(text) || { raw: text }) : {};

  if (!response.ok) {
    const message = data?.message || data?.error || data?.errors?.[0]?.message || text || response.statusText;
    throw new Error(`ShipStation error ${response.status}: ${message}`);
  }

  return data;
}

function normalizeId(value) {
  return String(value || '').trim();
}

function normalizeCompare(value) {
  return normalizeId(value)
    .replace(/^#/, '')
    .toUpperCase();
}

function buildOrderLookupIdentifiers(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [values])
    .map((value) => normalizeId(value))
    .map((value) => value.replace(/^#/, ''))
    .filter(Boolean)));
}

function valueMatchesAnyIdentifier(value, identifiers) {
  const normalizedValue = normalizeCompare(value);
  if (!normalizedValue) return false;
  return identifiers.some((identifier) => normalizeCompare(identifier) === normalizedValue);
}

function extractShipments(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.shipments)) return payload.shipments;
  if (Array.isArray(payload?.data)) return payload.data;
  if (payload?.shipment_id || payload?.shipmentId) return [payload];
  return [];
}

function normalizeAddress(address) {
  if (!address || typeof address !== 'object') return null;
  return {
    name: normalizeId(address.name),
    companyName: normalizeId(address.company_name || address.companyName),
    phone: normalizeId(address.phone),
    addressLine1: normalizeId(address.address_line1 || address.addressLine1),
    addressLine2: normalizeId(address.address_line2 || address.addressLine2),
    city: normalizeId(address.city),
    stateProvince: normalizeId(address.state_province || address.stateProvince || address.state),
    postalCode: normalizeId(address.postal_code || address.postalCode),
    countryCode: normalizeId(address.country_code || address.countryCode),
    residential: Boolean(address.address_residential_indicator === 'yes' || address.residential),
  };
}

function normalizePackageWeight(weight) {
  if (!weight || typeof weight !== 'object') return null;
  return {
    value: Number(weight.value || 0),
    unit: normalizeId(weight.unit || weight.units),
  };
}

function normalizePackageDimensions(dimensions) {
  if (!dimensions || typeof dimensions !== 'object') return null;
  return {
    length: Number(dimensions.length || 0),
    width: Number(dimensions.width || 0),
    height: Number(dimensions.height || 0),
    unit: normalizeId(dimensions.unit || dimensions.units),
  };
}

function normalizePackageDimensionsForWrite(dimensions) {
  if (!dimensions || typeof dimensions !== 'object') return null;
  const length = Number(dimensions.length);
  const width = Number(dimensions.width);
  const height = Number(dimensions.height);
  if (![length, width, height].every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }
  return {
    length,
    width,
    height,
    unit: normalizeId(dimensions.unit) || 'centimeter',
  };
}

function summarizeRateForLog(rate) {
  if (!rate) return null;
  return {
    rateId: rate.rateId,
    shipmentId: rate.shipmentId,
    carrierCode: rate.carrierCode,
    carrierName: rate.carrierName,
    serviceCode: rate.serviceCode,
    serviceName: rate.serviceName,
    packageCode: rate.packageCode,
    deliveryDays: rate.deliveryDays,
    totalAmount: rate.totalAmount,
    shippingAmount: rate.shippingAmount,
    validationStatus: rate.validationStatus,
    warningMessages: rate.warningMessages,
    errorMessages: rate.errorMessages,
  };
}

function normalizeShipment(shipment) {
  if (!shipment || typeof shipment !== 'object') return null;

  const packages = Array.isArray(shipment.packages)
    ? shipment.packages.map((pkg) => ({
        id: normalizeId(pkg.shipment_package_id || pkg.package_id || pkg.id),
        packageCode: normalizeId(pkg.package_code || pkg.packageCode),
        weight: normalizePackageWeight(pkg.weight),
        dimensions: normalizePackageDimensions(pkg.dimensions),
        insuredValue: normalizeMoney(pkg.insured_value || pkg.insuredValue),
      }))
    : [];

  return {
    shipmentId: normalizeId(shipment.shipment_id || shipment.shipmentId),
    externalShipmentId: normalizeId(shipment.external_shipment_id || shipment.externalShipmentId),
    externalOrderId: normalizeId(shipment.external_order_id || shipment.externalOrderId),
    shipmentNumber: normalizeId(shipment.shipment_number || shipment.shipmentNumber),
    salesOrderId: normalizeId(shipment.sales_order_id || shipment.salesOrderId),
    orderNumber: normalizeId(shipment.order_number || shipment.orderNumber),
    status: normalizeId(shipment.shipment_status || shipment.status),
    carrierId: normalizeId(shipment.carrier_id || shipment.carrierId),
    carrierCode: normalizeId(shipment.carrier_code || shipment.carrierCode),
    carrierFriendlyName: normalizeId(shipment.carrier_friendly_name || shipment.carrierFriendlyName),
    serviceCode: normalizeId(shipment.service_code || shipment.serviceCode),
    serviceType: normalizeId(shipment.service_type || shipment.serviceType),
    requestedShipmentService: normalizeId(shipment.requested_shipment_service || shipment.requestedShipmentService),
    packageCode: normalizeId(shipment.package_code || shipment.packageCode),
    confirmation: normalizeId(shipment.confirmation),
    insuranceProvider: normalizeId(shipment.insurance_provider || shipment.insuranceProvider),
    shipDate: normalizeId(shipment.ship_date || shipment.shipDate),
    shipTo: normalizeAddress(shipment.ship_to || shipment.shipTo),
    shipFrom: normalizeAddress(shipment.ship_from || shipment.shipFrom),
    packages,
    raw: shipment,
  };
}

function scoreShipmentMatch(shipment, identifiers) {
  const normalized = normalizeShipment(shipment);
  if (!normalized?.shipmentId) return -1;

  let score = 0;
  if (valueMatchesAnyIdentifier(normalized.externalOrderId, identifiers)) score += 1000;
  if (valueMatchesAnyIdentifier(normalized.orderNumber, identifiers)) score += 950;
  if (valueMatchesAnyIdentifier(normalized.shipmentNumber, identifiers)) score += 900;
  if (valueMatchesAnyIdentifier(normalized.externalShipmentId, identifiers)) score += 850;
  if (valueMatchesAnyIdentifier(normalized.salesOrderId, identifiers)) score += 800;

  const status = normalizeCompare(normalized.status);
  if (status === 'PENDING' || status === 'PROCESSING') score += 100;
  if (status === 'LABEL_PURCHASED') score += 20;
  if (status === 'CANCELLED') score -= 300;

  return score;
}

async function listShipments(query) {
  const payload = await shipStationRequest('/v2/shipments', {
    query: {
      page_size: 25,
      ...query,
    },
  });
  return extractShipments(payload);
}

async function lookupShipmentForOrder({ identifiers = [] } = {}) {
  const lookupIdentifiers = buildOrderLookupIdentifiers(identifiers);
  const attemptedQueries = [];
  const byShipmentId = new Map();

  async function addAttempt(label, fn) {
    attemptedQueries.push({ label, ok: false, error: null, resultCount: 0, shipmentIds: [] });
    const attempt = attemptedQueries[attemptedQueries.length - 1];
    try {
      const rows = await fn();
      const rowList = Array.isArray(rows) ? rows : [rows].filter(Boolean);
      const normalizedRows = rowList
        .map(normalizeShipment)
        .filter((shipment) => shipment?.shipmentId);
      attempt.ok = true;
      attempt.resultCount = rowList.length;
      attempt.shipmentIds = normalizedRows.map((shipment) => shipment.shipmentId);
      normalizedRows.forEach((normalized) => {
        const sourceRow = rowList.find((row) => normalizeShipment(row)?.shipmentId === normalized.shipmentId);
        byShipmentId.set(normalized.shipmentId, sourceRow || normalized.raw || normalized);
      });
    } catch (err) {
      attempt.error = err.message || 'ShipStation lookup failed';
    }
  }

  for (const identifier of lookupIdentifiers) {
    await addAttempt(`shipment_number=${identifier}`, () => listShipments({ shipment_number: identifier }));
  }

  const candidates = Array.from(byShipmentId.values())
    .map((shipment) => ({
      shipment: normalizeShipment(shipment),
      score: scoreShipmentMatch(shipment, lookupIdentifiers),
    }))
    .filter((candidate) => candidate.shipment?.shipmentId)
    .sort((left, right) => right.score - left.score);
  const selectedAttemptLabel = attemptedQueries.find((attempt) => (
    attempt.shipmentIds || []
  ).includes(candidates[0]?.shipment?.shipmentId))?.label || '';

  return {
    shipment: candidates[0]?.shipment || null,
    candidates: candidates.map((candidate) => candidate.shipment),
    attemptedIdentifiers: lookupIdentifiers,
    attemptedQueries,
    selectedAttemptLabel,
  };
}

async function getShipmentById(shipmentId) {
  const payload = await shipStationRequest(`/v2/shipments/${encodeURIComponent(normalizeId(shipmentId))}`);
  return normalizeShipment(payload);
}

function pickExistingShipmentField(shipment, key) {
  if (!shipment || typeof shipment !== 'object') return undefined;
  return shipment[key] === undefined ? undefined : shipment[key];
}

function buildShipmentWeightUpdatePayload(existingShipment, weightGrams, packageDimensions = null) {
  const raw = existingShipment?.raw || existingShipment || {};
  const normalizedPackageDimensions = normalizePackageDimensionsForWrite(packageDimensions);
  const allowedFields = [
    'carrier_id',
    'service_code',
    'requested_shipment_service',
    'ship_date',
    'ship_to',
    'ship_from',
    'warehouse_id',
    'return_to',
    'confirmation',
    'customs',
    'advanced_options',
    'insurance_provider',
    'order_source_code',
  ];
  const payload = {};

  allowedFields.forEach((field) => {
    const value = pickExistingShipmentField(raw, field);
    if (value !== undefined && value !== null) {
      payload[field] = value;
    }
  });

  const sourcePackages = Array.isArray(raw.packages) && raw.packages.length > 0
    ? raw.packages
    : [{}];
  payload.packages = sourcePackages.map((pkg, index) => {
    const nextPackage = {};
    [
      'package_code',
      'dimensions',
      'insured_value',
      'label_messages',
      'external_package_id',
      'products',
    ].forEach((field) => {
      if (pkg[field] !== undefined && pkg[field] !== null) {
        nextPackage[field] = pkg[field];
      }
    });
    nextPackage.weight = index === 0
      ? { value: weightGrams, unit: 'gram' }
      : (pkg.weight || { value: 1, unit: 'gram' });
    if (index === 0 && normalizedPackageDimensions) {
      nextPackage.dimensions = normalizedPackageDimensions;
    }
    return nextPackage;
  });

  return payload;
}

async function updateShipmentWeight({ shipmentId, weightGrams, packageDimensions = null }) {
  const safeShipmentId = normalizeId(shipmentId);
  const safeWeightGrams = Math.max(1, Math.floor(Number(weightGrams) || 0));
  const normalizedPackageDimensions = normalizePackageDimensionsForWrite(packageDimensions);
  if (!safeShipmentId) throw new Error('Missing ShipStation shipment id.');
  if (!safeWeightGrams) throw new Error('Enter a valid package weight in grams.');
  if (packageDimensions && !normalizedPackageDimensions) {
    throw new Error('Enter valid package dimensions.');
  }

  console.log('[ShipStation rate check] Loading shipment before package update', {
    shipmentId: safeShipmentId,
    weightGrams: safeWeightGrams,
    packageDimensions: normalizedPackageDimensions,
  });
  const existingShipment = await getShipmentById(safeShipmentId);
  console.log('[ShipStation rate check] Existing shipment summary', {
    shipmentId: existingShipment?.shipmentId || '',
    shipmentNumber: existingShipment?.shipmentNumber || '',
    orderNumber: existingShipment?.orderNumber || '',
    status: existingShipment?.status || '',
    carrierCode: existingShipment?.carrierCode || '',
    serviceCode: existingShipment?.serviceCode || '',
    packageCode: existingShipment?.packageCode || '',
    packageCount: existingShipment?.packages?.length || 0,
  });

  const payload = buildShipmentWeightUpdatePayload(existingShipment, safeWeightGrams, normalizedPackageDimensions);
  console.log('[ShipStation rate check] Updating shipment package', {
    shipmentId: safeShipmentId,
    weightGrams: safeWeightGrams,
    packageDimensions: normalizedPackageDimensions,
    packageCount: payload.packages?.length || 0,
    firstPackageCode: payload.packages?.[0]?.package_code || '',
    firstPackageDimensions: payload.packages?.[0]?.dimensions || null,
    carrierIdPresent: Boolean(payload.carrier_id),
    serviceCode: payload.service_code || '',
    requestedShipmentService: payload.requested_shipment_service || '',
  });

  const updated = await shipStationRequest(`/v2/shipments/${encodeURIComponent(safeShipmentId)}`, {
    method: 'PUT',
    body: payload,
  });
  const normalizedUpdated = normalizeShipment(updated?.shipment || updated) || await getShipmentById(safeShipmentId);
  console.log('[ShipStation rate check] Shipment package update complete', {
    shipmentId: normalizedUpdated?.shipmentId || safeShipmentId,
    status: normalizedUpdated?.status || '',
    carrierCode: normalizedUpdated?.carrierCode || '',
    serviceCode: normalizedUpdated?.serviceCode || '',
    packageCode: normalizedUpdated?.packageCode || '',
    packageWeights: (normalizedUpdated?.packages || []).map((pkg) => pkg.weight).filter(Boolean),
    packageDimensions: (normalizedUpdated?.packages || []).map((pkg) => pkg.dimensions).filter(Boolean),
  });

  return normalizedUpdated;
}

function normalizeMoney(value) {
  if (!value || typeof value !== 'object') {
    return { amount: 0, currency: '' };
  }
  return {
    amount: Number(value.amount || 0),
    currency: normalizeId(value.currency).toUpperCase(),
  };
}

function addMoney(...values) {
  const amounts = values.map(normalizeMoney);
  const currency = amounts.find((item) => item.currency)?.currency || '';
  const amount = amounts.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  return { amount, currency };
}

function normalizeRate(rate) {
  if (!rate || typeof rate !== 'object') return null;
  const total = addMoney(
    rate.shipping_amount,
    rate.insurance_amount,
    rate.confirmation_amount,
    rate.other_amount
  );

  return {
    rateId: normalizeId(rate.rate_id || rate.rateId),
    shipmentId: normalizeId(rate.shipment_id || rate.shipmentId),
    rateType: normalizeId(rate.rate_type || rate.rateType),
    carrierId: normalizeId(rate.carrier_id || rate.carrierId),
    carrierCode: normalizeId(rate.carrier_code || rate.carrierCode),
    carrierName: normalizeId(rate.carrier_friendly_name || rate.carrierFriendlyName || rate.carrier_nickname),
    serviceCode: normalizeId(rate.service_code || rate.serviceCode),
    serviceName: normalizeId(rate.service_type || rate.serviceType),
    packageCode: normalizeId(rate.package_code || rate.packageCode),
    deliveryDays: Number.isFinite(Number(rate.delivery_days)) ? Number(rate.delivery_days) : null,
    deliveryDate: normalizeId(rate.delivery_date || rate.deliveryDate),
    validationStatus: normalizeId(rate.validation_status || rate.validationStatus),
    warningMessages: Array.isArray(rate.warning_messages) ? rate.warning_messages : [],
    errorMessages: Array.isArray(rate.error_messages) ? rate.error_messages : [],
    shippingAmount: normalizeMoney(rate.shipping_amount),
    totalAmount: total,
    raw: rate,
  };
}

function extractRates(payload) {
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => Array.isArray(entry?.rates) ? entry.rates : []);
  }
  if (Array.isArray(payload?.rates)) return payload.rates;
  if (Array.isArray(payload?.rate_response?.rates)) return payload.rate_response.rates;
  return [];
}

function extractInvalidRates(payload) {
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => Array.isArray(entry?.invalid_rates) ? entry.invalid_rates : []);
  }
  if (Array.isArray(payload?.invalid_rates)) return payload.invalid_rates;
  if (Array.isArray(payload?.rate_response?.invalid_rates)) return payload.rate_response.invalid_rates;
  return [];
}

async function getShipmentRates(shipmentId, {
  carrierId = '',
  selectedServiceCode = '',
  packageCode = '',
  preferredCurrency = 'GBP',
} = {}) {
  const safeShipmentId = normalizeId(shipmentId);
  const safeCarrierId = normalizeId(carrierId);
  const safeSelectedServiceCode = normalizeId(selectedServiceCode);
  const safePackageCode = normalizeId(packageCode);
  const safePreferredCurrency = normalizeId(preferredCurrency).toUpperCase() || 'GBP';
  if (!safeCarrierId) {
    throw new Error('ShipStation shipment is missing carrier_id, so rates cannot be generated.');
  }

  console.log('[ShipStation rate check] Requesting shipment rates', {
    shipmentId: safeShipmentId,
    carrierId: safeCarrierId,
    selectedServiceCode: safeSelectedServiceCode,
    packageCode: safePackageCode,
    preferredCurrency: safePreferredCurrency,
  });

  const rateOptions = {
    carrier_ids: [safeCarrierId],
    preferred_currency: safePreferredCurrency,
  };
  if (safeSelectedServiceCode) {
    rateOptions.service_codes = [safeSelectedServiceCode];
  }
  if (safePackageCode) {
    rateOptions.package_types = [safePackageCode];
  }

  const ratesPath = '/v2/rates';
  const ratesBody = {
    shipment_id: safeShipmentId,
    rate_options: rateOptions,
  };
  console.log('[ShipStation rate check] Rates network request', {
    method: 'POST',
    url: buildShipStationUrl(ratesPath),
    body: ratesBody,
  });

  const payload = await shipStationRequest(ratesPath, {
    method: 'POST',
    body: ratesBody,
  });
  const selectedCode = normalizeCompare(safeSelectedServiceCode);
  const rawRates = extractRates(payload);
  const invalidRates = extractInvalidRates(payload);
  const normalizedRates = rawRates.map(normalizeRate).filter(Boolean);
  const validRates = normalizedRates
    .filter((rate) => rate?.rateId && rate.errorMessages.length === 0)
    .sort((left, right) => {
      const leftSelected = selectedCode && normalizeCompare(left.serviceCode) === selectedCode ? 1 : 0;
      const rightSelected = selectedCode && normalizeCompare(right.serviceCode) === selectedCode ? 1 : 0;
      if (leftSelected !== rightSelected) return rightSelected - leftSelected;
      return Number(left.totalAmount.amount || 0) - Number(right.totalAmount.amount || 0);
    });

  console.log('[ShipStation rate check] Rates response summary', {
    shipmentId: safeShipmentId,
    rawRateCount: rawRates.length,
    normalizedRateCount: normalizedRates.length,
    validRateCount: validRates.length,
    invalidRateCount: invalidRates.length,
    selectedServiceCode: safeSelectedServiceCode,
    carrierId: safeCarrierId,
    packageCode: safePackageCode,
    rawResponseKeys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
    rateResponseStatus: payload?.rate_response?.status || '',
    errors: payload?.errors || payload?.rate_response?.errors || null,
    rates: normalizedRates.map(summarizeRateForLog),
    invalidRates,
  });

  return validRates;
}

function extractLabels(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.labels)) return payload.labels;
  if (payload?.label_id || payload?.labelId) return [payload];
  return [];
}

function getLabelDownloadUrl(label) {
  const download = label?.label_download || label?.labelDownload || {};
  return normalizeId(
    download.pdf
    || download.label
    || download.url
    || download.href
    || label?.label_url
    || label?.labelUrl
  );
}

function normalizeLabel(label) {
  if (!label || typeof label !== 'object') return null;
  const shipmentCost = normalizeMoney(label.shipment_cost || label.shipmentCost);
  const status = label.voided
    ? 'voided'
    : normalizeId(label.status || label.label_status || label.labelStatus);
  return {
    labelId: normalizeId(label.label_id || label.labelId),
    shipmentId: normalizeId(label.shipment_id || label.shipmentId),
    externalShipmentId: normalizeId(label.external_shipment_id || label.externalShipmentId),
    externalOrderId: normalizeId(label.external_order_id || label.externalOrderId),
    rateId: normalizeId(label.rate_id || label.rateId),
    status,
    trackingNumber: normalizeId(label.tracking_number || label.trackingNumber),
    carrierCode: normalizeId(label.carrier_code || label.carrierCode),
    serviceCode: normalizeId(label.service_code || label.serviceCode),
    labelFormat: normalizeId(label.label_format || label.labelFormat),
    labelLayout: normalizeId(label.label_layout || label.labelLayout),
    labelUrl: getLabelDownloadUrl(label),
    shipmentCost,
    raw: label,
  };
}

async function listLabelsForShipment(shipmentId) {
  const payload = await shipStationRequest('/v2/labels', {
    query: {
      shipment_id: normalizeId(shipmentId),
      page_size: 25,
      sort_by: 'created_at',
      sort_dir: 'desc',
    },
  });
  return extractLabels(payload).map(normalizeLabel).filter((label) => label?.labelId);
}

async function getLabelById(labelId) {
  const payload = await shipStationRequest(`/v2/labels/${encodeURIComponent(normalizeId(labelId))}`);
  return normalizeLabel(payload?.label || payload);
}

async function purchaseLabelForRate(rateId) {
  const payload = await shipStationRequest(`/v2/labels/rates/${encodeURIComponent(normalizeId(rateId))}`, {
    method: 'POST',
    body: {
      validate_address: 'no_validation',
      label_layout: '4x6',
      label_format: 'pdf',
      label_download_type: 'url',
      display_scheme: 'label',
    },
  });
  return normalizeLabel(payload?.label || payload);
}

async function voidLabelById(labelId) {
  const payload = await shipStationRequest(`/v2/labels/${encodeURIComponent(normalizeId(labelId))}/void`, {
    method: 'PUT',
  });
  return {
    approved: Boolean(payload?.approved),
    message: normalizeId(payload?.message),
    voidedLabelIds: Array.isArray(payload?.voided_label_ids)
      ? payload.voided_label_ids
      : [],
    raw: payload,
  };
}

async function downloadLabelBuffer(labelUrl) {
  const safeUrl = normalizeId(labelUrl);
  if (!safeUrl) throw new Error('ShipStation label download URL is missing.');
  return shipStationRequest(safeUrl, { raw: true });
}

module.exports = {
  buildOrderLookupIdentifiers,
  getShipmentById,
  getShipmentRates,
  listLabelsForShipment,
  lookupShipmentForOrder,
  purchaseLabelForRate,
  voidLabelById,
  downloadLabelBuffer,
  getLabelById,
  updateShipmentWeight,
};
