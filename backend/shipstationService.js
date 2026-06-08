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
    const err = new Error(`ShipStation error ${response.status}: ${message}`);
    err.status = response.status;
    err.data = data;
    err.url = url;
    err.method = method;
    throw err;
  }

  return data;
}

function normalizeId(value) {
  return String(value || '').trim();
}

function getShipDateTimeZone() {
  return normalizeId(process.env.SHIPSTATION_SHIP_DATE_TIME_ZONE) || 'Europe/London';
}

function formatDateInTimeZone(date, timeZone = getShipDateTimeZone()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date).reduce((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});

    if (parts.year && parts.month && parts.day) {
      return `${parts.year}-${parts.month}-${parts.day}`;
    }
  } catch (err) {
    console.warn('[ShipStation] Invalid SHIPSTATION_SHIP_DATE_TIME_ZONE, falling back to UTC', {
      timeZone,
      error: err.message || String(err),
    });
  }

  return date.toISOString().slice(0, 10);
}

function normalizeShipDateOnly(value) {
  const raw = normalizeId(value);
  if (!raw) return '';

  const directMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directMatch) return directMatch[1];

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  return formatDateInTimeZone(parsed);
}

function getSafeShipmentShipDate(value) {
  const today = formatDateInTimeZone(new Date());
  const existingDate = normalizeShipDateOnly(value);
  return existingDate && existingDate >= today ? existingDate : today;
}

