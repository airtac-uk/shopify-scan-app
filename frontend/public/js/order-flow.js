const ORDER_FLOW_POLL_MS = 60000;
const ORDER_FLOW_SETTINGS_KEY = 'orderFlow.settings.v2';
const ORDER_FLOW_STAGE_FILTER_PREFIX = 'stage:';
const ORDER_FLOW_EXCEPTION_STACKS = {
  snoozed: { label: 'Snoozed', verb: 'Snoozing' },
  wholesale: { label: 'Wholesale', verb: 'Moving to Wholesale' },
  proto: { label: 'Proto', verb: 'Moving to Proto' },
};
const ORDER_FLOW_OPERATIONAL_STAGE_LABELS = {
  received: 'New Order',
  queued: 'Racked',
  building: 'Wholesale Adapter',
  awaiting_parts: 'Awaiting Parts',
  quality_check: 'Waiting QC',
  rebuild: 'QC Fail',
  passed_qc: 'QC Passed',
  packaged: 'Packaged',
  on_hold: 'On Hold',
  partially_fulfilled: 'Partially Fulfilled',
};
const ORDER_FLOW_DEFAULT_STAGE_WORKING_DAYS = {
  received: 0.25,
  queued: 1,
  building: 1,
  awaiting_parts: 3,
  quality_check: 0.5,
  rebuild: 2,
  passed_qc: 1,
  packaged: 1,
  on_hold: 3,
  partially_fulfilled: 3,
};
const ORDER_FLOW_STAGE_SORT_ORDER = [
  'received',
  'queued',
  'building',
  'awaiting_parts',
  'quality_check',
  'rebuild',
  'passed_qc',
  'packaged',
  'on_hold',
  'partially_fulfilled',
];

let orderFlowLoading = false;
let orderFlowPollId = null;
let orderFlowData = null;
let orderFlowActiveFilter = 'all';

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

function formatWorkingDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days)) return '-';
  const rounded = Number(days.toFixed(2));
  const label = rounded === 1 ? 'working day' : 'working days';
  return `${rounded.toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${label}`;
}

