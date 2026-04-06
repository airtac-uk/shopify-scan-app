const TRACKER_STAGES = {
  received: {
    key: 'received',
    label: 'Order received',
    description: 'We have your order and it is in the queue.',
    tone: 'info',
    progress: 0.08,
    isTerminal: false,
    milestoneIndex: 0,
  },
  queued: {
    key: 'queued',
    label: 'Queued for build',
    description: 'Your order has reached the workshop queue.',
    tone: 'active',
    progress: 0.28,
    isTerminal: false,
    milestoneIndex: 1,
  },
  building: {
    key: 'building',
    label: 'Being built',
    description: 'Parts are being built and prepared for the next stage.',
    tone: 'active',
    progress: 0.44,
    isTerminal: false,
    milestoneIndex: 1,
  },
  awaiting_parts: {
    key: 'awaiting_parts',
    label: 'Waiting on parts',
    description: 'We are waiting on one or more parts before the build can continue.',
    tone: 'warn',
    progress: 0.36,
    isTerminal: false,
    milestoneIndex: 1,
  },
  quality_check: {
    key: 'quality_check',
    label: 'Quality check',
    description: 'The build is complete and is going through quality checks.',
    tone: 'active',
    progress: 0.64,
    isTerminal: false,
    milestoneIndex: 2,
  },
  rebuild: {
    key: 'rebuild',
    label: 'Rebuild in progress',
    description: 'We found something worth improving and are rebuilding it before shipping.',
    tone: 'warn',
    progress: 0.58,
    isTerminal: false,
    milestoneIndex: 2,
  },
  passed_qc: {
    key: 'passed_qc',
    label: 'Quality approved',
    description: 'Quality checks are complete and the order is moving toward packing.',
    tone: 'good',
    progress: 0.76,
    isTerminal: false,
    milestoneIndex: 2,
  },
  packaged: {
    key: 'packaged',
    label: 'Packed',
    description: 'Your order is packed and waiting to leave us.',
    tone: 'good',
    progress: 0.9,
    isTerminal: false,
    milestoneIndex: 3,
  },
  on_hold: {
    key: 'on_hold',
    label: 'On hold',
    description: 'The order is on hold while we review something internally.',
    tone: 'hold',
    progress: 0.32,
    isTerminal: false,
    milestoneIndex: 1,
  },
  fulfilled: {
    key: 'fulfilled',
    label: 'Fulfilled',
    description: 'This order has been fulfilled.',
    tone: 'complete',
    progress: 1,
    isTerminal: true,
    milestoneIndex: 4,
  },
  partially_fulfilled: {
    key: 'partially_fulfilled',
    label: 'Partially fulfilled',
    description: 'Part of this order has already been fulfilled.',
    tone: 'complete',
    progress: 0.96,
    isTerminal: false,
    milestoneIndex: 4,
  },
  cancelled: {
    key: 'cancelled',
    label: 'Cancelled',
    description: 'This order has been cancelled.',
    tone: 'cancelled',
    progress: 1,
    isTerminal: true,
    milestoneIndex: 4,
  },
  restocked: {
    key: 'restocked',
    label: 'Closed',
    description: 'This order has already been completed and restocked.',
    tone: 'complete',
    progress: 1,
    isTerminal: true,
    milestoneIndex: 4,
  },
};

const TAG_TO_STAGE_KEY = {
  racked_up: 'queued',
  wholesale_adapter_built: 'building',
  awaiting_parts: 'awaiting_parts',
  waiting_qc: 'quality_check',
  qc_fail: 'rebuild',
  qc_passed: 'passed_qc',
  packaged: 'packaged',
  on_hold: 'on_hold',
};

const FULFILLMENT_STATUS_TO_STAGE_KEY = {
  FULFILLED: 'fulfilled',
  PARTIALLY_FULFILLED: 'partially_fulfilled',
  RESTOCKED: 'restocked',
};