function normalizeCompare(value) {
  return normalizeId(value)
    .replace(/^#/, '')
    .toUpperCase();
}

function normalizeSearchText(value) {
  return normalizeId(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  const companyName = normalizeId(address.company_name || address.companyName);
  const name = normalizeId(address.name) || companyName;
  return {
    name,
    companyName,
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

function applyCompanyNameFallbackToAddress(address) {
  if (!address || typeof address !== 'object') return address;
  const name = normalizeId(address.name);
  const companyName = normalizeId(address.company_name || address.companyName);
  if (name || !companyName) return address;
  return {
    ...address,
    name: companyName,
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

function normalizePackageInsuredValueForWrite(pkg = {}) {
  const hasExplicitAmount = Object.prototype.hasOwnProperty.call(pkg, 'insuredValueAmount')
    || Object.prototype.hasOwnProperty.call(pkg, 'insuranceValueAmount');
  const sourceValue = pkg.insuredValue || pkg.insured_value || null;
  const hasExplicitObject = Boolean(sourceValue && typeof sourceValue === 'object');
  if (!hasExplicitAmount && !hasExplicitObject) return undefined;

  const rawAmount = hasExplicitAmount
    ? (pkg.insuredValueAmount ?? pkg.insuranceValueAmount)
    : sourceValue.amount;
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const currency = normalizeId(
    pkg.insuredValueCurrency
    || pkg.insuranceValueCurrency
    || sourceValue?.currency
    || 'GBP'
  ).toUpperCase() || 'GBP';

  return {
    amount: Number(amount.toFixed(2)),
    currency,
  };
}

function getPackageInsuranceSource(pkg = {}) {
  return pkg?.insured_value
    || pkg?.insuredValue
    || pkg?.insured_amount
    || pkg?.insuredAmount
    || pkg?.insurance_amount
    || pkg?.insuranceAmount
    || null;
}

function getPackageInsuranceAmount(pkg = {}) {
  const source = getPackageInsuranceSource(pkg);
  if (source && typeof source === 'object') {
    return Number(source.amount ?? source.value ?? 0);
  }
  return Number(source || 0);
}

function hasPositivePackageInsurance(pkg = {}) {
  const amount = getPackageInsuranceAmount(pkg);
  return Number.isFinite(amount) && amount > 0;
}

function normalizePackageInsuranceForPayload(pkg = {}) {
  const source = getPackageInsuranceSource(pkg);
  const amount = getPackageInsuranceAmount(pkg);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (source && typeof source === 'object') {
    return {
      amount: Number(amount.toFixed(2)),
      currency: normalizeId(source.currency || source.currency_code || source.currencyCode || 'GBP').toUpperCase() || 'GBP',
    };
  }
  return {
    amount: Number(amount.toFixed(2)),
    currency: normalizeId(pkg.insuredValueCurrency || pkg.insuranceValueCurrency || 'GBP').toUpperCase() || 'GBP',
  };
}

function normalizePackageType(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  const packageCode = normalizeId(pkg.package_code || pkg.packageCode || pkg.code);
  const name = normalizeId(pkg.name || pkg.package_name || pkg.packageName || pkg.description || packageCode);
  if (!packageCode) return null;
  return {
    packageCode,
    name: name || packageCode,
    description: normalizeId(pkg.description),
    raw: pkg,
  };
}

function extractPackageTypes(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.packages)) return payload.packages;
  if (Array.isArray(payload?.package_types)) return payload.package_types;
  if (Array.isArray(payload?.packageTypes)) return payload.packageTypes;
  return [];
}

function extractCarriers(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.carriers)) return payload.carriers;
  if (Array.isArray(payload?.data)) return payload.data;
  if (payload?.carrier_id || payload?.carrierId) return [payload];
  return [];
}

function extractCarrierServices(carrier) {
  if (Array.isArray(carrier?.services)) return carrier.services;
  if (Array.isArray(carrier?.service_types)) return carrier.service_types;
  if (Array.isArray(carrier?.serviceTypes)) return carrier.serviceTypes;
  return [];
}

function normalizeCarrierService(service) {
  if (!service || typeof service !== 'object') return null;
  const serviceCode = normalizeId(service.service_code || service.serviceCode || service.code);
  const name = normalizeId(service.name || service.service_name || service.serviceName || service.description || serviceCode);
  if (!serviceCode && !name) return null;
  return {
    serviceCode,
    name,
    raw: service,
  };
}

function normalizeCarrier(carrier) {
  if (!carrier || typeof carrier !== 'object') return null;
  const carrierId = normalizeId(carrier.carrier_id || carrier.carrierId || carrier.id);
  return {
    carrierId,
    carrierCode: normalizeId(carrier.carrier_code || carrier.carrierCode || carrier.code),
    name: normalizeId(carrier.friendly_name || carrier.friendlyName || carrier.name || carrier.nickname || carrier.carrier_name || carrier.carrierName),
    packages: dedupePackageTypes(extractPackageTypes(carrier)),
    services: extractCarrierServices(carrier).map(normalizeCarrierService).filter(Boolean),
    raw: carrier,
  };
}

function packageTypeDedupeKey(pkg) {
  return normalizeCompare(pkg?.packageCode || pkg?.package_code || pkg?.code);
}

function dedupePackageTypes(packageTypes = []) {
  const seen = new Set();
  return (Array.isArray(packageTypes) ? packageTypes : [])
    .map(normalizePackageType)
    .filter(Boolean)
    .filter((pkg) => {
      const key = packageTypeDedupeKey(pkg);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.packageCode.localeCompare(right.packageCode));
}

async function listCarrierPackageTypes(carrierId) {
  const safeCarrierId = normalizeId(carrierId);
  if (!safeCarrierId) return [];
  const packageTypes = [];
  const errors = [];

  try {
    const payload = await shipStationRequest(`/v2/carriers/${encodeURIComponent(safeCarrierId)}/packages`);
    packageTypes.push(...extractPackageTypes(payload));
  } catch (err) {
    errors.push(err.message || String(err));
  }

  try {
    const carrierPayload = await shipStationRequest(`/v2/carriers/${encodeURIComponent(safeCarrierId)}`);
    packageTypes.push(...extractPackageTypes(carrierPayload));
  } catch (err) {
    errors.push(err.message || String(err));
  }

  const normalizedPackageTypes = dedupePackageTypes(packageTypes);
  if (!normalizedPackageTypes.length && errors.length) {
    throw new Error(errors.join(' | '));
  }
  return normalizedPackageTypes;
}

async function listCarriers() {
  const payload = await shipStationRequest('/v2/carriers', {
    query: { page_size: 100 },
  });
  return extractCarriers(payload)
    .map(normalizeCarrier)
    .filter((carrier) => carrier?.carrierId);
}

async function listCustomPackageTypes() {
  const payload = await shipStationRequest('/v2/packages');
  return dedupePackageTypes(extractPackageTypes(payload));
}

function getCarrierLookupCandidates(shipment = {}) {
  return Array.from(new Set([
    shipment?.carrierId,
    shipment?.raw?.carrier_id,
    shipment?.raw?.carrierId,
    shipment?.carrierCode,
    shipment?.raw?.carrier_code,
    shipment?.raw?.carrierCode,
  ].map(normalizeId).filter(Boolean)));
}

function carrierMatchesShipment(carrier, shipment) {
  if (!carrier || !shipment) return false;
  const shipmentValues = [
    shipment.carrierId,
    shipment.raw?.carrier_id,
    shipment.raw?.carrierId,
    shipment.carrierCode,
    shipment.raw?.carrier_code,
    shipment.raw?.carrierCode,
    shipment.carrierFriendlyName,
    shipment.raw?.carrier_friendly_name,
    shipment.raw?.carrierFriendlyName,
    shipment.serviceCode,
    shipment.raw?.service_code,
    shipment.raw?.serviceCode,
    shipment.serviceType,
    shipment.raw?.service_type,
    shipment.raw?.serviceType,
    shipment.requestedShipmentService,
    shipment.raw?.requested_shipment_service,
    shipment.raw?.requestedShipmentService,
  ].filter(Boolean);
  const shipmentCodes = shipmentValues.map(normalizeCompare).filter(Boolean);
  const carrierValues = [
    carrier.carrierId,
    carrier.carrierCode,
    carrier.name,
    carrier.raw?.nickname,
    carrier.raw?.friendly_name,
    carrier.raw?.friendlyName,
    carrier.raw?.name,
    carrier.raw?.carrier_name,
    carrier.raw?.carrierName,
  ].filter(Boolean);
  const carrierCodes = carrierValues.map(normalizeCompare).filter(Boolean);
  if (carrierCodes.some((code) => shipmentCodes.includes(code))) return true;

  const shipmentTextValues = shipmentValues.map(normalizeSearchText).filter(Boolean);
  const carrierTextValues = carrierValues.map(normalizeSearchText).filter(Boolean);
  if (carrierTextValues.some((carrierText) => (
    shipmentTextValues.some((shipmentText) => (
      shipmentText === carrierText
      || shipmentText.includes(carrierText)
      || carrierText.includes(shipmentText)
    ))
  ))) {
    return true;
  }

  const serviceValues = (carrier.services || []).flatMap((service) => [
    service.serviceCode,
    service.name,
  ]).filter(Boolean);
  const serviceCodes = serviceValues.map(normalizeCompare).filter(Boolean);
  if (serviceCodes.some((code) => shipmentCodes.includes(code))) return true;

  const serviceTextValues = serviceValues.map(normalizeSearchText).filter(Boolean);
  return serviceTextValues.some((serviceText) => (
    shipmentTextValues.some((shipmentText) => (
      shipmentText === serviceText
      || shipmentText.includes(serviceText)
      || serviceText.includes(shipmentText)
    ))
  ));
}

async function listPackageTypesForShipment(shipment) {
  if (!shipment) return { packageTypes: [], attempts: [] };
  const attempts = [];
  const collectedPackageTypes = [];

  const addPackageTypes = (source, packageTypes, extra = {}) => {
    const normalizedPackageTypes = dedupePackageTypes(packageTypes);
    attempts.push({
      source,
      ok: true,
      packageTypeCount: normalizedPackageTypes.length,
      ...extra,
    });
    collectedPackageTypes.push(...normalizedPackageTypes);
  };

  for (const candidate of getCarrierLookupCandidates(shipment)) {
    try {
      const packageTypes = await listCarrierPackageTypes(candidate);
      addPackageTypes('shipment_candidate', packageTypes, { carrier: candidate });
    } catch (err) {
      attempts.push({ source: 'shipment_candidate', carrier: candidate, ok: false, error: err.message || String(err) });
    }
  }

  let carriers = [];
  try {
    carriers = await listCarriers();
    attempts.push({ source: 'carriers', ok: true, carrierCount: carriers.length });
  } catch (err) {
    attempts.push({ source: 'carriers', ok: false, error: err.message || String(err) });
  }

  const matchedCarriers = carriers.filter((carrier) => carrierMatchesShipment(carrier, shipment));
  matchedCarriers.forEach((carrier) => {
    addPackageTypes('matched_carrier_embedded', carrier.packages || [], {
      carrier: carrier.carrierId,
      carrierCode: carrier.carrierCode,
      carrierName: carrier.name,
    });
  });

  for (const carrier of matchedCarriers) {
    try {
      const packageTypes = await listCarrierPackageTypes(carrier.carrierId);
      addPackageTypes('matched_carrier_detail', packageTypes, {
        carrier: carrier.carrierId,
        carrierCode: carrier.carrierCode,
        carrierName: carrier.name,
      });
    } catch (err) {
      attempts.push({
        source: 'matched_carrier_detail',
        carrier: carrier.carrierId,
        carrierCode: carrier.carrierCode,
        carrierName: carrier.name,
        ok: false,
        error: err.message || String(err),
      });
    }
  }

  if (!dedupePackageTypes(collectedPackageTypes).length && carriers.length) {
    const unmatchedCarriers = carriers.filter((carrier) => !matchedCarriers.some((matched) => matched.carrierId === carrier.carrierId));
    attempts.push({
      source: 'all_carriers_fallback',
      ok: true,
      carrierCount: unmatchedCarriers.length,
    });

    unmatchedCarriers.forEach((carrier) => {
      addPackageTypes('all_carriers_embedded', carrier.packages || [], {
        carrier: carrier.carrierId,
        carrierCode: carrier.carrierCode,
        carrierName: carrier.name,
      });
    });

    for (const carrier of unmatchedCarriers) {
      try {
        const packageTypes = await listCarrierPackageTypes(carrier.carrierId);
        addPackageTypes('all_carriers_detail', packageTypes, {
          carrier: carrier.carrierId,
          carrierCode: carrier.carrierCode,
          carrierName: carrier.name,
        });
      } catch (err) {
        attempts.push({
          source: 'all_carriers_detail',
          carrier: carrier.carrierId,
          carrierCode: carrier.carrierCode,
          carrierName: carrier.name,
          ok: false,
          error: err.message || String(err),
        });
      }
    }
  }

  try {
    const customPackageTypes = await listCustomPackageTypes();
    addPackageTypes('custom_package_types', customPackageTypes);
  } catch (err) {
    attempts.push({ source: 'custom_package_types', ok: false, error: err.message || String(err) });
  }

  return { packageTypes: dedupePackageTypes(collectedPackageTypes), attempts };
}

function getMoneyCurrency(value, fallbackCurrency = '') {
  if (value && typeof value === 'object') {
    return normalizeId(value.currency || value.currency_code || value.currencyCode || fallbackCurrency).toUpperCase();
  }
  return normalizeId(fallbackCurrency).toUpperCase();
}

function parseMoneyAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  const stripped = String(value || '').replace(/[^0-9.-]/g, '');
  const parsed = Number(stripped);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeMoneyLike(value, fallbackCurrency = '') {
  if (value && typeof value === 'object') {
    return {
      amount: parseMoneyAmount(value.amount ?? value.value ?? 0),
      currency: getMoneyCurrency(value, fallbackCurrency),
    };
  }
  return {
    amount: parseMoneyAmount(value),
    currency: normalizeId(fallbackCurrency).toUpperCase(),
  };
}

function firstMoneyLike(product, keys = [], fallbackCurrency = '') {
  for (const key of keys) {
    const value = product?.[key];
    if (value !== undefined && value !== null && value !== '') {
      return normalizeMoneyLike(value, fallbackCurrency);
    }
  }
  return { amount: 0, currency: normalizeId(fallbackCurrency).toUpperCase() };
}

function sumMoneyLikes(product, keys = [], fallbackCurrency = '') {
  let amount = 0;
  let currency = normalizeId(fallbackCurrency).toUpperCase();
  keys.forEach((key) => {
    const value = product?.[key];
    if (value === undefined || value === null || value === '') return;
    const money = normalizeMoneyLike(value, currency || fallbackCurrency);
    const nextAmount = Number(money.amount || 0);
    if (Number.isFinite(nextAmount)) amount += nextAmount;
    if (!currency && money.currency) currency = money.currency;
  });
  return {
    amount,
    currency: currency || normalizeId(fallbackCurrency).toUpperCase(),
  };
}

function addMoneyLikeAmounts(base, addition, fallbackCurrency = '') {
  const baseAmount = Number(base?.amount || 0);
  const additionAmount = Number(addition?.amount || 0);
  const amount = (Number.isFinite(baseAmount) ? baseAmount : 0)
    + (Number.isFinite(additionAmount) ? additionAmount : 0);
  const currency = normalizeId(
    base?.currency
    || addition?.currency
    || fallbackCurrency
  ).toUpperCase();
  return {
    amount,
    currency,
  };
}

function extractShipmentProductRows(shipment) {
  const raw = shipment || {};
  const packages = Array.isArray(raw.packages) ? raw.packages : [];
  const candidates = [
    raw.products,
    raw.items,
    raw.line_items,
    raw.lineItems,
    raw.order_items,
    raw.orderItems,
    raw.customs?.contents,
    raw.customs?.items,
    raw.customs?.customs_items,
    ...packages.map((pkg) => pkg?.products),
  ];
  const seen = new Set();
  return candidates
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter((product) => {
      if (!product || typeof product !== 'object' || seen.has(product)) return false;
      seen.add(product);
      return true;
    });
}

function normalizeShipmentProduct(product) {
  if (!product || typeof product !== 'object') return null;
  const fallbackCurrency = normalizeId(
    product.currency
    || product.currency_code
    || product.currencyCode
    || product.total_paid?.currency
    || product.totalPaid?.currency
    || product.total?.currency
    || 'GBP'
  ).toUpperCase() || 'GBP';
  const quantity = Math.max(1, Math.floor(Number(
    product.quantity
    ?? product.qty
    ?? product.quantity_ordered
    ?? product.quantityOrdered
    ?? 1
  ) || 1));
  const totalPaid = firstMoneyLike(product, [
    'total_paid',
    'totalPaid',
    'amount_paid',
    'amountPaid',
    'total_paid_amount',
    'totalPaidAmount',
  ], fallbackCurrency);
  const total = firstMoneyLike(product, [
    'total',
    'total_amount',
    'totalAmount',
    'value',
    'customs_value',
    'customsValue',
  ], totalPaid.currency || fallbackCurrency);
  const generalTax = sumMoneyLikes(product, [
    'tax',
    'tax_amount',
    'taxAmount',
    'sales_tax',
    'salesTax',
    'sales_tax_amount',
    'salesTaxAmount',
    'vat',
    'vat_amount',
    'vatAmount',
  ], totalPaid.currency || total.currency || fallbackCurrency);
  const paidTax = sumMoneyLikes(product, [
    'tax_paid',
    'taxPaid',
    'tax_paid_amount',
    'taxPaidAmount',
    'paid_tax',
    'paidTax',
    'paid_tax_amount',
    'paidTaxAmount',
  ], totalPaid.currency || generalTax.currency || fallbackCurrency);
  const orderTax = sumMoneyLikes(product, [
    'total_tax',
    'totalTax',
    'total_tax_amount',
    'totalTaxAmount',
  ], total.currency || generalTax.currency || fallbackCurrency);
  const totalPaidTax = Number(paidTax.amount || 0) > 0 ? paidTax : generalTax;
  const totalTax = Number(orderTax.amount || 0) > 0 ? orderTax : generalTax;
  const totalPaidBaseAmount = Number(totalPaid.amount || 0);
  const totalBaseAmount = Number(total.amount || 0);
  const totalPaidWithTax = totalPaidBaseAmount > 0
    ? addMoneyLikeAmounts(totalPaid, totalPaidTax, fallbackCurrency)
    : { amount: 0, currency: normalizeId(totalPaid.currency || fallbackCurrency).toUpperCase() };
  const totalWithTax = totalBaseAmount > 0
    ? addMoneyLikeAmounts(total, totalTax, totalPaidWithTax.currency || fallbackCurrency)
    : total;
  const selected = totalPaidBaseAmount > 0 ? totalPaidWithTax : totalWithTax;
  const amount = Number(selected.amount || 0);
  const currency = normalizeId(selected.currency || totalPaidWithTax.currency || totalWithTax.currency || fallbackCurrency).toUpperCase() || 'GBP';

  return {
    sku: normalizeId(product.sku || product.product_sku || product.productSku || product.item_sku || product.itemSku || product.warehouse_sku || product.warehouseSku),
    name: normalizeId(product.name || product.product_name || product.productName || product.description || product.title),
    quantity,
    totalPaid: {
      amount: Number(totalPaidWithTax.amount || 0),
      currency: normalizeId(totalPaidWithTax.currency || currency).toUpperCase() || currency,
    },
    total: {
      amount: Number(totalWithTax.amount || 0),
      currency: normalizeId(totalWithTax.currency || currency).toUpperCase() || currency,
    },
    tax: {
      amount: Number(totalTax.amount || totalPaidTax.amount || 0),
      currency: normalizeId(totalTax.currency || totalPaidTax.currency || currency).toUpperCase() || currency,
    },
    valueAmount: Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : 0,
    unitValueAmount: Number.isFinite(amount) && amount > 0 ? Number((amount / quantity).toFixed(4)) : 0,
    valueCurrency: currency,
    valueSource: totalPaidBaseAmount > 0 ? 'total_paid_with_tax' : 'total_with_tax',
    raw: product,
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
  const products = extractShipmentProductRows(shipment)
    .map(normalizeShipmentProduct)
    .filter(Boolean);

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
    products,
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

function getExplicitQuantityValue(item = {}) {
  if (!item || typeof item !== 'object') return undefined;
  for (const key of ['quantity', 'qty', 'quantity_ordered', 'quantityOrdered']) {
    if (Object.prototype.hasOwnProperty.call(item, key)) {
      return item[key];
    }
  }
  return undefined;
}

function hasZeroExplicitQuantity(item = {}) {
  const quantity = getExplicitQuantityValue(item);
  if (quantity === undefined || quantity === null || quantity === '') return false;
  const numericQuantity = Number(quantity);
  return Number.isFinite(numericQuantity) && numericQuantity <= 0;
}

function removeZeroQuantityShipStationItems(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !hasZeroExplicitQuantity(item))
      .map(removeZeroQuantityShipStationItems);
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    removeZeroQuantityShipStationItems(entry),
  ]));
}

function normalizePackageUpdateEntries(packages = []) {
  return (Array.isArray(packages) ? packages : [])
    .map((pkg) => {
      const weightGrams = Math.max(1, Math.floor(Number(pkg?.weightGrams) || 0));
      const dimensions = normalizePackageDimensionsForWrite(pkg?.dimensions || pkg?.packageDimensions);
      const insuredValue = normalizePackageInsuredValueForWrite(pkg);
      const packageCode = normalizeId(pkg?.packageCode || pkg?.package_code);
      if (!weightGrams || !dimensions) return null;
      return { weightGrams, dimensions, insuredValue, packageCode };
    })
    .filter(Boolean);
}

function buildShipmentPackagesUpdatePayload(existingShipment, packages = []) {
  const raw = existingShipment?.raw || existingShipment || {};
  const normalizedPackages = normalizePackageUpdateEntries(packages);
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
      if (field === 'ship_to' || field === 'ship_from' || field === 'return_to') {
        payload[field] = applyCompanyNameFallbackToAddress(value);
      } else if (field === 'customs') {
        payload[field] = removeZeroQuantityShipStationItems(value);
      } else {
        payload[field] = value;
      }
    }
  });

  payload.ship_date = getSafeShipmentShipDate(raw.ship_date || raw.shipDate || existingShipment?.shipDate);

  const sourcePackages = Array.isArray(raw.packages) && raw.packages.length > 0
    ? raw.packages
    : [{}];
  const packageCount = Math.max(1, normalizedPackages.length);
  payload.packages = Array.from({ length: packageCount }, (_, index) => {
    const pkg = sourcePackages[index] || sourcePackages[0] || {};
    const packageUpdate = normalizedPackages[index] || normalizedPackages[0];
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
        nextPackage[field] = field === 'products'
          ? removeZeroQuantityShipStationItems(pkg[field])
          : pkg[field];
      }
    });
    const existingInsuredValue = normalizePackageInsuranceForPayload(pkg);
    if (existingInsuredValue && !hasPositivePackageInsurance(nextPackage)) {
      nextPackage.insured_value = existingInsuredValue;
    }
    if (packageCount > 1) {
      nextPackage.package_code = 'package';
    }
    if (packageUpdate.packageCode) {
      nextPackage.package_code = packageUpdate.packageCode;
    }
    nextPackage.weight = { value: packageUpdate.weightGrams, unit: 'gram' };
    nextPackage.dimensions = packageUpdate.dimensions;
    if (packageUpdate.insuredValue !== undefined && !hasPositivePackageInsurance(nextPackage)) {
      if (packageUpdate.insuredValue) {
        nextPackage.insured_value = packageUpdate.insuredValue;
      } else {
        delete nextPackage.insured_value;
      }
    }
    if (!nextPackage.external_package_id && packageCount > 1) {
      nextPackage.external_package_id = `package-${index + 1}`;
    }
    return nextPackage;
  });

  const missingInsurancePackageIndexes = payload.packages
    .map((pkg, index) => (hasPositivePackageInsurance(pkg) ? -1 : index))
    .filter((index) => index >= 0);
  const hasExplicitInsuranceValues = missingInsurancePackageIndexes
    .some((index) => normalizedPackages[index]?.insuredValue !== undefined);
  const hasPositiveInsuranceValue = missingInsurancePackageIndexes
    .some((index) => Boolean(normalizedPackages[index]?.insuredValue));
  if (hasExplicitInsuranceValues) {
    if (hasPositiveInsuranceValue) {
      const currentProvider = normalizeId(raw.insurance_provider || raw.insuranceProvider).toLowerCase();
      payload.insurance_provider = currentProvider && currentProvider !== 'none'
        ? (raw.insurance_provider || raw.insuranceProvider)
        : 'carrier';
      const fallbackCurrency = normalizeId(
        normalizedPackages.find((pkg) => pkg.insuredValue)?.insuredValue?.currency || 'GBP'
      ).toUpperCase() || 'GBP';
      payload.packages = payload.packages.map((pkg, index) => ({
        ...pkg,
        ...(hasPositivePackageInsurance(pkg)
          ? {}
          : {
              insured_value: normalizedPackages[index]?.insuredValue || {
                amount: 0,
                currency: fallbackCurrency,
              },
            }),
      }));
    } else {
      payload.insurance_provider = 'none';
    }
  }

  return payload;
}

