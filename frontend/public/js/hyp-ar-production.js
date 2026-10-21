const HYP_PRODUCTION_POLL_MS = 60000;
const HYP_PRODUCTION_VIEW_KEY = 'hyp-ar-production-view';

let hypProductionData = null;
let hypProductionLoading = false;
let hypProductionSyncing = false;
let hypProductionPollId = null;
let hypProductionSyncPollId = null;
let hypStageFilter = '';
let hypProductionView = 'table';
let hypPendingAction = null;
let hypRecentReceiverId = '';
let hypRecentReceiverTimeout = null;
let hypFeedbackTimeout = null;
let hypDraggedReceiverId = '';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}

function formatTimestamp(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatDatePlaced(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function formatAuditTimestamp(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function formatStatusLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function normalizeHypActionType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || 'stage_changed';
}

function getHypActionText(event = {}) {
  const actionType = normalizeHypActionType(event.actionType);
  const receiverCode = String(event.receiverCode || '').trim() || 'HYP receiver';
  const stageLabel = String(event.stageLabel || '').trim() || formatStatusLabel(event.stageKey);
  const previousStageLabel = String(event.previousStageLabel || '').trim();

  if (actionType === 'created') {
    return `${receiverCode} added at ${stageLabel}`;
  }

  if (actionType === 'deleted') {
    return `${receiverCode} deleted from tracker`;
  }

  if (actionType === 'stage_changed') {
    return previousStageLabel
      ? `${receiverCode} moved from ${previousStageLabel} to ${stageLabel}`
      : `${receiverCode} moved to ${stageLabel}`;
  }

  return `${receiverCode} updated`;
}

function getHypActionTone(event = {}) {
  const actionType = normalizeHypActionType(event.actionType);
  if (actionType === 'deleted') return 'danger';
  if (actionType === 'created') return 'neutral';
  return 'stage';
}

function getSortedHypEvents(events = []) {
  return (Array.isArray(events) ? events : [])
    .slice()
    .sort((left, right) => {
      const leftTime = new Date(left?.createdAt || 0).getTime();
      const rightTime = new Date(right?.createdAt || 0).getTime();
      const timeDiff = (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
      if (timeDiff !== 0) return timeDiff;
      return (Number(right?.id) || 0) - (Number(left?.id) || 0);
    });
}

function getReceiverOrderStatus(receiver = {}) {
  const archiveReason = String(receiver.archiveReason || '').trim().toLowerCase();
  const workflowStatus = String(receiver.workflowStatus || '').trim().toUpperCase();

  if (archiveReason === 'cancelled' || workflowStatus === 'CANCELLED') {
    return { key: 'cancelled', label: 'Cancelled' };
  }

  if (archiveReason === 'manual_deleted') {
    return { key: 'deleted', label: 'Deleted' };
  }

  if (archiveReason === 'fulfilled' || workflowStatus === 'FULFILLED' || workflowStatus === 'RESTOCKED') {
    return { key: 'fulfilled', label: workflowStatus === 'RESTOCKED' ? 'Restocked' : 'Fulfilled' };
  }

  if (workflowStatus === 'PARTIALLY_FULFILLED') {
    return { key: 'partial', label: 'Partially Fulfilled' };
  }

  if (workflowStatus === 'UNFULFILLED') {
    return { key: 'open', label: 'Unfulfilled' };
  }

  return {
    key: receiver.archivedAt ? 'archived' : 'open',
    label: workflowStatus ? formatStatusLabel(workflowStatus) : (receiver.archivedAt ? 'Archived' : 'Open'),
  };
}

function getShowArchived() {
  return Boolean(document.getElementById('hypShowArchived')?.checked);
}

function setStatus(message, type = 'info') {
  const el = document.getElementById('hypProductionStatus');
  if (!el) return;
  el.textContent = message || '';
  el.dataset.type = type;
}

function setLoading(isLoading) {
  hypProductionLoading = Boolean(isLoading);
  const spinner = document.getElementById('hypProductionSpinner');
  const refreshBtn = document.getElementById('hypRefreshBtn');
  const printBtn = document.getElementById('hypPrintActiveBtn');

  if (spinner) spinner.style.display = hypProductionLoading ? 'inline-block' : 'none';
  if (refreshBtn) refreshBtn.disabled = hypProductionLoading;
  if (printBtn) printBtn.disabled = hypProductionLoading;
  const archivedToggle = document.getElementById('hypShowArchived');
  if (archivedToggle) archivedToggle.disabled = hypProductionLoading;
  updateReceiverInteractionState();
}

function updateReceiverInteractionState() {
  document.querySelectorAll('[data-hyp-receiver-id]').forEach((element) => {
    const isPending = String(hypPendingAction?.receiverId) === element.dataset.hypReceiverId;
    const archived = element.dataset.hypArchived === 'true';
    element.classList.toggle('is-updating', isPending);
    element.setAttribute('aria-busy', String(isPending));
    if (element.classList.contains('hyp-queue-card')) {
      element.draggable = !archived && !hypProductionLoading;
    }
    element.querySelectorAll('button').forEach((button) => {
      const isStageButton = Boolean(button.dataset.stageKey);
      const isPendingButton = isPending && (
        (isStageButton && button.dataset.stageKey === hypPendingAction.stageKey)
        || (button.dataset.deleteReceiverId && hypPendingAction.type === 'delete')
      );
      button.disabled = hypProductionLoading || (isStageButton && archived);
      button.classList.toggle('is-pending', Boolean(isPendingButton));
      if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent.trim();
      button.textContent = isPendingButton
        ? (hypPendingAction.type === 'delete' ? 'Deleting…' : 'Moving…')
        : button.dataset.idleLabel;
    });
  });
}

function showActionFeedback(message, type, { stageKey = '' } = {}) {
  clearTimeout(hypFeedbackTimeout);
  const feedback = document.getElementById('hypActionFeedback');
  const messageEl = document.getElementById('hypActionFeedbackMessage');
  const viewButton = document.getElementById('hypFeedbackViewStage');
  const dismissButton = document.getElementById('hypFeedbackDismiss');
  if (!feedback || !messageEl) return;
  feedback.hidden = false;
  feedback.dataset.type = type;
  messageEl.textContent = message;
  if (viewButton) {
    const stage = getStages().find((item) => item.key === stageKey);
    viewButton.hidden = !stage;
    viewButton.dataset.stageKey = stageKey;
    viewButton.textContent = stage ? `View ${stage.label}` : '';
  }
  if (dismissButton) dismissButton.hidden = type === 'loading';
  if (type === 'success') {
    hypFeedbackTimeout = window.setTimeout(() => { feedback.hidden = true; }, 8000);
  }
}

function highlightMovedReceiver(receiverId) {
  clearTimeout(hypRecentReceiverTimeout);
  hypRecentReceiverId = String(receiverId);
  hypRecentReceiverTimeout = window.setTimeout(() => {
    hypRecentReceiverId = '';
    document.querySelectorAll('.is-recently-moved').forEach((element) => {
      element.classList.remove('is-recently-moved');
    });
  }, 5000);
}

function setProductionView(view, { persist = true } = {}) {
  hypProductionView = view === 'board' ? 'board' : 'table';
  const isBoard = hypProductionView === 'board';
  document.getElementById('hypStageFilters').hidden = isBoard;
  document.getElementById('hypReceiverTable').hidden = isBoard;
  document.getElementById('hypQueueView').hidden = !isBoard;
  document.querySelectorAll('[data-hyp-view]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.hypView === hypProductionView));
  });
  if (persist) {
    try { window.localStorage.setItem(HYP_PRODUCTION_VIEW_KEY, hypProductionView); } catch (_) { /* Storage may be unavailable. */ }
  }
  renderReceiverViews();
}

function renderReceiverViews() {
  if (hypProductionView === 'board') {
    renderQueueBoard(hypProductionData?.receivers || []);
  } else {
    renderReceiverTable(getFilteredReceivers());
  }
  updateReceiverInteractionState();
}

function updateLastUpdatedLabel() {
  const el = document.getElementById('hypProductionUpdated');
  if (!el) return;
  el.textContent = `Last refreshed ${formatTimestamp(new Date().toISOString())}`;
}

function buildOrderViewerUrl(orderLookupValue) {
  const normalizedValue = String(orderLookupValue || '').trim();
  if (!normalizedValue) return '/pick_list.html';

  const params = new URLSearchParams();
  params.set('order', normalizedValue);
  return `/pick_list.html?${params.toString()}`;
}

function getStages() {
  return Array.isArray(hypProductionData?.stages) ? hypProductionData.stages : [];
}

function getStageIndex(stageKey) {
  return getStages().findIndex((stage) => stage.key === stageKey);
}

function getActiveReceivers() {
  return (Array.isArray(hypProductionData?.receivers) ? hypProductionData.receivers : [])
    .filter((receiver) => !receiver.archivedAt);
}

function getFilteredReceivers() {
  const receivers = Array.isArray(hypProductionData?.receivers) ? hypProductionData.receivers : [];
  if (!hypStageFilter) return receivers;
  return receivers.filter((receiver) => receiver.currentStageKey === hypStageFilter);
}

function getStageFilterCounts(receivers = []) {
  return (Array.isArray(receivers) ? receivers : []).reduce((acc, receiver) => {
    const key = String(receiver?.currentStageKey || '').trim();
    if (!key) return acc;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildLocalProductionSummary(receivers = []) {
  const safeReceivers = Array.isArray(receivers) ? receivers : [];
  const activeReceivers = safeReceivers.filter((receiver) => !receiver.archivedAt);
  const op1BySkuMap = new Map();

  activeReceivers.forEach((receiver) => {
    if (receiver.currentStageKey !== 'op1') return;
    const sku = String(receiver.sku || '').trim().toUpperCase();
    if (!sku) return;

    const current = op1BySkuMap.get(sku) || {
      sku,
      title: String(receiver.title || '').trim(),
      quantity: 0,
      orders: new Set(),
      receiverCodes: [],
    };
    current.quantity += 1;
    if (receiver.orderNumber) current.orders.add(String(receiver.orderNumber));
    if (receiver.receiverCode) current.receiverCodes.push(String(receiver.receiverCode));
    op1BySkuMap.set(sku, current);
  });

  const stageCounts = getStages().map((stage) => ({
    key: stage.key,
    label: stage.label,
    count: activeReceivers.filter((receiver) => receiver.currentStageKey === stage.key).length,
  }));

  return {
    activeReceiverCount: activeReceivers.length,
    archivedReceiverCount: safeReceivers.filter((receiver) => receiver.archivedAt).length,
    builtReceiverCount: activeReceivers.filter((receiver) => receiver.currentStageKey === 'built').length,
    op1RequiredCount: activeReceivers.filter((receiver) => receiver.currentStageKey === 'op1').length,
    stageCounts,
    op1BySku: Array.from(op1BySkuMap.values())
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
      }),
  };
}

function refreshProductionView({ updateTimestamp = false } = {}) {
  if (!hypProductionData) return;

  const visibleReceivers = Array.isArray(hypProductionData.receivers) ? hypProductionData.receivers : [];
  const summary = buildLocalProductionSummary(visibleReceivers);
  hypProductionData.summary = summary;

  renderOverview(summary);
  renderOp1Summary(summary.op1BySku);
  renderStageFilters(visibleReceivers);
  renderReceiverViews();
  renderActionTimeline(hypProductionData.events || []);
  if (updateTimestamp) updateLastUpdatedLabel();
}

function mergeReceiverIntoProductionData(updatedReceiver) {
  if (!updatedReceiver?.id || !hypProductionData) return false;

  const receivers = Array.isArray(hypProductionData.receivers) ? hypProductionData.receivers : [];
  const index = receivers.findIndex((receiver) => String(receiver.id) === String(updatedReceiver.id));
  if (index < 0) return false;

  hypProductionData.receivers = [
    ...receivers.slice(0, index),
    {
      ...receivers[index],
      ...updatedReceiver,
    },
    ...receivers.slice(index + 1),
  ];
  return true;
}

function removeReceiverFromProductionData(receiverId) {
  if (!receiverId || !hypProductionData) return false;

  const receivers = Array.isArray(hypProductionData.receivers) ? hypProductionData.receivers : [];
  const nextReceivers = receivers.filter((receiver) => String(receiver.id) !== String(receiverId));
  if (nextReceivers.length === receivers.length) return false;

  hypProductionData.receivers = nextReceivers;
  return true;
}

function formatSyncStats(syncStats = {}) {
  if (!syncStats) return 'Shopify sync complete.';
  return `Synced ${syncStats.scannedOpenOrders || 0} open, ${syncStats.scannedHistoricalOrders || 0} recent historical, and ${syncStats.targetedHistoricalOrderCount || 0} targeted HYP Shopify orders; ${(syncStats.receiverCount || 0)} active and ${(syncStats.historicalReceiverCount || 0) + (syncStats.targetedHistoricalReceiverCount || 0)} fulfilled HYP-AR receivers serialised.`;
}

function renderOverview(summary = {}) {
  const container = document.getElementById('hypProductionOverview');
  if (!container) return;

  const stats = [
    { label: 'Active Receivers', value: summary.activeReceiverCount || 0 },
    { label: 'OP1 Required', value: summary.op1RequiredCount || 0 },
    { label: 'Built', value: summary.builtReceiverCount || 0 },
    { label: 'Archived', value: summary.archivedReceiverCount || 0 },
  ];

  container.innerHTML = stats.map((stat) => `
    <article class="hyp-production-stat">
      <p>${escapeHtml(stat.label)}</p>
      <strong>${escapeHtml(stat.value)}</strong>
    </article>
  `).join('');
}

function renderOp1Summary(items = []) {
  const container = document.getElementById('hypOp1Summary');
  if (!container) return;

  const safeItems = Array.isArray(items) ? items : [];
  if (safeItems.length === 0) {
    container.innerHTML = '<p class="pick-list-empty">No HYP-AR receivers are waiting for OP1.</p>';
    return;
  }

  container.innerHTML = `
    <table class="hyp-production-table hyp-production-table--op1">
      <thead>
        <tr>
          <th>Shopify SKU</th>
          <th>Qty</th>
          <th>Orders</th>
          <th>Receiver Codes</th>
        </tr>
      </thead>
      <tbody>
        ${safeItems.map((item) => `
          <tr>
            <td>
              <strong>${escapeHtml(item.sku)}</strong>
              ${item.title ? `<span>${escapeHtml(item.title)}</span>` : ''}
            </td>
            <td>${escapeHtml(item.quantity)}</td>
            <td>${escapeHtml(item.orderCount)}</td>
            <td>${escapeHtml((item.receiverCodes || []).join(', '))}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderStageFilters(receivers = []) {
  const container = document.getElementById('hypStageFilters');
  if (!container) return;

  const stages = getStages();
  const counts = getStageFilterCounts(receivers);
  const totalCount = receivers.length;
  const filters = [
    {
      key: '',
      label: 'All Stages',
      count: totalCount,
    },
    ...stages.map((stage) => ({
      key: stage.key,
      label: stage.label,
      count: counts[stage.key] || 0,
    })),
  ];

  if (hypStageFilter && !filters.some((filter) => filter.key === hypStageFilter)) {
    hypStageFilter = '';
  }

  container.innerHTML = filters.map((filter) => {
    const isActive = filter.key === hypStageFilter;
    return `
      <button
        type="button"
        class="hyp-stage-filter-chip${isActive ? ' is-active' : ''}"
        data-hyp-stage-filter="${escapeHtmlAttribute(filter.key)}"
        aria-pressed="${isActive ? 'true' : 'false'}"
      >
        <span>${escapeHtml(filter.label)}</span>
        <strong>${escapeHtml(filter.count)}</strong>
      </button>
    `;
  }).join('');
}

function renderStageButtons(receiver) {
  const stages = getStages();
  const currentIndex = getStageIndex(receiver.currentStageKey);
  const archived = Boolean(receiver.archivedAt);

  return stages.map((stage, index) => {
    const state = index < currentIndex
      ? 'done'
      : index === currentIndex
        ? 'current'
        : 'todo';
    return `
      <button
        type="button"
        class="hyp-stage-btn hyp-stage-btn--${escapeHtmlAttribute(state)}"
        data-receiver-id="${escapeHtmlAttribute(receiver.id)}"
        data-stage-key="${escapeHtmlAttribute(stage.key)}"
        ${archived || hypProductionLoading ? 'disabled' : ''}
        aria-pressed="${state === 'current' ? 'true' : 'false'}"
      >
        ${escapeHtml(stage.label)}
      </button>
    `;
  }).join('');
}

function isB2bReceiver(receiver = {}) {
  return Boolean(receiver?.isB2bOrder);
}

function getB2bReceiverDetail(receiver = {}) {
  return [
    String(receiver.b2bCompanyName || '').trim(),
    String(receiver.b2bLocationName || '').trim(),
  ].filter(Boolean).join(' | ');
}

function renderReceiverTable(receivers = []) {
  const container = document.getElementById('hypReceiverTable');
  if (!container) return;

  const safeReceivers = Array.isArray(receivers) ? receivers : [];
  if (safeReceivers.length === 0) {
    container.innerHTML = '<p class="pick-list-empty">No HYP-AR receivers found.</p>';
    return;
  }

  container.innerHTML = `
    <table class="hyp-production-table hyp-production-table--receivers">
      <thead>
        <tr>
          <th>Receiver</th>
          <th>Order</th>
          <th>Date Placed</th>
          <th>Order Status</th>
          <th>Shopify SKU</th>
          <th>Stage</th>
          <th>Updated</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${safeReceivers.map((receiver) => {
          const archived = Boolean(receiver.archivedAt);
          const isB2b = isB2bReceiver(receiver);
          const rowClass = [
            archived ? 'is-archived' : '',
            isB2b ? 'is-b2b' : '',
            String(receiver.id) === hypRecentReceiverId ? 'is-recently-moved' : '',
          ].filter(Boolean).join(' ');
          const subtitle = [receiver.title, receiver.variantTitle].filter(Boolean).join(' | ');
          const orderStatus = getReceiverOrderStatus(receiver);
          const b2bDetail = getB2bReceiverDetail(receiver);
          return `
            <tr class="${escapeHtmlAttribute(rowClass)}" data-hyp-receiver-id="${escapeHtmlAttribute(receiver.id)}" data-hyp-archived="${archived}">
              <td>
                <strong class="hyp-production-code">${escapeHtml(receiver.receiverCode)}</strong>
                ${archived ? `<span class="hyp-production-archive-pill">${escapeHtml(receiver.archiveReason || 'archived')}</span>` : ''}
              </td>
              <td>
                <a class="hyp-production-order-link" href="${escapeHtmlAttribute(buildOrderViewerUrl(receiver.orderNumber || receiver.orderId))}">
                  ${escapeHtml(receiver.orderNumber || receiver.orderId)}
                </a>
                ${isB2b ? '<span class="hyp-b2b-pill">B2B</span>' : ''}
                ${isB2b && b2bDetail ? `<small class="hyp-b2b-detail">${escapeHtml(b2bDetail)}</small>` : ''}
              </td>
              <td>${escapeHtml(formatDatePlaced(receiver.orderCreatedAt))}</td>
              <td>
                <span class="hyp-status-pill hyp-status-pill--${escapeHtmlAttribute(orderStatus.key)}">
                  ${escapeHtml(orderStatus.label)}
                </span>
              </td>
              <td>
                <strong>${escapeHtml(receiver.sku)}</strong>
                ${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ''}
              </td>
              <td>
                <div class="hyp-stage-track" role="group" aria-label="${escapeHtmlAttribute(`${receiver.receiverCode} production stage`)}">
                  ${renderStageButtons(receiver)}
                </div>
              </td>
              <td>
                <span>${escapeHtml(formatTimestamp(receiver.updatedAt))}</span>
                ${archived ? `<small>Archived ${escapeHtml(formatTimestamp(receiver.archivedAt))}</small>` : ''}
              </td>
              <td>
                <div class="hyp-row-actions">
                  <button
                    type="button"
                    class="hyp-label-btn"
                    data-print-receiver-id="${escapeHtmlAttribute(receiver.id)}"
                  >
                    Print
                  </button>
                  <button
                    type="button"
                    class="hyp-delete-btn"
                    data-delete-receiver-id="${escapeHtmlAttribute(receiver.id)}"
                    data-delete-receiver-code="${escapeHtmlAttribute(receiver.receiverCode)}"
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function renderQueueCard(receiver) {
  const archived = Boolean(receiver.archivedAt);
  const isB2b = isB2bReceiver(receiver);
  const orderStatus = getReceiverOrderStatus(receiver);
  const b2bDetail = getB2bReceiverDetail(receiver);
  const classes = [
    'print-queue-card hyp-queue-card',
    archived ? 'is-archived' : '',
    isB2b ? 'is-b2b' : '',
    String(receiver.id) === hypRecentReceiverId ? 'is-recently-moved' : '',
  ].filter(Boolean).join(' ');

  return `
    <article class="${escapeHtmlAttribute(classes)}"
      data-hyp-receiver-id="${escapeHtmlAttribute(receiver.id)}"
      data-hyp-archived="${archived}"
      draggable="${!archived && !hypProductionLoading}"
      aria-label="${escapeHtmlAttribute(receiver.receiverCode)}">
      <div class="print-queue-card__head">
        <div>
          <h3>${escapeHtml(receiver.receiverCode)}</h3>
          <p>${escapeHtml(receiver.sku)}</p>
        </div>
        ${isB2b ? '<span class="hyp-b2b-pill">B2B</span>' : ''}
      </div>
      <p class="hyp-queue-card__description">${escapeHtml([receiver.title, receiver.variantTitle].filter(Boolean).join(' | '))}</p>
      <a class="hyp-production-order-link" draggable="false" href="${escapeHtmlAttribute(buildOrderViewerUrl(receiver.orderNumber || receiver.orderId))}">
        ${escapeHtml(receiver.orderNumber || receiver.orderId)}
      </a>
      ${isB2b && b2bDetail ? `<p class="hyp-b2b-detail">${escapeHtml(b2bDetail)}</p>` : ''}
      <p class="hyp-queue-card__date">Placed ${escapeHtml(formatDatePlaced(receiver.orderCreatedAt))}</p>
      <span class="hyp-status-pill hyp-status-pill--${escapeHtmlAttribute(orderStatus.key)}">${escapeHtml(orderStatus.label)}</span>
      ${archived ? `<p class="hyp-production-archive-pill">${escapeHtml(receiver.archiveReason || 'archived')}</p>` : ''}
      <div class="hyp-row-actions">
        <button type="button" class="hyp-label-btn" data-print-receiver-id="${escapeHtmlAttribute(receiver.id)}">Print</button>
        <button type="button" class="hyp-delete-btn" data-delete-receiver-id="${escapeHtmlAttribute(receiver.id)}">Delete</button>
      </div>
      <p class="hyp-queue-card__date">Updated ${escapeHtml(formatTimestamp(receiver.updatedAt))}</p>
    </article>
  `;
}

function renderQueueBoard(receivers = []) {
  const container = document.getElementById('hypQueueBoard');
  if (!container) return;
  const stages = getStages();
  if (!stages.length) {
    container.innerHTML = '<p class="pick-list-empty">No production stages loaded.</p>';
    return;
  }
  container.style.setProperty('--hyp-stage-count', stages.length);
  container.innerHTML = stages.map((stage) => {
    const items = receivers.filter((receiver) => receiver.currentStageKey === stage.key);
    return `
      <section class="print-queue-column" data-hyp-drop-stage="${escapeHtmlAttribute(stage.key)}" aria-label="${escapeHtmlAttribute(stage.label)}">
        <header class="print-queue-column__head">
          <h3>${escapeHtml(stage.label)}</h3>
          <span aria-label="${items.length} receivers">${items.length}</span>
        </header>
        <div class="print-queue-column__body">
          ${items.length ? items.map(renderQueueCard).join('') : '<p class="print-queue-empty">No receivers.</p>'}
        </div>
      </section>
    `;
  }).join('');
}

function renderActionTimeline(events = []) {
  const container = document.getElementById('hypActionTimeline');
  if (!container) return;

  const safeEvents = getSortedHypEvents(events).slice(0, 100);
  if (!safeEvents.length) {
    container.innerHTML = '<p class="pick-list-empty">No HYP actions recorded yet.</p>';
    return;
  }

  container.innerHTML = `
    <ol class="hyp-action-timeline__list">
      ${safeEvents.map((event) => {
        const actionTone = getHypActionTone(event);
        const staff = String(event.staff || '').trim();
        const orderNumber = String(event.orderNumber || '').trim();
        const note = String(event.note || '').trim();
        return `
          <li class="hyp-action-timeline__item hyp-action-timeline__item--${escapeHtmlAttribute(actionTone)}">
            <time datetime="${escapeHtmlAttribute(event.createdAt || '')}">
              ${escapeHtml(formatAuditTimestamp(event.createdAt))}
            </time>
            <div>
              <strong>${escapeHtml(getHypActionText(event))}</strong>
              <span>
                ${staff ? `By ${escapeHtml(staff)}` : 'System'}
                ${orderNumber ? ` | <a href="${escapeHtmlAttribute(buildOrderViewerUrl(orderNumber))}">${escapeHtml(orderNumber)}</a>` : ''}
                ${note ? ` | ${escapeHtml(note)}` : ''}
              </span>
            </div>
          </li>
        `;
      }).join('')}
    </ol>
  `;
}

function renderProduction(data, { silent = false } = {}) {
  hypProductionData = data;
  if (!Array.isArray(hypProductionData.receivers)) {
    hypProductionData.receivers = [];
  }
  if (!Array.isArray(hypProductionData.stages)) {
    hypProductionData.stages = [];
  }
  if (!Array.isArray(hypProductionData.events)) {
    hypProductionData.events = [];
  }
  if (!hypProductionData.summary) {
    hypProductionData.summary = buildLocalProductionSummary(hypProductionData.receivers);
  }

  refreshProductionView();
  updateLastUpdatedLabel();

  if (silent) return;

  if (data.syncError) {
    setStatus(`Loaded local records. Sync warning: ${data.syncError}`, 'error');
    return;
  }

  const syncStats = data.syncStats;
  if (syncStats) {
    setStatus(formatSyncStats(syncStats), 'success');
    return;
  }

  setStatus(
    hypProductionSyncing
      ? 'Loaded stored HYP-AR records. Shopify sync is running in the background.'
      : 'Loaded stored HYP-AR records.',
    hypProductionSyncing ? 'info' : 'success'
  );
}

async function fetchProduction({ sync = false, silent = false } = {}) {
  if (hypProductionLoading || hypDraggedReceiverId) return false;
  setLoading(true);
  if (!silent) {
    setStatus(sync ? 'Syncing Shopify orders...' : 'Loading stored HYP-AR records...', 'info');
  }

  try {
    const params = new URLSearchParams();
    params.set('includeArchived', getShowArchived() ? '1' : '0');
    params.set('sync', sync ? '1' : '0');
    const response = await fetch(`/api/hyp-ar-production?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || 'Failed to load HYP-AR production');
    }

    renderProduction(data, { silent });
    return true;
  } catch (err) {
    if (!silent) setStatus(`Error: ${err.message}`, 'error');
    return false;
  } finally {
    setLoading(false);
  }
}

function clearBackgroundSyncPoll() {
  if (hypProductionSyncPollId) {
    clearTimeout(hypProductionSyncPollId);
    hypProductionSyncPollId = null;
  }
}

async function fetchBackgroundSyncStatus() {
  const response = await fetch('/api/hyp-ar-production/sync', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) {
    throw new Error(data?.error || 'Failed to load HYP-AR sync status');
  }
  return data.sync || {};
}

function scheduleBackgroundSyncPoll() {
  clearBackgroundSyncPoll();
  hypProductionSyncPollId = window.setTimeout(pollBackgroundSyncStatus, 5000);
}

async function pollBackgroundSyncStatus() {
  try {
    const sync = await fetchBackgroundSyncStatus();
    if (sync.running) {
      scheduleBackgroundSyncPoll();
      return;
    }

    hypProductionSyncing = false;
    await fetchProduction({ sync: false, silent: true });
    if (sync.error) {
      setStatus(`Loaded stored HYP-AR records. Background sync failed: ${sync.error}`, 'error');
      return;
    }

    setStatus(sync.stats ? `Background sync complete. ${formatSyncStats(sync.stats)}` : 'Background sync complete.', 'success');
  } catch (err) {
    hypProductionSyncing = false;
    setStatus(`Loaded stored HYP-AR records. Background sync status failed: ${err.message}`, 'error');
  }
}

async function startBackgroundSync({ silent = false, force = false } = {}) {
  if (hypProductionSyncing) return;
  hypProductionSyncing = true;
  if (!silent) {
    setStatus('Loaded stored HYP-AR records. Syncing Shopify orders in the background...', 'info');
  }

  try {
    const response = await fetch('/api/hyp-ar-production/sync', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
      cache: 'no-store',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || 'Failed to start HYP-AR sync');
    }

    const sync = data.sync || {};
    if (sync.running) {
      scheduleBackgroundSyncPoll();
      return;
    }

    hypProductionSyncing = false;
    await fetchProduction({ sync: false, silent: true });
    if (sync.error) {
      setStatus(`Loaded stored HYP-AR records. Background sync failed: ${sync.error}`, 'error');
      return;
    }
    setStatus(sync.stats ? `Background sync complete. ${formatSyncStats(sync.stats)}` : 'Background sync complete.', 'success');
  } catch (err) {
    hypProductionSyncing = false;
    setStatus(`Loaded stored HYP-AR records. Background sync failed to start: ${err.message}`, 'error');
  }
}

async function updateReceiverStage(receiverId, stageKey) {
  if (hypProductionLoading) return;
  const receiver = (hypProductionData?.receivers || [])
    .find((item) => String(item.id) === String(receiverId));
  const stage = getStages().find((item) => item.key === stageKey);
  if (!receiver || receiver.archivedAt || !stage || receiver.currentStageKey === stageKey) return;

  hypPendingAction = { receiverId, stageKey, type: 'move' };
  setLoading(true);
  const movingMessage = `Moving ${receiver.receiverCode} to ${stage.label}…`;
  setStatus(movingMessage, 'info');
  showActionFeedback(movingMessage, 'loading');

  try {
    const response = await fetch(`/api/hyp-ar-production/${encodeURIComponent(receiverId)}/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ stageKey }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || 'Failed to update receiver');
    }

    mergeReceiverIntoProductionData(data.receiver);
    if (Array.isArray(data.events)) {
      hypProductionData.events = data.events;
    }
    highlightMovedReceiver(receiverId);
    refreshProductionView({ updateTimestamp: true });
    const previousStage = receiver.currentStageLabel || getStages().find((item) => item.key === receiver.currentStageKey)?.label;
    const message = `${data.receiver.receiverCode} moved${previousStage ? ` from ${previousStage}` : ''} to ${data.receiver.currentStageLabel || stage.label}.`;
    setStatus(message, 'success');
    showActionFeedback(message, 'success', { stageKey: data.receiver.currentStageKey });
  } catch (err) {
    const message = `Could not move ${receiver.receiverCode} to ${stage.label}: ${err.message}`;
    setStatus(message, 'error');
    showActionFeedback(message, 'error');
  } finally {
    hypPendingAction = null;
    setLoading(false);
  }
}

async function deleteReceiver(receiverId) {
  if (hypProductionLoading) return;
  const receiver = (hypProductionData?.receivers || [])
    .find((item) => String(item.id) === String(receiverId));
  if (!receiver) return;

  const confirmed = window.confirm(`Delete ${receiver.receiverCode} from the HYP-AR tracker? Its code will stay reserved.`);
  if (!confirmed) return;

  hypPendingAction = { receiverId, type: 'delete' };
  setLoading(true);
  setStatus(`Deleting ${receiver.receiverCode}...`, 'info');
  showActionFeedback(`Deleting ${receiver.receiverCode}…`, 'loading');

  try {
    const response = await fetch(`/api/hyp-ar-production/${encodeURIComponent(receiverId)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || 'Failed to delete receiver');
    }

    removeReceiverFromProductionData(receiverId);
    if (Array.isArray(data.events)) {
      hypProductionData.events = data.events;
    }
    refreshProductionView({ updateTimestamp: true });
    setStatus(`${receiver.receiverCode} deleted from the HYP-AR tracker.`, 'success');
    showActionFeedback(`${receiver.receiverCode} deleted from the HYP-AR tracker.`, 'success');
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    showActionFeedback(`Could not delete ${receiver.receiverCode}: ${err.message}`, 'error');
  } finally {
    hypPendingAction = null;
    setLoading(false);
  }
}

function buildLabelMarkup(receivers) {
  return receivers.map((receiver) => `
    <section class="hyp-dymo-label">
      <div class="hyp-dymo-label__code">${escapeHtml(receiver.receiverCode)}</div>
      <div class="hyp-dymo-label__sku">${escapeHtml(receiver.sku)}</div>
      <div class="hyp-dymo-label__order">${escapeHtml(receiver.orderNumber || receiver.orderId)}</div>
    </section>
  `).join('');
}

function printLabels(receivers) {
  const safeReceivers = (Array.isArray(receivers) ? receivers : [])
    .filter((receiver) => receiver?.receiverCode);
  if (!safeReceivers.length) {
    setStatus('No receivers available to print.', 'error');
    return;
  }

  const printArea = document.getElementById('hypPrintArea');
  if (!printArea) return;

  printArea.innerHTML = buildLabelMarkup(safeReceivers);
  document.body.classList.add('hyp-printing');
  window.setTimeout(() => {
    window.print();
  }, 50);
}

function cleanupPrintArea() {
  document.body.classList.remove('hyp-printing');
  const printArea = document.getElementById('hypPrintArea');
  if (printArea) printArea.innerHTML = '';
}

function installEventHandlers() {
  const refreshBtn = document.getElementById('hypRefreshBtn');
  const printActiveBtn = document.getElementById('hypPrintActiveBtn');
  const archivedToggle = document.getElementById('hypShowArchived');
  const receiverPanel = document.getElementById('hypReceiverPanel');
  const filterContainer = document.getElementById('hypStageFilters');
  const board = document.getElementById('hypQueueBoard');

  document.getElementById('hypViewToggle')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-hyp-view]');
    if (button) setProductionView(button.dataset.hypView);
  });
  document.getElementById('hypFeedbackDismiss')?.addEventListener('click', () => {
    clearTimeout(hypFeedbackTimeout);
    document.getElementById('hypActionFeedback').hidden = true;
  });
  document.getElementById('hypFeedbackViewStage')?.addEventListener('click', (event) => {
    const stageKey = event.currentTarget.dataset.stageKey;
    if (hypProductionView === 'table') {
      hypStageFilter = stageKey;
      renderStageFilters(hypProductionData?.receivers || []);
      renderReceiverViews();
      document.getElementById('hypReceiverTable').scrollIntoView({ block: 'nearest' });
    } else {
      const column = Array.from(board.querySelectorAll('[data-hyp-drop-stage]'))
        .find((element) => element.dataset.hypDropStage === stageKey);
      column?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });

  refreshBtn?.addEventListener('click', async () => {
    const loaded = await fetchProduction({ sync: false });
    if (loaded) startBackgroundSync({ force: true });
  });
  printActiveBtn?.addEventListener('click', () => printLabels(getActiveReceivers()));
  archivedToggle?.addEventListener('change', () => fetchProduction({ sync: false }));

  filterContainer?.addEventListener('click', (event) => {
    const filterButton = event.target.closest('[data-hyp-stage-filter]');
    if (!filterButton) return;
    const nextFilter = String(filterButton.dataset.hypStageFilter || '').trim();
    if (nextFilter === hypStageFilter) return;
    hypStageFilter = nextFilter;
    renderStageFilters(hypProductionData?.receivers || []);
    renderReceiverViews();
  });

  receiverPanel?.addEventListener('click', (event) => {
    if (event.target.closest('button')?.disabled) return;
    const stageButton = event.target.closest('[data-receiver-id][data-stage-key]');
    if (stageButton) {
      updateReceiverStage(stageButton.dataset.receiverId, stageButton.dataset.stageKey);
      return;
    }

    const printButton = event.target.closest('[data-print-receiver-id]');
    if (printButton) {
      const receiver = (hypProductionData?.receivers || [])
        .find((item) => String(item.id) === String(printButton.dataset.printReceiverId));
      if (receiver) printLabels([receiver]);
      return;
    }

    const deleteButton = event.target.closest('[data-delete-receiver-id]');
    if (deleteButton) {
      deleteReceiver(deleteButton.dataset.deleteReceiverId);
    }
  });

  function clearDragState() {
    hypDraggedReceiverId = '';
    board?.querySelectorAll('.is-dragging, .is-drop-target').forEach((element) => {
      element.classList.remove('is-dragging', 'is-drop-target');
    });
  }

  board?.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.hyp-queue-card');
    if (!card || hypProductionLoading || card.dataset.hypArchived === 'true'
      || event.target.closest('button, a')) {
      event.preventDefault();
      return;
    }
    hypDraggedReceiverId = card.dataset.hypReceiverId;
    event.dataTransfer.setData('text/plain', hypDraggedReceiverId);
    event.dataTransfer.effectAllowed = 'move';
    card.classList.add('is-dragging');
  });
  board?.addEventListener('dragover', (event) => {
    const column = event.target.closest('[data-hyp-drop-stage]');
    if (!column || !hypDraggedReceiverId || hypProductionLoading) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    board.querySelectorAll('.is-drop-target').forEach((element) => element.classList.remove('is-drop-target'));
    column.classList.add('is-drop-target');
  });
  board?.addEventListener('dragleave', (event) => {
    const column = event.target.closest('[data-hyp-drop-stage]');
    if (column && !column.contains(event.relatedTarget)) column.classList.remove('is-drop-target');
  });
  board?.addEventListener('drop', (event) => {
    const column = event.target.closest('[data-hyp-drop-stage]');
    if (!column || !hypDraggedReceiverId || hypProductionLoading) return;
    event.preventDefault();
    const receiverId = hypDraggedReceiverId;
    clearDragState();
    updateReceiverStage(receiverId, column.dataset.hypDropStage);
  });
  board?.addEventListener('dragend', clearDragState);

  window.addEventListener('afterprint', cleanupPrintArea);
}

document.addEventListener('DOMContentLoaded', () => {
  installEventHandlers();
  let savedView = 'table';
  try { savedView = window.localStorage.getItem(HYP_PRODUCTION_VIEW_KEY); } catch (_) { /* Use the default view. */ }
  setProductionView(savedView, { persist: false });
  fetchProduction({ sync: false }).then((loaded) => {
    if (loaded) startBackgroundSync();
  });

  if (hypProductionPollId) {
    clearInterval(hypProductionPollId);
  }
  hypProductionPollId = setInterval(() => {
    fetchProduction({ sync: false, silent: true });
  }, HYP_PRODUCTION_POLL_MS);
});