const QUOTES_BY_STAGE = {
  received: [
    'The workshop clipboard has accepted the quest.',
    'Your order has officially joined the queue and is acting very important.',
    'Fresh order energy detected.',
  ],
  queued: [
    'Your parts are standing by with their tiny hard hats on.',
    'The build bench has your order on its radar.',
    'The workshop playlist has acknowledged your existence.',
  ],
  building: [
    'Somewhere in the workshop, useful noises are happening.',
    'Your order is currently in its montage sequence.',
    'A respectable amount of tinkering is underway.',
  ],
  awaiting_parts: [
    'One critical component is making a dramatic entrance later than planned.',
    'A small but important part is currently on its own side quest.',
    'The build is paused while we wait for the missing hero to arrive.',
  ],
  quality_check: [
    'The quality-check clipboard brigade has entered the chat.',
    'Your order is being inspected with healthy suspicion.',
    'We are doing the careful bit now.',
  ],
  rebuild: [
    'We spotted something we did not love, so we are making it better.',
    'A second pass is in motion because good enough is not the target.',
    'The build has looped back for an encore.',
  ],
  passed_qc: [
    'The nod of approval has been firmly nodded.',
    'Quality checks are happy and therefore we are happy.',
    'The approval stamp has landed.',
  ],
  packaged: [
    'Cardboard engineering is now part of the process.',
    'Your order is dressed for travel.',
    'Packing tape has entered the arena.',
  ],
  on_hold: [
    'Your order is paused while we untangle something important.',
    'The tracker is holding position while we review the next step.',
    'A brief pause, not a forgotten order.',
  ],
  fulfilled: [
    'Mission complete. The package has left the nest.',
    'The tracker has reached the end credits.',
    'This order has graduated from workshop life.',
  ],
  partially_fulfilled: [
    'Part of the mission is complete and the rest is catching up.',
    'Progress is already in motion.',
    'This order is mid handoff.',
  ],
  cancelled: [
    'This order has stepped off the ride before the final lap.',
    'The tracker has been retired from active duty.',
    'No further workshop shenanigans for this one.',
  ],
  restocked: [
    'This order has already had its full dramatic arc.',
    'The tracker is effectively in the post-credits scene.',
    'Workshop chapter complete.',
  ],
};

const ORDER_NOTE_STAGE_RULES = [
  { pattern: /ORDER READY TO BE BUILT/i, stageKey: 'queued' },
  { pattern: /WHOLESALE ADAPTER BUILT/i, stageKey: 'building' },
  { pattern: /ORDER BUILT\s*-\s*AWAITING QUALITY CHECKS/i, stageKey: 'quality_check' },
  { pattern: /QUALITY CHECKS PASSED\s*-\s*AWAITING SHIPPING/i, stageKey: 'passed_qc' },
  { pattern: /QUALITY CHECKS ESCALATED\s*-\s*AWAITING REBUILD/i, stageKey: 'rebuild' },
  { pattern: /ORDER PACKAGED\s*-\s*AWAITING COURIER COLLECTION/i, stageKey: 'packaged' },
  { pattern: /^AWAITING PARTS\b/i, stageKey: 'awaiting_parts' },
  { pattern: /^QC FAIL\b/i, stageKey: 'rebuild' },
  { pattern: /^ON HOLD\b/i, stageKey: 'on_hold' },
];

function normalizeTag(value) {
  return String(value || '').trim().toLowerCase();
}

function formatHumanLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function getTrackerStageByKey(stageKey) {
  return TRACKER_STAGES[stageKey] || TRACKER_STAGES.received;
}