function formatOrderValue(value) {
  const amount = Number(value?.amount);
  const currencyCode = String(value?.currencyCode || '').trim().toUpperCase();
  if (!Number.isFinite(amount) || !currencyCode) return '';

  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: currencyCode,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch (err) {
    return `${currencyCode} ${amount.toLocaleString('en-GB', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
}

function setStatus(message, type = 'info') {
  const el = document.getElementById('orderFlowStatus');
  if (!el) return;
  el.textContent = message || '';
  el.dataset.type = type;
}

function setLoading(isLoading) {
  orderFlowLoading = Boolean(isLoading);
  const spinner = document.getElementById('orderFlowSpinner');
  const refreshBtn = document.getElementById('orderFlowRefreshBtn');

  if (spinner) spinner.style.display = orderFlowLoading ? 'inline-block' : 'none';
  if (refreshBtn) refreshBtn.disabled = orderFlowLoading;
}

function updateLastUpdatedLabel(value) {
  const el = document.getElementById('orderFlowLastUpdated');
  if (!el) return;
  el.textContent = `Last refreshed ${formatTimestamp(value || new Date().toISOString())}`;
}

function getNumberInputValue(id, fallback) {
  const input = document.getElementById(id);
  const parsed = Number(input?.value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampWorkingDays(value, fallback, { min = 0.25, max = 60 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function getStageInputId(stageKey) {
  return `orderFlowStageWorkingDays-${stageKey}`;
}

function normalizeStageWorkingDays(value = {}) {
  const rawValues = value && typeof value === 'object' ? value : {};
  return ORDER_FLOW_STAGE_SORT_ORDER.reduce((acc, stageKey) => {
    acc[stageKey] = clampWorkingDays(
      rawValues[stageKey],
      ORDER_FLOW_DEFAULT_STAGE_WORKING_DAYS[stageKey]
    );
    return acc;
  }, {});
}

function renderStageSettings(stageWorkingDays = {}) {
  const container = document.getElementById('orderFlowStageSettings');
  if (!container) return;

  const values = normalizeStageWorkingDays(stageWorkingDays);
  container.innerHTML = ORDER_FLOW_STAGE_SORT_ORDER.map((stageKey) => `
    <label class="order-flow-stage-setting" for="${escapeHtmlAttribute(getStageInputId(stageKey))}">
      <span>${escapeHtml(ORDER_FLOW_OPERATIONAL_STAGE_LABELS[stageKey] || formatStageKeyLabel(stageKey))}</span>
      <input
        id="${escapeHtmlAttribute(getStageInputId(stageKey))}"
        type="number"
        min="0.25"
        max="60"
        step="0.25"
        value="${escapeHtmlAttribute(values[stageKey])}"
      />
    </label>
  `).join('');
}

function getStageWorkingDaysFromInputs() {
  return ORDER_FLOW_STAGE_SORT_ORDER.reduce((acc, stageKey) => {
    const input = document.getElementById(getStageInputId(stageKey));
    const clampedValue = clampWorkingDays(
      input?.value,
      ORDER_FLOW_DEFAULT_STAGE_WORKING_DAYS[stageKey]
    );
    if (input && Number(input.value) !== clampedValue) {
      input.value = String(clampedValue);
    }
    acc[stageKey] = clampedValue;
    return acc;
  }, {});
}

function formatStageKeyLabel(stageKey) {
  return String(stageKey || '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ORDER_FLOW_SETTINGS_KEY) || '{}');
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (err) {
    // Ignore stored setting failures.
  }
  return {};
}

function saveSettings(settings) {
  try {
    localStorage.setItem(ORDER_FLOW_SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    // Ignore storage failures.
  }
}

function applyStoredSettings() {
  const settings = loadSettings();
  renderStageSettings(settings.stageWorkingDays);
  [
    ['orderFlowNewOrderWorkingDays', settings.newOrderWorkingDays],
    ['orderFlowStaleWorkingDays', settings.staleWorkingDays],
    ['orderFlowMaxOpenOrders', settings.maxOpenOrders],
  ].forEach(([id, value]) => {
    const input = document.getElementById(id);
    if (input && Number.isFinite(Number(value))) input.value = String(value);
  });
}

function getSettings() {
  const settings = {
    newOrderWorkingDays: getNumberInputValue('orderFlowNewOrderWorkingDays', 1),
    staleWorkingDays: getNumberInputValue('orderFlowStaleWorkingDays', 1),
    maxOpenOrders: Math.max(50, Math.floor(getNumberInputValue('orderFlowMaxOpenOrders', 500))),
    stageWorkingDays: getStageWorkingDaysFromInputs(),
  };
  saveSettings(settings);
  return settings;
}

function getOperationalStageLabel(stageKey, fallback = '') {
  const normalizedStageKey = String(stageKey || '').trim();
  return ORDER_FLOW_OPERATIONAL_STAGE_LABELS[normalizedStageKey]
    || String(fallback || '').trim()
    || formatStageKeyLabel(normalizedStageKey)
    || 'Unknown Status';
}

function getIssueStageKey(issue) {
  return String(issue?.currentStage?.key || 'unknown').trim() || 'unknown';
}

function getIssueStageLabel(issue) {
  return getOperationalStageLabel(getIssueStageKey(issue), issue?.currentStage?.label);
}

function getIssueTypeLabel(issue) {
  switch (String(issue?.type || '')) {
    case 'untracked':
      return 'No tracker';
    case 'unstarted':
      return 'New Order';
    case 'stale_stage':
      return `Stuck: ${getIssueStageLabel(issue)}`;
    default:
      return 'Issue';
  }
}

function buildOrderViewerUrl(issue) {
  const lookup = String(issue?.barcode || issue?.orderNumber || '').trim();
  if (!lookup) return '/pick_list.html';
  const params = new URLSearchParams();
  params.set('order', lookup);
  return `/pick_list.html?${params.toString()}`;
}

function getOrderFlowStackKeys() {
  return Object.keys(ORDER_FLOW_EXCEPTION_STACKS);
}

function normalizeOrderFlowStackKey(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ORDER_FLOW_EXCEPTION_STACKS[normalized] ? normalized : '';
}

function getStackIssues(stackKey) {
  const normalizedStackKey = normalizeOrderFlowStackKey(stackKey);
  if (!normalizedStackKey) return [];

  const stack = orderFlowData?.exceptionStacks?.[normalizedStackKey];
  if (Array.isArray(stack?.issues)) return stack.issues;

  if (normalizedStackKey === 'snoozed' && Array.isArray(orderFlowData?.snoozed?.issues)) {
    return orderFlowData.snoozed.issues;
  }

  return [];
}

function getStackCount(stackKey) {
  const normalizedStackKey = normalizeOrderFlowStackKey(stackKey);
  if (!normalizedStackKey) return 0;
  const stack = orderFlowData?.exceptionStacks?.[normalizedStackKey];
  if (Number.isFinite(Number(stack?.count))) return Number(stack.count);
  return getStackIssues(normalizedStackKey).length;
}

function getAllRenderedIssues() {
  const issues = Array.isArray(orderFlowData?.issues) ? orderFlowData.issues : [];
  const stackedIssues = getOrderFlowStackKeys().flatMap((stackKey) => getStackIssues(stackKey));
  return [...issues, ...stackedIssues];
}

function findIssueByKey(issueKey) {
  const normalizedIssueKey = String(issueKey || '').trim();
  if (!normalizedIssueKey) return null;
  return getAllRenderedIssues()
    .find((issue) => String(issue?.issueKey || '').trim() === normalizedIssueKey) || null;
}

function getFilteredIssues() {
  const issues = Array.isArray(orderFlowData?.issues) ? orderFlowData.issues : [];
  const stackFilterKey = normalizeOrderFlowStackKey(orderFlowActiveFilter);
  if (orderFlowActiveFilter === 'all') return issues;
  if (stackFilterKey) return getStackIssues(stackFilterKey);
  if (orderFlowActiveFilter.startsWith(ORDER_FLOW_STAGE_FILTER_PREFIX)) {
    const stageKey = orderFlowActiveFilter.slice(ORDER_FLOW_STAGE_FILTER_PREFIX.length);
    return issues.filter((issue) => issue.type === 'stale_stage' && getIssueStageKey(issue) === stageKey);
  }
  if (orderFlowActiveFilter === 'critical') {
    return issues.filter((issue) => issue.severity === 'critical');
  }
  if (orderFlowActiveFilter === 'warning') {
    return issues.filter((issue) => issue.severity === 'warning');
  }
  return issues.filter((issue) => issue.type === orderFlowActiveFilter);
}

function renderOverview() {
  const container = document.getElementById('orderFlowOverview');
  if (!container) return;

  const summary = orderFlowData?.summary || {};
  const stats = [
    { label: 'Critical', value: summary.criticalCount || 0 },
    { label: 'New Orders', value: summary.unstartedCount || 0 },
    { label: 'No Tracker', value: summary.untrackedCount || 0 },
    { label: 'Stuck Statuses', value: summary.staleStageCount || 0 },
    { label: 'Wholesale', value: summary.wholesaleCount || getStackCount('wholesale') },
    { label: 'Proto', value: summary.protoCount || getStackCount('proto') },
    { label: 'Snoozed', value: summary.snoozedCount || 0 },
    { label: 'Open Orders Scanned', value: summary.openOrdersScanned || 0 },
  ];

  container.innerHTML = stats.map((stat) => `
    <article class="order-flow-summary-stat">
      <p>${escapeHtml(stat.label)}</p>
      <strong>${escapeHtml(stat.value)}</strong>
    </article>
  `).join('');
}

function renderScanSummary() {
  const scan = orderFlowData?.scan || {};
  const summaryEl = document.getElementById('orderFlowScanSummary');
  const noteEl = document.getElementById('orderFlowThresholdNote');
  if (summaryEl) {
    const moreText = scan.openOrderHasMore ? ' Scan limit reached.' : '';
    summaryEl.textContent = [
      `${scan.openOrdersScanned || 0} open Shopify orders`,
      `${scan.activeTrackersScanned || 0} active tracker records`,
      `${scan.openOrderPagesFetched || 0} Shopify pages`,
    ].join(' / ') + `.${moreText}`;
  }

  if (noteEl) {
    const thresholds = orderFlowData?.thresholds || {};
    const definition = thresholds.workingDayDefinition || 'Monday-Friday calendar days';
    noteEl.textContent = `New orders: ${formatWorkingDays(thresholds.newOrderWorkingDays || 1)}. Status limits are editable below; unknown statuses use ${formatWorkingDays(thresholds.fallbackStaleWorkingDays || 1)}. ${definition}.`;
  }
}

function renderFilters() {
  const container = document.getElementById('orderFlowFilters');
  if (!container) return;
  const issues = Array.isArray(orderFlowData?.issues) ? orderFlowData.issues : [];
  const staleStageCounts = issues
    .filter((issue) => issue.type === 'stale_stage')
    .reduce((acc, issue) => {
      const stageKey = getIssueStageKey(issue);
      const existing = acc.get(stageKey) || {
        key: stageKey,
        label: getIssueStageLabel(issue),
        count: 0,
      };
      existing.count += 1;
      acc.set(stageKey, existing);
      return acc;
    }, new Map());
  const stageFilters = Array.from(staleStageCounts.values())
    .sort((left, right) => {
      const leftIndex = ORDER_FLOW_STAGE_SORT_ORDER.indexOf(left.key);
      const rightIndex = ORDER_FLOW_STAGE_SORT_ORDER.indexOf(right.key);
      if (leftIndex !== rightIndex) {
        return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
      }
      return left.label.localeCompare(right.label);
    })
    .map((stage) => ({
      key: `${ORDER_FLOW_STAGE_FILTER_PREFIX}${stage.key}`,
      label: stage.label,
      count: stage.count,
    }));
  const filters = [
    { key: 'all', label: 'All', count: issues.length },
    { key: 'critical', label: 'Critical', count: issues.filter((issue) => issue.severity === 'critical').length },
    { key: 'unstarted', label: 'New Order', count: issues.filter((issue) => issue.type === 'unstarted').length },
    { key: 'untracked', label: 'No Tracker', count: issues.filter((issue) => issue.type === 'untracked').length },
    ...stageFilters,
    { key: 'warning', label: 'Warnings', count: issues.filter((issue) => issue.severity === 'warning').length },
    ...getOrderFlowStackKeys().map((stackKey) => ({
      key: stackKey,
      label: ORDER_FLOW_EXCEPTION_STACKS[stackKey].label,
      count: getStackCount(stackKey),
    })),
  ];

  container.innerHTML = filters.map((filter) => `
    <button
      type="button"
      class="order-flow-filter${orderFlowActiveFilter === filter.key ? ' is-active' : ''}"
      data-order-flow-filter="${escapeHtmlAttribute(filter.key)}"
    >
      <span>${escapeHtml(filter.label)}</span>
      <strong>${escapeHtml(filter.count)}</strong>
    </button>
  `).join('');

  container.querySelectorAll('[data-order-flow-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      orderFlowActiveFilter = String(button.dataset.orderFlowFilter || 'all');
      renderFilters();
      renderIssues();
    });
  });
}

function renderIssueTags(issue) {
  const tags = Array.isArray(issue?.tags) ? issue.tags : [];
  if (!tags.length) return '';
  return `
    <div class="order-flow-issue__tags">
      ${tags.slice(0, 5).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}
    </div>
  `;
}

function renderIssue(issue, { stackKey = '' } = {}) {
  const orderLabel = issue.orderNumber || issue.barcode || 'Unknown order';
  const viewerUrl = buildOrderViewerUrl(issue);
  const stageLabel = getIssueStageLabel(issue);
  const severity = String(issue.severity || 'warning');
  const idleLabel = issue.idleWorkingDays == null ? '-' : formatWorkingDays(issue.idleWorkingDays);
  const ageLabel = issue.ageWorkingDays == null ? '-' : formatWorkingDays(issue.ageWorkingDays);
  const thresholdLabel = issue.thresholdWorkingDays == null ? '-' : formatWorkingDays(issue.thresholdWorkingDays);
  const itemTitle = String(issue.firstItemTitle || '').trim();
  const itemCount = Math.max(0, Number(issue.itemCount || 0));
  const orderValueLabel = formatOrderValue(issue.orderValue);
  const sourceLabel = issue.source === 'local_tracker' ? 'Local tracker' : 'Shopify scan';
  const activeStackKey = normalizeOrderFlowStackKey(stackKey || issue.exceptionStack?.key || '');
  const stackConfig = activeStackKey ? ORDER_FLOW_EXCEPTION_STACKS[activeStackKey] : null;
  const stackedAt = issue.exceptionStack?.at || issue.snoozed?.at || null;
  const stackedBy = String(issue.exceptionStack?.by || issue.snoozed?.by || '').trim();
  const stackedAtLabel = stackedAt ? formatTimestamp(stackedAt) : '';
  const actionButtons = activeStackKey
    ? `
        <button
          type="button"
          class="order-flow-secondary-action"
          data-order-flow-unsnooze="${escapeHtmlAttribute(issue.issueKey)}"
        >
          Restore
        </button>
        <button
          type="button"
          class="order-flow-secondary-action order-flow-danger-action"
          data-order-flow-delete="${escapeHtmlAttribute(issue.issueKey)}"
        >
          Delete Forever
        </button>
      `
    : `
        ${getOrderFlowStackKeys().filter((availableStackKey) => availableStackKey !== 'snoozed').map((availableStackKey) => `
          <button
            type="button"
            class="order-flow-secondary-action"
            data-order-flow-stack="${escapeHtmlAttribute(issue.issueKey)}"
            data-order-flow-stack-value="${escapeHtmlAttribute(availableStackKey)}"
          >
            ${escapeHtml(ORDER_FLOW_EXCEPTION_STACKS[availableStackKey].label)}
          </button>
        `).join('')}
        <button
          type="button"
          class="order-flow-secondary-action"
          data-order-flow-stack="${escapeHtmlAttribute(issue.issueKey)}"
          data-order-flow-stack-value="snoozed"
        >
          Snooze
        </button>
      `;

  return `
    <article class="order-flow-issue order-flow-issue--${escapeHtmlAttribute(severity)}">
      <div class="order-flow-issue__main">
        <div class="order-flow-issue__head">
          <div>
            <p class="order-flow-issue__eyebrow">${escapeHtml(getIssueTypeLabel(issue))}</p>
            <h3>
              <a href="${escapeHtmlAttribute(viewerUrl)}">${escapeHtml(orderLabel)}</a>
            </h3>
          </div>
          <span class="order-flow-severity">${escapeHtml(severity)}</span>
        </div>
        <p class="order-flow-issue__reason">${escapeHtml(issue.reason || 'Order needs review.')}</p>
        <div class="order-flow-issue__meta">
          <span>Stage <strong>${escapeHtml(stageLabel)}</strong></span>
          ${orderValueLabel ? `<span>Value <strong>${escapeHtml(orderValueLabel)}</strong></span>` : ''}
          ${itemCount ? `<span>Items <strong>${escapeHtml(itemCount)}</strong></span>` : ''}
          <span>Idle <strong>${escapeHtml(idleLabel)}</strong></span>
          <span>Age <strong>${escapeHtml(ageLabel)}</strong></span>
          <span>Limit <strong>${escapeHtml(thresholdLabel)}</strong></span>
          <span>${escapeHtml(sourceLabel)}</span>
          ${issue.lastStaff ? `<span>Last staff <strong>${escapeHtml(issue.lastStaff)}</strong></span>` : ''}
          ${stackedAtLabel && stackConfig ? `<span>${escapeHtml(stackConfig.label)} <strong>${escapeHtml(stackedAtLabel)}</strong></span>` : ''}
          ${stackedBy ? `<span>By <strong>${escapeHtml(stackedBy)}</strong></span>` : ''}
        </div>
        ${itemTitle ? `<p class="order-flow-issue__item">${escapeHtml(itemTitle)}</p>` : ''}
        ${renderIssueTags(issue)}
      </div>
      <div class="order-flow-issue__action">
        <a href="${escapeHtmlAttribute(viewerUrl)}">Open</a>
        ${actionButtons}
      </div>
    </article>
  `;
}

function renderIssues() {
  const container = document.getElementById('orderFlowIssues');
  if (!container) return;

  const issues = getFilteredIssues();
  if (!issues.length) {
    container.innerHTML = '<p class="order-flow-empty">No orders match this filter.</p>';
    return;
  }

  const stackFilterKey = normalizeOrderFlowStackKey(orderFlowActiveFilter);
  container.innerHTML = issues
    .map((issue) => renderIssue(issue, { stackKey: stackFilterKey || issue.exceptionStack?.key || '' }))
    .join('');
}

function renderOrderFlow() {
  renderOverview();
  renderScanSummary();
  renderFilters();
  renderIssues();
}

async function updateOrderFlowExceptionStack(issueKey, stackKey = '') {
  if (orderFlowLoading) return;

  const issue = findIssueByKey(issueKey);
  if (!issue?.issueKey) return;

  const normalizedStackKey = normalizeOrderFlowStackKey(stackKey);
  const shouldStack = Boolean(normalizedStackKey);
  const stackLabel = shouldStack ? ORDER_FLOW_EXCEPTION_STACKS[normalizedStackKey].label : '';
  setLoading(true);
  setStatus(shouldStack ? `${ORDER_FLOW_EXCEPTION_STACKS[normalizedStackKey].verb}...` : 'Restoring warning...', 'info');

  try {
    const response = await fetch(shouldStack ? '/api/order-flow/stack' : '/api/order-flow/unsnooze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(shouldStack
        ? {
            issueKey: issue.issueKey,
            stack: normalizedStackKey,
            orderId: issue.orderId,
            orderNumber: issue.orderNumber,
            type: issue.type,
            stageKey: issue.currentStage?.key || '',
            reason: issue.reason || '',
          }
        : {
            issueKey: issue.issueKey,
          }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      throw new Error(data.error || (shouldStack ? 'Failed to move warning' : 'Failed to restore warning'));
    }

    setLoading(false);
    await fetchOrderFlow({ silent: true });
    setStatus(shouldStack ? `Warning moved to ${stackLabel}.` : 'Warning restored to active exceptions.', 'success');
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

async function deleteOrderFlowIssue(issueKey) {
  if (orderFlowLoading) return;

  const issue = findIssueByKey(issueKey);
  if (!issue?.issueKey) return;

  const stackKey = normalizeOrderFlowStackKey(issue.exceptionStack?.key || orderFlowActiveFilter);
  const stackLabel = stackKey ? ORDER_FLOW_EXCEPTION_STACKS[stackKey].label : 'stacked';
  const confirmed = window.confirm(`Delete this ${stackLabel} warning forever? It will not return unless the order creates a different warning.`);
  if (!confirmed) return;

  setLoading(true);
  setStatus('Deleting warning...', 'info');

  try {
    const response = await fetch('/api/order-flow/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ issueKey: issue.issueKey }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to delete warning');
    }

    setLoading(false);
    await fetchOrderFlow({ silent: true });
    setStatus('Warning deleted forever.', 'success');
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

async function fetchOrderFlow({ silent = false } = {}) {
  if (orderFlowLoading) return;
  const settings = getSettings();
  const params = new URLSearchParams();
  params.set('newOrderWorkingDays', String(settings.newOrderWorkingDays));
  params.set('staleWorkingDays', String(settings.staleWorkingDays));
  params.set('stageWorkingDays', JSON.stringify(settings.stageWorkingDays));
  params.set('maxOpenOrders', String(settings.maxOpenOrders));

  setLoading(true);
  if (!silent) setStatus('Checking open orders and tracker movement...', 'info');

  try {
    const response = await fetch(`/api/order-flow/overview?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Failed to load Monitor');
    }

    orderFlowData = data;
    updateLastUpdatedLabel(data.generatedAt);
    renderOrderFlow();
    if (!silent) {
      const issueCount = Number(data.summary?.issueCount || 0);
      setStatus(
        issueCount ? `${issueCount} Monitor ${issueCount === 1 ? 'exception' : 'exceptions'} found.` : 'No Monitor exceptions found.',
        issueCount ? 'error' : 'success'
      );
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  applyStoredSettings();

  const refreshBtn = document.getElementById('orderFlowRefreshBtn');
  const settingsForm = document.getElementById('orderFlowSettings');
  const layout = document.querySelector('.order-flow-layout');

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => fetchOrderFlow());
  }

  if (settingsForm) {
    settingsForm.addEventListener('submit', (event) => {
      event.preventDefault();
      fetchOrderFlow();
    });
    settingsForm.querySelectorAll('input').forEach((input) => {
      input.addEventListener('change', () => fetchOrderFlow());
    });
  }

  if (layout) {
    layout.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const stackButton = target?.closest('[data-order-flow-stack]');
      const unsnoozeButton = target?.closest('[data-order-flow-unsnooze]');
      const deleteButton = target?.closest('[data-order-flow-delete]');
      if (!stackButton && !unsnoozeButton && !deleteButton) return;

      event.preventDefault();
      const issueKey = String(
        stackButton?.getAttribute('data-order-flow-stack')
          || unsnoozeButton?.getAttribute('data-order-flow-unsnooze')
          || deleteButton?.getAttribute('data-order-flow-delete')
          || ''
      ).trim();

      if (deleteButton) {
        deleteOrderFlowIssue(issueKey);
        return;
      }

      updateOrderFlowExceptionStack(
        issueKey,
        stackButton ? stackButton.getAttribute('data-order-flow-stack-value') : ''
      );
    });
  }

  fetchOrderFlow();

  if (orderFlowPollId) {
    clearInterval(orderFlowPollId);
  }
  orderFlowPollId = setInterval(() => {
    fetchOrderFlow({ silent: true });
  }, ORDER_FLOW_POLL_MS);
});