function buildShipmentWeightUpdatePayload(existingShipment, weightGrams, packageDimensions = null) {
  return buildShipmentPackagesUpdatePayload(existingShipment, [{
    weightGrams,
    dimensions: packageDimensions,
  }]);
}

async function updateShipmentPackages({ shipmentId, packages = [] }) {
  const safeShipmentId = normalizeId(shipmentId);
  const normalizedPackages = normalizePackageUpdateEntries(packages);
  if (!safeShipmentId) throw new Error('Missing ShipStation shipment id.');
  if (!normalizedPackages.length) {
    throw new Error('Enter valid package weights and dimensions.');
  }

  console.log('[ShipStation rate check] Loading shipment before package update', {
    shipmentId: safeShipmentId,
    packageCount: normalizedPackages.length,
    packages: normalizedPackages,
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
    shipDate: existingShipment?.shipDate || '',
    packageCount: existingShipment?.packages?.length || 0,
  });

  const payload = buildShipmentPackagesUpdatePayload(existingShipment, normalizedPackages);
  console.log('[ShipStation rate check] Updating shipment packages', {
    shipmentId: safeShipmentId,
    existingShipDate: existingShipment?.shipDate || '',
    submittedShipDate: payload.ship_date || '',
    shipDateTimeZone: getShipDateTimeZone(),
    packageCount: payload.packages?.length || 0,
    packages: (payload.packages || []).map((pkg) => ({
      packageCode: pkg.package_code || '',
      weight: pkg.weight || null,
      dimensions: pkg.dimensions || null,
      insuredValue: pkg.insured_value || null,
      externalPackageId: pkg.external_package_id || '',
    })),
    carrierIdPresent: Boolean(payload.carrier_id),
    serviceCode: payload.service_code || '',
    requestedShipmentService: payload.requested_shipment_service || '',
  });
  console.log('[ShipStation rate check] ShipStation shipment PUT body', {
    method: 'PUT',
    path: `/v2/shipments/${safeShipmentId}`,
    body: payload,
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
    shipDate: normalizedUpdated?.shipDate || '',
    packageWeights: (normalizedUpdated?.packages || []).map((pkg) => pkg.weight).filter(Boolean),
    packageDimensions: (normalizedUpdated?.packages || []).map((pkg) => pkg.dimensions).filter(Boolean),
    packageInsuredValues: (normalizedUpdated?.packages || []).map((pkg) => pkg.insuredValue).filter(Boolean),
    packageCount: normalizedUpdated?.packages?.length || 0,
  });

  return normalizedUpdated;
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

  return updateShipmentPackages({
    shipmentId: safeShipmentId,
    packages: [{
      weightGrams: safeWeightGrams,
      dimensions: normalizedPackageDimensions,
    }],
  });
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

function normalizeDiagnosticMessageList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap(normalizeDiagnosticMessageList).filter(Boolean);
  }
  if (typeof value === 'object') {
    const message = normalizeId(value.message || value.error || value.detail || value.reason || value.code);
    return message ? [message] : [JSON.stringify(value)];
  }
  return [normalizeId(value)].filter(Boolean);
}