function splitOrderNoteSegments(orderNote) {
  const text = String(orderNote || '').trim();
  if (!text) return [];

  return text
    .split('~')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function parseOrderNoteTimestamp(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return null;

  const normalized = value.replace(' ', 'T');
  const candidate = normalized.includes('T') ? normalized : `${normalized}T00:00`;
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function extractStageKeyFromOrderNoteHeadline(headline) {
  const normalizedHeadline = String(headline || '').trim();
  if (!normalizedHeadline) return null;

  const matchedRule = ORDER_NOTE_STAGE_RULES.find((rule) => rule.pattern.test(normalizedHeadline));
  return matchedRule?.stageKey || null;
}

function extractTrackerEventsFromOrderNote(orderNote) {
  return splitOrderNoteSegments(orderNote)
    .map((segment) => {
      const lines = segment
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      if (!lines.length) return null;

      const headline = lines[0];
      const headlineMatch = headline.match(/^(.*?)(?:\s+[—-]\s+)(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})$/);
      const headlineText = headlineMatch?.[1]?.trim() || headline;
      const timestampText = headlineMatch?.[2]?.trim() || '';
      const stageKey = extractStageKeyFromOrderNoteHeadline(headlineText);
      if (!stageKey) return null;

      const timestamp = parseOrderNoteTimestamp(timestampText);
      const stage = getTrackerStageByKey(stageKey);
      const details = lines.slice(1);
      const extraDetailLines = details.filter((line) => !/^Team Member:/i.test(line));
      const description = extraDetailLines.length > 0
        ? extraDetailLines.join(' ')
        : stage.description;

      return {
        stageKey: stage.key,
        stageLabel: stage.label,
        stageDescription: description,
        createdAt: timestamp,
        sourceTag: 'order_note',
      };
    })
    .filter(Boolean);
}

function deriveTrackerStage({ explicitTag, tags, cancelledAt, displayFulfillmentStatus, orderNote }) {
  if (cancelledAt) {
    return TRACKER_STAGES.cancelled;
  }

  const fulfillmentStageKey = FULFILLMENT_STATUS_TO_STAGE_KEY[String(displayFulfillmentStatus || '').trim().toUpperCase()];
  if (fulfillmentStageKey) {
    return getTrackerStageByKey(fulfillmentStageKey);
  }

  const explicitStageKey = TAG_TO_STAGE_KEY[normalizeTag(explicitTag)];
  if (explicitStageKey) {
    return getTrackerStageByKey(explicitStageKey);
  }

  const normalizedTags = Array.isArray(tags)
    ? tags.map((tag) => normalizeTag(tag)).filter(Boolean)
    : String(tags || '')
        .split(',')
        .map((tag) => normalizeTag(tag))
        .filter(Boolean);

  const foundTag = normalizedTags.find((tag) => TAG_TO_STAGE_KEY[tag]);
  if (foundTag) {
    return getTrackerStageByKey(TAG_TO_STAGE_KEY[foundTag]);
  }

  const noteEvents = extractTrackerEventsFromOrderNote(orderNote);
  if (noteEvents.length > 0) {
    const latestEvent = noteEvents[noteEvents.length - 1];
    return getTrackerStageByKey(latestEvent.stageKey);
  }

  return TRACKER_STAGES.received;
}

function normalizeTrackerLineItems(lineItems) {
  return (lineItems || [])
    .map((item) => {
      const quantity = Math.max(0, Number(item?.quantity) || 0);
      if (quantity <= 0) return null;

      return {
        title: String(item?.title || '').trim() || 'Item',
        variantTitle: String(item?.variantTitle || '').trim(),
        sku: String(item?.sku || '').trim(),
        quantity,
      };
    })
    .filter(Boolean);
}

function buildTips(lineItems, currentStageKey) {
  const haystack = normalizeTrackerLineItems(lineItems)
    .map((item) => `${item.title} ${item.variantTitle} ${item.sku}`.toUpperCase())
    .join(' ');

  const tips = [];

  if (currentStageKey === 'awaiting_parts') {
    tips.push('Tip: if you need the order for a specific game day, leave a little buffer for final dispatch.');
  }
  if (currentStageKey === 'quality_check' || currentStageKey === 'rebuild') {
    tips.push('Tip: this stage is where we slow down on purpose so the order leaves in the right condition.');
  }

  const keywordRules = [
    {
      matches: ['HPA', 'ADAPTER'],
      tip: 'Tip: when your order arrives, check airline routing and fittings before your first game day.',
    },
    {
      matches: ['SHELL', 'SHOTGUN'],
      tip: 'Tip: a few dry runs with your shell setup can make the first field day much smoother.',
    },
    {
      matches: ['LINE', 'SUPERCOIL'],
      tip: 'Tip: keep lines in a relaxed curve rather than a tight bend for a cleaner setup.',
    },
    {
      matches: ['BASEPLATE', 'GRIP'],
      tip: 'Tip: first-time fit checks are easiest over a soft surface with good lighting.',
    },
    {
      matches: ['CNC', 'ALUMINIUM', 'ALUMINUM'],
      tip: 'Tip: keep the original packaging until you are happy with fitment and finish.',
    },
  ];

  keywordRules.forEach((rule) => {
    if (rule.matches.some((match) => haystack.includes(match)) && !tips.includes(rule.tip)) {
      tips.push(rule.tip);
    }
  });

  if (!tips.length) {
    tips.push('Tip: keep your order packaging until you have checked fitment and contents.');
    tips.push('Tip: a quick photo of the parts on arrival makes future support much easier if you need it.');
  }

  return tips.slice(0, 3);
}

function selectQuote(stageKey, seedValue) {
  const pool = QUOTES_BY_STAGE[stageKey] || QUOTES_BY_STAGE.received;
  const seed = String(seedValue || '');
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }

  const index = Math.abs(hash) % pool.length;
  return pool[index];
}

