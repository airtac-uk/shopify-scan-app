const HYP_AR_STAGES = [
  {
    key: 'op1',
    label: 'OP1',
    tone: 'active',
    progress: 0.16,
    reggieDescription: 'In OP1, we\'re machining the majority of your receiver from 7075 aluminium. This takes 2h30m and uses 21 different tools.',
  },
  {
    key: 'op2',
    label: 'OP2',
    tone: 'active',
    progress: 0.32,
    reggieDescription: 'We\'ve flipped your receiver upside down to machine the magwell and airline route. This takes 15 minutes. At this stage we ensure perfect magazine fitment.',
  },
  {
    key: 'cerakote_prep',
    label: 'Cerakote Prep',
    tone: 'active',
    progress: 0.48,
    reggieDescription: 'We thoroughly degrease your receiver, and then blast it with aluminium oxide to remove any toolmarks and create a uniform surface for cerakote to adhere to.',
  },
  {
    key: 'cerakote',
    label: 'Cerakote',
    tone: 'active',
    progress: 0.64,
    reggieDescription: 'We are coating the part in the colour of your choice.',
  },
  {
    key: 'ready_to_build',
    label: 'Ready to Build',
    tone: 'good',
    progress: 0.82,
    reggieDescription: 'We re-ream the pin holes back to tolerance after coating and assemble your receiver.',
  },
  {
    key: 'built',
    label: 'Built',
    tone: 'complete',
    progress: 0.94,
    reggieDescription: 'All done. All that is left is to package and ship your receiver.',
  },
];

const HYP_AR_STAGE_BY_KEY = HYP_AR_STAGES.reduce((acc, stage, index) => {
  acc[stage.key] = { ...stage, index };
  return acc;
}, {});