function summarizeInvalidRateForDiagnostics(rate) {
  if (!rate || typeof rate !== 'object') return { raw: rate };
  return {
    carrierCode: normalizeId(rate.carrier_code || rate.carrierCode),
    carrierName: normalizeId(rate.carrier_friendly_name || rate.carrierFriendlyName || rate.carrier_nickname),
    serviceCode: normalizeId(rate.service_code || rate.serviceCode),
    serviceName: normalizeId(rate.service_type || rate.serviceType),
    packageCode: normalizeId(rate.package_code || rate.packageCode),
    validationStatus: normalizeId(rate.validation_status || rate.validationStatus),
    errors: normalizeDiagnosticMessageList(rate.error_messages || rate.errors || rate.messages),
    warnings: normalizeDiagnosticMessageList(rate.warning_messages || rate.warnings),
    raw: rate,
  };
}

function buildRateDiagnostics({
  shipmentId,
  carrierId,
  selectedServiceCode,
  packageCode,
  preferredCurrency,
  ratesPath,
  ratesBody,
  payload,
  rawRates,
  normalizedRates,
  validRates,
  invalidRates,
}) {
  const responseErrors = normalizeDiagnosticMessageList(payload?.errors || payload?.rate_response?.errors);
  return {
    request: {
      method: 'POST',
      url: buildShipStationUrl(ratesPath),
      body: ratesBody,
    },
    context: {
      shipmentId,
      carrierId,
      selectedServiceCode,
      packageCode,
      preferredCurrency,
    },
    response: {
      rawResponseKeys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
      rateResponseStatus: normalizeId(payload?.rate_response?.status || payload?.status),
      errors: responseErrors,
      rawErrors: payload?.errors || payload?.rate_response?.errors || null,
    },
    counts: {
      rawRateCount: rawRates.length,
      normalizedRateCount: normalizedRates.length,
      validRateCount: validRates.length,
      invalidRateCount: invalidRates.length,
    },
    rates: normalizedRates.map(summarizeRateForLog),
    invalidRates: invalidRates.map(summarizeInvalidRateForDiagnostics),
  };
}

