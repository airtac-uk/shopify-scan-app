const AWAITING_PARTS_POLL_MS = 30000;
const AWAITING_PARTS_MINIMAL_MODE_KEY = 'awaiting_parts_minimal_mode';

let awaitingPartsActiveType = '';
let awaitingPartsLoading = false;
let awaitingPartsPollId = null;
let awaitingPartsMinimalModeEnabled = false;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function setStatus(message, type = 'info') {
  const el = document.getElementById('awaitingPartsStatus');
  if (!el) return;
  el.textContent = message || '';
  el.dataset.type = type;
}

function setLoading(isLoading) {
  awaitingPartsLoading = Boolean(isLoading);
  const spinner = document.getElementById('awaitingPartsSpinner');
  const refreshBtn = document.getElementById('awaitingPartsRefreshBtn');

  if (spinner) spinner.style.display = awaitingPartsLoading ? 'inline-block' : 'none';
  if (refreshBtn) refreshBtn.disabled = awaitingPartsLoading;
}

function updateLastUpdatedLabel() {
  const el = document.getElementById('awaitingPartsLastUpdated');
  if (!el) return;
  el.textContent = `Last refreshed ${formatTimestamp(new Date().toISOString())}`;
}

function getInitialTypeFilter() {
  const params = new URLSearchParams(window.location.search);
  return String(params.get('type') || '').trim().toUpperCase();
}

function loadMinimalModePreference() {
  try {
    return localStorage.getItem(AWAITING_PARTS_MINIMAL_MODE_KEY) === '1';
  } catch (err) {
    return false;
  }
}

function saveMinimalModePreference(enabled) {
  try {
    localStorage.setItem(AWAITING_PARTS_MINIMAL_MODE_KEY, enabled ? '1' : '0');
  } catch (err) {
    // Ignore storage failures.
  }
}

function syncTypeFilterToUrl() {
  const url = new URL(window.location.href);
  if (awaitingPartsActiveType) {
    url.searchParams.set('type', awaitingPartsActiveType);
  } else {
    url.searchParams.delete('type');
  }
  window.history.replaceState({}, '', `${url.pathname}${url.search}`);
}

function buildOrderViewerUrl(orderLookupValue) {
  const normalizedValue = String(orderLookupValue || '').trim();
  if (!normalizedValue) return '/pick_list.html';

  const params = new URLSearchParams();
  params.set('order', normalizedValue);
  return `/pick_list.html?${params.toString()}`;
}

function formatCompactReporter(value) {
  const reporter = String(value || '').trim();
  return reporter ? ` · ${reporter}` : '';
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}

async function markAwaitingPartsOrderFulfilled(orderId, orderNumber) {
  const normalizedOrderId = String(orderId || '').trim();
  const normalizedOrderNumber = String(orderNumber || '').trim();
  if (!normalizedOrderId || !normalizedOrderNumber || awaitingPartsLoading) {
    return;
  }

  const confirmed = window.confirm(`Mark ${normalizedOrderNumber} as fulfilled and remove it from the awaiting-parts queue?`);
  if (!confirmed) return;

  setLoading(true);
  setStatus(`Marking ${normalizedOrderNumber} fulfilled locally...`, 'info');

  try {
    const response = await fetch('/api/awaiting-parts/mark-fulfilled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: normalizedOrderId,
        orderNumber: normalizedOrderNumber,
      }),
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to mark order fulfilled');
    }

    setLoading(false);
    await fetchAwaitingPartsSummary({ silent: true, sync: false });
    setStatus(
      data.remoteTagUpdated
        ? `Marked ${normalizedOrderNumber} fulfilled locally and retagged it as Packaged in Shopify.`
        : `Marked ${normalizedOrderNumber} fulfilled locally.`,
      'success'
    );
    return;
  } catch (err) {
    setLoading(false);
    setStatus(`Error: ${err.message}`, 'error');
    return;
  }
}