function buildMilestones(currentStageKey) {
  const stage = getTrackerStageByKey(currentStageKey);
  const finalLabel = currentStageKey === 'cancelled'
    ? 'Cancelled'
    : currentStageKey === 'fulfilled'
      ? 'Fulfilled'
      : currentStageKey === 'partially_fulfilled'
        ? 'Part Fulfilled'
        : 'Complete';

  const milestones = [
    { key: 'received', label: 'Order Placed' },
    { key: 'workshop', label: 'In Workshop' },
    { key: 'quality', label: 'Quality Check' },
    { key: 'packed', label: 'Packed' },
    { key: 'complete', label: finalLabel },
  ];

  return milestones.map((milestone, index) => ({
    ...milestone,
    state: index < stage.milestoneIndex
      ? 'done'
      : index === stage.milestoneIndex
        ? 'current'
        : 'todo',
  }));
}

function buildPublicTrackerPayload(trackerRecord, options = {}) {
  const currentStage = getTrackerStageByKey(trackerRecord?.currentStageKey);
  const items = normalizeTrackerLineItems(trackerRecord?.lineItems);
  const trackingLinks = Array.isArray(options.trackingLinks)
    ? options.trackingLinks
        .map((trackingLink) => ({
          company: String(trackingLink?.company || '').trim(),
          number: String(trackingLink?.number || '').trim(),
          url: String(trackingLink?.url || '').trim(),
        }))
        .filter((trackingLink) => trackingLink.url)
    : [];
  const timeline = Array.isArray(trackerRecord?.events)
    ? trackerRecord.events.map((event) => ({
        stageKey: String(event.stageKey || '').trim(),
        title: String(event.stageLabel || '').trim() || 'Order update',
        description: String(event.stageDescription || '').trim(),
        createdAt: event.createdAt,
      }))
    : [];

  return {
    orderNumber: String(trackerRecord?.orderNumber || '').trim(),
    barcode: String(trackerRecord?.barcode || '').trim(),
    updatedAt: trackerRecord?.updatedAt || null,
    orderCreatedAt: trackerRecord?.orderCreatedAt || null,
    workflowStatus: trackerRecord?.workflowStatus || null,
    currentStage: {
      key: currentStage.key,
      label: currentStage.label,
      description: currentStage.description,
      tone: currentStage.tone,
      progress: currentStage.progress,
      isTerminal: currentStage.isTerminal,
    },
    milestones: buildMilestones(currentStage.key),
    items,
    trackingLinks,
    tips: buildTips(items, currentStage.key),
    quote: selectQuote(currentStage.key, `${trackerRecord?.orderNumber || ''}:${trackerRecord?.updatedAt || ''}`),
    timeline,
  };
}

module.exports = {
  TRACKER_STAGES,
  formatHumanLabel,
  deriveTrackerStage,
  extractTrackerEventsFromOrderNote,
  normalizeTrackerLineItems,
  buildPublicTrackerPayload,
};