function buildShipStationErrorDiagnostics(err, fallback = {}) {
  return {
    request: {
      method: err?.method || fallback.method || '',
      url: err?.url || fallback.url || '',
      body: fallback.body || null,
    },
    context: fallback.context || null,
    response: {
      status: err?.status || null,
      errors: normalizeDiagnosticMessageList(err?.data?.errors || err?.data?.error || err?.data?.message || err?.message),
      rawErrors: err?.data || null,
    },
  };
}

async function getShipmentRatesDetailed(shipmentId, {
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
    const err = new Error('ShipStation shipment is missing carrier_id, so rates cannot be generated.');
    err.rateDiagnostics = {
      context: {
        shipmentId: safeShipmentId,
        carrierId: safeCarrierId,
        selectedServiceCode: safeSelectedServiceCode,
        packageCode: safePackageCode,
        preferredCurrency: safePreferredCurrency,
      },
      response: {
        errors: ['ShipStation shipment is missing carrier_id. Select a carrier/service in ShipStation or ask management to set better defaults.'],
      },
    };
    throw err;
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

  let payload;
  try {
    payload = await shipStationRequest(ratesPath, {
      method: 'POST',
      body: ratesBody,
    });
  } catch (err) {
    err.rateDiagnostics = buildShipStationErrorDiagnostics(err, {
      method: 'POST',
      url: buildShipStationUrl(ratesPath),
      body: ratesBody,
      context: {
        shipmentId: safeShipmentId,
        carrierId: safeCarrierId,
        selectedServiceCode: safeSelectedServiceCode,
        packageCode: safePackageCode,
        preferredCurrency: safePreferredCurrency,
      },
    });
    throw err;
  }
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
  const diagnostics = buildRateDiagnostics({
    shipmentId: safeShipmentId,
    carrierId: safeCarrierId,
    selectedServiceCode: safeSelectedServiceCode,
    packageCode: safePackageCode,
    preferredCurrency: safePreferredCurrency,
    ratesPath,
    ratesBody,
    payload,
    rawRates,
    normalizedRates,
    validRates,
    invalidRates,
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

  return {
    rates: validRates,
    diagnostics,
  };
}

async function getShipmentRates(shipmentId, options = {}) {
  const result = await getShipmentRatesDetailed(shipmentId, options);
  return result.rates;
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
    packages: Array.isArray(label.packages)
      ? label.packages.map((pkg, index) => ({
          packageId: normalizeId(pkg.package_id || pkg.packageId || pkg.id),
          packageCode: normalizeId(pkg.package_code || pkg.packageCode),
          sequence: Number(pkg.sequence || index + 1),
          trackingNumber: normalizeId(pkg.tracking_number || pkg.trackingNumber),
          weight: normalizePackageWeight(pkg.weight),
          dimensions: normalizePackageDimensions(pkg.dimensions),
          insuredValue: normalizeMoney(pkg.insured_value || pkg.insuredValue),
          labelUrl: getLabelDownloadUrl(pkg),
        }))
      : [],
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
  const payload = await shipStationRequest(`/v2/labels/${encodeURIComponent(normalizeId(labelId))}`, {
    query: {
      label_download_type: 'url',
    },
  });
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
  const download = await shipStationRequest(safeUrl, { raw: true });
  const contentType = String(download.contentType || '').trim().toLowerCase();
  if (contentType && !contentType.includes('pdf') && !contentType.includes('octet-stream')) {
    throw new Error(`ShipStation label download returned ${contentType}, not a printable PDF.`);
  }
  return download;
}

module.exports = {
  buildOrderLookupIdentifiers,
  getShipmentById,
  getShipmentRates,
  getShipmentRatesDetailed,
  listCarrierPackageTypes,
  listPackageTypesForShipment,
  listLabelsForShipment,
  lookupShipmentForOrder,
  purchaseLabelForRate,
  voidLabelById,
  downloadLabelBuffer,
  getLabelById,
  updateShipmentPackages,
  updateShipmentWeight,
};