function renderOverview(items) {
  const container = document.getElementById('awaitingPartsOverview');
  if (!container) return;

  const safeItems = Array.isArray(items) ? items : [];
  const uniqueOrders = new Set();
  let totalQuantity = 0;
  let oldestOpenAt = null;

  safeItems.forEach((item) => {
    totalQuantity += Number(item.totalQuantity || 0);
    (item.orders || []).forEach((order) => {
      if (order?.orderId) uniqueOrders.add(String(order.orderId));
      if (order?.createdAt && (!oldestOpenAt || String(order.createdAt) < String(oldestOpenAt))) {
        oldestOpenAt = order.createdAt;
      }
    });
  });

  const stats = [
    {
      label: 'Open Part SKUs',
      value: safeItems.length,
    },
    {
      label: 'Blocked Orders',
      value: uniqueOrders.size,
    },
    {
      label: 'Requested Qty',
      value: totalQuantity,
    },
    {
      label: 'Oldest Open',
      value: oldestOpenAt ? formatTimestamp(oldestOpenAt) : '-',
    },
  ];

  container.innerHTML = stats.map((stat) => `
    <article class="awaiting-parts-summary-stat">
      <p>${escapeHtml(stat.label)}</p>
      <strong>${escapeHtml(stat.value)}</strong>
    </article>
  `).join('');
}

function renderFilters(filters) {
  const container = document.getElementById('awaitingPartsFilters');
  if (!container) return;

  const safeFilters = Array.isArray(filters) ? filters : [];
  const allFilters = [
    {
      typeGroup: '',
      label: 'All Types',
      openOrderCount: safeFilters.reduce((sum, item) => sum + Number(item.openOrderCount || 0), 0),
    },
    ...safeFilters.map((filter) => ({
      typeGroup: String(filter.typeGroup || '').trim().toUpperCase(),
      label: String(filter.typeGroup || 'UNKNOWN').trim() || 'UNKNOWN',
      openOrderCount: Number(filter.openOrderCount || 0),
    })),
  ];

  container.innerHTML = allFilters.map((filter) => {
    const isActive = filter.typeGroup === awaitingPartsActiveType;
    return `
      <button
        type="button"
        class="awaiting-parts-filter-chip${isActive ? ' is-active' : ''}"
        data-type-group="${escapeHtml(filter.typeGroup)}"
      >
        <span>${escapeHtml(filter.label)}</span>
        <strong>${escapeHtml(filter.openOrderCount)}</strong>
      </button>
    `;
  }).join('');

  Array.from(container.querySelectorAll('.awaiting-parts-filter-chip')).forEach((button) => {
    button.addEventListener('click', () => {
      const nextType = String(button.dataset.typeGroup || '').trim().toUpperCase();
      if (nextType === awaitingPartsActiveType) return;
      awaitingPartsActiveType = nextType;
      syncTypeFilterToUrl();
      fetchAwaitingPartsSummary();
    });
  });
}