const SHOPIFY_TERMINAL_FULFILLMENT_STATUSES = new Set(['FULFILLED', 'RESTOCKED']);

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeSkuValue(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeHypArStageKey(value) {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (normalized === 'cerakoteprep') return 'cerakote_prep';
  if (normalized === 'ready' || normalized === 'ready_build' || normalized === 'ready_to_assemble') {
    return 'ready_to_build';
  }

  return HYP_AR_STAGE_BY_KEY[normalized] ? normalized : 'op1';
}

function getHypArStage(value) {
  return HYP_AR_STAGE_BY_KEY[normalizeHypArStageKey(value)] || HYP_AR_STAGE_BY_KEY.op1;
}

function getHypArStageIndex(stageKey) {
  return getHypArStage(stageKey).index;
}

function isHypArLineItem(item = {}) {
  const haystack = [
    item.sku,
    item.title,
    item.variantTitle,
  ].map(normalizeText).join(' ');
  const compact = haystack.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return compact.includes('HYPAR');
}

function buildHypArReceiverUnits(lineItems = []) {
  return (Array.isArray(lineItems) ? lineItems : [])
    .filter(isHypArLineItem)
    .flatMap((item, itemIndex) => {
      const quantity = Math.max(0, Math.floor(Number(item?.quantity) || 0));
      const sku = normalizeSkuValue(item?.sku);
      const title = normalizeText(item?.title);
      const variantTitle = normalizeText(item?.variantTitle);
      const lineItemId = normalizeText(item?.id) || `line-${itemIndex + 1}-${sku || title}`;

      return Array.from({ length: quantity }, (_unit, unitIndex) => ({
        sourceKey: `${lineItemId}:${unitIndex + 1}`,
        lineItemId,
        unitIndex: unitIndex + 1,
        sku,
        title,
        variantTitle,
      }));
    })
    .filter((unit) => unit.sourceKey && unit.sku);
}

function getShopifyWorkflowStatus(order = {}) {
  if (order?.cancelledAt) return 'CANCELLED';
  return normalizeText(order?.displayFulfillmentStatus || order?.fulfillmentStatus).toUpperCase();
}

function getHypArArchiveReasonForOrder(order = {}) {
  const workflowStatus = getShopifyWorkflowStatus(order);
  if (workflowStatus === 'CANCELLED') return 'cancelled';
  if (SHOPIFY_TERMINAL_FULFILLMENT_STATUSES.has(workflowStatus)) return 'fulfilled';
  return '';
}

function isHypArOrderTerminal(order = {}) {
  return Boolean(getHypArArchiveReasonForOrder(order));
}

function formatReceiverCodeList(codes = []) {
  const safeCodes = codes.map(normalizeText).filter(Boolean);
  if (safeCodes.length <= 1) return safeCodes[0] || '';
  if (safeCodes.length === 2) return `${safeCodes[0]} and ${safeCodes[1]}`;
  return `${safeCodes.slice(0, -1).join(', ')}, and ${safeCodes[safeCodes.length - 1]}`;
}

function getReceiverStageKey(receiver = {}) {
  return normalizeHypArStageKey(receiver.currentStageKey);
}

function isReceiverArchived(receiver = {}) {
  return Boolean(normalizeText(receiver.archivedAt));
}

function buildHypArStageCounts(receivers = []) {
  const counts = HYP_AR_STAGES.reduce((acc, stage) => {
    acc[stage.key] = {
      key: stage.key,
      label: stage.label,
      count: 0,
    };
    return acc;
  }, {});

  (Array.isArray(receivers) ? receivers : []).forEach((receiver) => {
    if (isReceiverArchived(receiver)) return;
    const stage = getHypArStage(receiver.currentStageKey);
    counts[stage.key].count += 1;
  });

  return HYP_AR_STAGES.map((stage) => counts[stage.key]);
}

function buildHypArOp1SkuSummary(receivers = []) {
  const bySku = new Map();

  (Array.isArray(receivers) ? receivers : []).forEach((receiver) => {
    if (isReceiverArchived(receiver)) return;
    if (getReceiverStageKey(receiver) !== 'op1') return;

    const sku = normalizeSkuValue(receiver.sku);
    if (!sku) return;

    const current = bySku.get(sku) || {
      sku,
      title: normalizeText(receiver.title),
      quantity: 0,
      orders: new Set(),
      receiverCodes: [],
    };
    current.quantity += 1;
    if (receiver.orderNumber) current.orders.add(normalizeText(receiver.orderNumber));
    if (receiver.receiverCode) current.receiverCodes.push(normalizeText(receiver.receiverCode));
    bySku.set(sku, current);
  });

  return Array.from(bySku.values())
    .map((item) => ({
      sku: item.sku,
      title: item.title,
      quantity: item.quantity,
      orderCount: item.orders.size,
      receiverCodes: item.receiverCodes,
    }))
    .sort((left, right) => {
      const quantityDiff = right.quantity - left.quantity;
      return quantityDiff || left.sku.localeCompare(right.sku);
    });
}

function selectHypArPublicStage(receivers = []) {
  const activeReceivers = (Array.isArray(receivers) ? receivers : [])
    .filter((receiver) => !isReceiverArchived(receiver));
  if (!activeReceivers.length) return null;

  return activeReceivers
    .slice()
    .sort((left, right) => {
      const stageDiff = getHypArStageIndex(left.currentStageKey) - getHypArStageIndex(right.currentStageKey);
      if (stageDiff !== 0) return stageDiff;
      return normalizeText(left.receiverCode).localeCompare(normalizeText(right.receiverCode));
    })[0];
}

function buildHypArPublicMilestones(stageKey) {
  const currentIndex = getHypArStageIndex(stageKey);
  return HYP_AR_STAGES.map((stage, index) => ({
    key: `hyp_${stage.key}`,
    label: stage.label,
    state: index < currentIndex
      ? 'done'
      : index === currentIndex
        ? 'current'
        : 'todo',
  }));
}

function getLatestTimestamp(...values) {
  return values
    .flat()
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .sort()
    .pop() || null;
}

function buildHypArPublicProduction({ receivers = [], events = [] } = {}) {
  const selectedReceiver = selectHypArPublicStage(receivers);
  if (!selectedReceiver) return null;

  const selectedStage = getHypArStage(selectedReceiver.currentStageKey);
  const activeReceivers = (Array.isArray(receivers) ? receivers : [])
    .filter((receiver) => !isReceiverArchived(receiver));
  const matchingStageReceivers = activeReceivers
    .filter((receiver) => getReceiverStageKey(receiver) === selectedStage.key);
  const codes = matchingStageReceivers
    .map((receiver) => normalizeText(receiver.receiverCode))
    .filter(Boolean);
  const codeText = formatReceiverCodeList(codes);
  const receiverLabel = codes.length === 1
    ? `Your HYP-AR receiver ${codeText} is in ${selectedStage.label}.`
    : `${codes.length} HYP-AR receivers in this order are in ${selectedStage.label}.`;
  const updatedAt = getLatestTimestamp(
    activeReceivers.map((receiver) => receiver.updatedAt),
    events.map((event) => event.createdAt)
  );

  const timeline = (Array.isArray(events) ? events : [])
    .map((event) => {
      const stage = getHypArStage(event.stageKey);
      const code = normalizeText(event.receiverCode);
      const staff = normalizeText(event.staff);
      return {
        stageKey: `hyp_${stage.key}`,
        title: `${code ? `${code}: ` : ''}${stage.label}`,
        description: staff
          ? `${stage.reggieDescription} Updated by ${staff}.`
          : stage.reggieDescription,
        createdAt: event.createdAt || null,
      };
    })
    .filter((event) => event.createdAt);

  return {
    currentStage: {
      key: `hyp_${selectedStage.key}`,
      label: `HYP-AR ${selectedStage.label}`,
      description: `${receiverLabel} ${selectedStage.reggieDescription}`,
      tone: selectedStage.tone,
      progress: selectedStage.progress,
      isTerminal: false,
    },
    milestones: buildHypArPublicMilestones(selectedStage.key),
    updatedAt,
    timeline,
  };
}

module.exports = {
  HYP_AR_STAGES,
  HYP_AR_STAGE_BY_KEY,
  normalizeHypArStageKey,
  getHypArStage,
  getHypArStageIndex,
  isHypArLineItem,
  buildHypArReceiverUnits,
  getShopifyWorkflowStatus,
  getHypArArchiveReasonForOrder,
  isHypArOrderTerminal,
  buildHypArStageCounts,
  buildHypArOp1SkuSummary,
  buildHypArPublicProduction,
};
