const HYP_PRODUCTION_POLL_MS = 60000;

let hypProductionData = null;
let hypProductionLoading = false;
let hypProductionPollId = null;
let hypStageFilter = '';

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

function formatStatusLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
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
  renderReceiverTable(getFilteredReceivers());
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
        ${archived ? 'disabled' : ''}
        aria-pressed="${state === 'current' ? 'true' : 'false'}"
      >
        ${escapeHtml(stage.label)}
      </button>
    `;
  }).join('');
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
          const subtitle = [receiver.title, receiver.variantTitle].filter(Boolean).join(' | ');
          const orderStatus = getReceiverOrderStatus(receiver);
          return `
            <tr class="${archived ? 'is-archived' : ''}">
              <td>
                <strong class="hyp-production-code">${escapeHtml(receiver.receiverCode)}</strong>
                ${archived ? `<span class="hyp-production-archive-pill">${escapeHtml(receiver.archiveReason || 'archived')}</span>` : ''}
              </td>
              <td>
                <a class="hyp-production-order-link" href="${escapeHtmlAttribute(buildOrderViewerUrl(receiver.orderNumber || receiver.orderId))}">
                  ${escapeHtml(receiver.orderNumber || receiver.orderId)}
                </a>
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

function renderProduction(data) {
  hypProductionData = data;
  if (!Array.isArray(hypProductionData.receivers)) {
    hypProductionData.receivers = [];
  }
  if (!Array.isArray(hypProductionData.stages)) {
    hypProductionData.stages = [];
  }
  if (!hypProductionData.summary) {
    hypProductionData.summary = buildLocalProductionSummary(hypProductionData.receivers);
  }

  refreshProductionView();
  updateLastUpdatedLabel();

  if (data.syncError) {
    setStatus(`Loaded local records. Sync warning: ${data.syncError}`, 'error');
    return;
  }

  const syncStats = data.syncStats;
  if (syncStats) {
    setStatus(
      `Synced ${syncStats.scannedOpenOrders || 0} open, ${syncStats.scannedHistoricalOrders || 0} recent historical, and ${syncStats.targetedHistoricalOrderCount || 0} targeted HYP Shopify orders; ${(syncStats.receiverCount || 0)} active and ${(syncStats.historicalReceiverCount || 0) + (syncStats.targetedHistoricalReceiverCount || 0)} fulfilled HYP-AR receivers serialised.`,
      'success'
    );
    return;
  }

  setStatus('Loaded local HYP-AR records.', 'success');
}

async function fetchProduction({ sync = true } = {}) {
  if (hypProductionLoading) return;
  setLoading(true);
  setStatus(sync ? 'Syncing Shopify orders...' : 'Loading HYP-AR records...', 'info');

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

    renderProduction(data);
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

async function updateReceiverStage(receiverId, stageKey) {
  if (hypProductionLoading) return;
  const receiver = (hypProductionData?.receivers || [])
    .find((item) => String(item.id) === String(receiverId));
  if (!receiver || receiver.currentStageKey === stageKey) return;

  setLoading(true);
  setStatus(`Updating ${receiver.receiverCode}...`, 'info');

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
    refreshProductionView({ updateTimestamp: true });
    setStatus(`${data.receiver.receiverCode} moved to ${data.receiver.currentStageLabel}.`, 'success');
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
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

  setLoading(true);
  setStatus(`Deleting ${receiver.receiverCode}...`, 'info');

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
    refreshProductionView({ updateTimestamp: true });
    setStatus(`${receiver.receiverCode} deleted from the HYP-AR tracker.`, 'success');
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
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
  const tableContainer = document.getElementById('hypReceiverTable');
  const filterContainer = document.getElementById('hypStageFilters');

  refreshBtn?.addEventListener('click', () => fetchProduction({ sync: true }));
  printActiveBtn?.addEventListener('click', () => printLabels(getActiveReceivers()));
  archivedToggle?.addEventListener('change', () => fetchProduction({ sync: archivedToggle.checked }));

  filterContainer?.addEventListener('click', (event) => {
    const filterButton = event.target.closest('[data-hyp-stage-filter]');
    if (!filterButton) return;
    const nextFilter = String(filterButton.dataset.hypStageFilter || '').trim();
    if (nextFilter === hypStageFilter) return;
    hypStageFilter = nextFilter;
    renderStageFilters(hypProductionData?.receivers || []);
    renderReceiverTable(getFilteredReceivers());
  });

  tableContainer?.addEventListener('click', (event) => {
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

  window.addEventListener('afterprint', cleanupPrintArea);
}

document.addEventListener('DOMContentLoaded', () => {
  installEventHandlers();
  fetchProduction({ sync: true });

  if (hypProductionPollId) {
    clearInterval(hypProductionPollId);
  }
  hypProductionPollId = setInterval(() => {
    fetchProduction({ sync: false });
  }, HYP_PRODUCTION_POLL_MS);
});