function renderAwaitingPartsList(items) {
  const container = document.getElementById('awaitingPartsList');
  if (!container) return;

  const safeItems = Array.isArray(items) ? items : [];
  if (safeItems.length === 0) {
    container.innerHTML = '<p class="pick-list-empty">No open awaiting-parts items for this filter.</p>';
    return;
  }

  if (awaitingPartsMinimalModeEnabled) {
    container.innerHTML = `
      <div class="awaiting-parts-minimal-wrap">
        <table class="awaiting-parts-minimal-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Part SKU</th>
              <th>Type</th>
              <th>Orders</th>
              <th>Qty</th>
              <th>Oldest</th>
              <th>Last</th>
              <th>Order Links</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${safeItems.map((item) => {
              const orders = Array.isArray(item.orders) ? item.orders : [];
              const firstSeen = item.oldestOpenAt ? formatTimestamp(item.oldestOpenAt) : '-';
              const lastSeen = item.latestReportedAt ? formatTimestamp(item.latestReportedAt) : '-';
              const orderLinks = orders.length > 0
                ? `
                    <div class="awaiting-parts-minimal-order-stack">
                      ${orders.map((order) => `
                        <a class="awaiting-parts-minimal-order-link" href="${escapeHtml(buildOrderViewerUrl(order.orderNumber || order.orderId))}">
                          ${escapeHtml(order.orderNumber || order.orderId)} x${escapeHtml(order.quantity)}${escapeHtml(formatCompactReporter(order.reportedBy))}
                        </a>
                      `).join('')}
                    </div>
                  `
                : '<span class="awaiting-parts-minimal-empty">-</span>';
              const orderActions = orders.length > 0
                ? `
                    <div class="awaiting-parts-minimal-actions-stack">
                      ${orders.map((order) => `
                        <button
                          type="button"
                          class="awaiting-parts-fulfill-btn awaiting-parts-fulfill-btn--minimal"
                          data-awaiting-order-id="${escapeHtmlAttribute(order.orderId)}"
                          data-awaiting-order-number="${escapeHtmlAttribute(order.orderNumber || order.orderId)}"
                        >
                          Mark Fulfilled
                        </button>
                      `).join('')}
                    </div>
                  `
                : '<span class="awaiting-parts-minimal-empty">-</span>';

              return `
                <tr>
                  <td>${escapeHtml(item.priorityRank)}</td>
                  <td>
                    <div class="awaiting-parts-minimal-sku">${escapeHtml(item.partSku)}</div>
                    <div class="awaiting-parts-minimal-raw-type">${escapeHtml(item.partTypeRaw)}</div>
                  </td>
                  <td>${escapeHtml(item.partTypeGroup)}</td>
                  <td>${escapeHtml(item.openOrderCount)}</td>
                  <td>${escapeHtml(item.totalQuantity)}</td>
                  <td>${escapeHtml(firstSeen)}</td>
                  <td>${escapeHtml(lastSeen)}</td>
                  <td class="awaiting-parts-minimal-order-cell">${orderLinks}</td>
                  <td class="awaiting-parts-minimal-actions-cell">${orderActions}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
    return;
  }

  container.innerHTML = safeItems.map((item) => {
    const orders = Array.isArray(item.orders) ? item.orders : [];
    const firstSeen = item.oldestOpenAt ? formatTimestamp(item.oldestOpenAt) : '-';
    const lastSeen = item.latestReportedAt ? formatTimestamp(item.latestReportedAt) : '-';

    return `
      <article class="awaiting-parts-card">
        <header class="awaiting-parts-card__head">
          <div class="awaiting-parts-card__title-wrap">
            <span class="awaiting-parts-card__priority">#${escapeHtml(item.priorityRank)}</span>
            <div>
              <h3>${escapeHtml(item.partSku)}</h3>
              <p>${escapeHtml(item.partTypeGroup)}</p>
            </div>
          </div>
          <span class="awaiting-parts-card__raw-type">${escapeHtml(item.partTypeRaw)}</span>
        </header>

        <div class="awaiting-parts-card__metrics">
          <div>
            <span>Blocked orders</span>
            <strong>${escapeHtml(item.openOrderCount)}</strong>
          </div>
          <div>
            <span>Requested qty</span>
            <strong>${escapeHtml(item.totalQuantity)}</strong>
          </div>
          <div>
            <span>Oldest open</span>
            <strong>${escapeHtml(firstSeen)}</strong>
          </div>
          <div>
            <span>Last reported</span>
            <strong>${escapeHtml(lastSeen)}</strong>
          </div>
        </div>

        <div class="awaiting-parts-card__orders">
          ${orders.map((order) => `
            <div class="awaiting-parts-order">
              <a class="awaiting-parts-order__link" href="${escapeHtml(buildOrderViewerUrl(order.orderNumber || order.orderId))}">
                <div class="awaiting-parts-order__head">
                  <strong>${escapeHtml(order.orderNumber || order.orderId)}</strong>
                  <span>x${escapeHtml(order.quantity)}</span>
                </div>
                <div class="awaiting-parts-order__meta">
                  <span>Reported ${escapeHtml(formatTimestamp(order.createdAt))}</span>
                  ${order.reportedBy ? `<span>${escapeHtml(order.reportedBy)}</span>` : ''}
                </div>
              </a>
              <div class="awaiting-parts-order__actions">
                <button
                  type="button"
                  class="awaiting-parts-fulfill-btn"
                  data-awaiting-order-id="${escapeHtmlAttribute(order.orderId)}"
                  data-awaiting-order-number="${escapeHtmlAttribute(order.orderNumber || order.orderId)}"
                >
                  Mark Fulfilled
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </article>
    `;
  }).join('');
}

async function fetchAwaitingPartsSummary({ silent = false, sync = false } = {}) {
  if (awaitingPartsLoading) return;

  setLoading(true);
  if (!silent) {
    setStatus(sync ? 'Rebuilding awaiting-parts queue from order notes...' : 'Loading awaiting-parts queue...', 'info');
  }

  try {
    const params = new URLSearchParams();
    if (awaitingPartsActiveType) {
      params.set('type', awaitingPartsActiveType);
    }
    if (sync) {
      params.set('sync', '1');
    }

    const queryString = params.toString();
    const url = queryString
      ? `/api/awaiting-parts-summary?${queryString}`
      : '/api/awaiting-parts-summary';

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to load awaiting-parts summary');
    }

    renderOverview(data.items);
    renderFilters(data.filters);
    renderAwaitingPartsList(data.items);
    updateLastUpdatedLabel();

    const filterLabel = data.typeGroupFilter ? ` for ${data.typeGroupFilter}` : '';
    const syncPrefix = data.syncStats
      ? `Synced ${data.syncStats.scannedOrderCount} orders, ${data.syncStats.awaitingPartsOrderCount} currently awaiting parts. `
      : '';
    const baseMessage = `${syncPrefix}Loaded ${data.items.length} part SKUs${filterLabel}.`;

    if (data.syncError) {
      setStatus(`${baseMessage} Note sync failed: ${data.syncError}`, 'error');
    } else {
      setStatus(baseMessage, 'success');
    }
  } catch (err) {
    renderOverview([]);
    renderFilters([]);
    renderAwaitingPartsList([]);
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  awaitingPartsActiveType = getInitialTypeFilter();
  awaitingPartsMinimalModeEnabled = loadMinimalModePreference();

  const refreshBtn = document.getElementById('awaitingPartsRefreshBtn');
  const minimalModeToggle = document.getElementById('awaitingPartsMinimalModeToggle');
  const listContainer = document.getElementById('awaitingPartsList');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      fetchAwaitingPartsSummary({ sync: true });
    });
  }

  if (minimalModeToggle) {
    minimalModeToggle.checked = awaitingPartsMinimalModeEnabled;
    minimalModeToggle.addEventListener('change', () => {
      awaitingPartsMinimalModeEnabled = Boolean(minimalModeToggle.checked);
      saveMinimalModePreference(awaitingPartsMinimalModeEnabled);
      fetchAwaitingPartsSummary({ silent: true, sync: false });
    });
  }

  if (listContainer) {
    listContainer.addEventListener('click', (event) => {
      const button = event.target instanceof Element
        ? event.target.closest('.awaiting-parts-fulfill-btn')
        : null;
      if (!button) return;

      event.preventDefault();
      const orderId = String(button.getAttribute('data-awaiting-order-id') || '').trim();
      const orderNumber = String(button.getAttribute('data-awaiting-order-number') || '').trim();
      markAwaitingPartsOrderFulfilled(orderId, orderNumber);
    });
  }

  fetchAwaitingPartsSummary({ sync: true });

  if (awaitingPartsPollId) {
    clearInterval(awaitingPartsPollId);
  }

  awaitingPartsPollId = setInterval(() => {
    fetchAwaitingPartsSummary({ silent: true, sync: false });
  }, AWAITING_PARTS_POLL_MS);
});
