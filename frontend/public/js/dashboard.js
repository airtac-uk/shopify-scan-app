(function () {
  const DASHBOARD_SLIDE_MS = 18000;
  const DASHBOARD_REFRESH_MS = 90000;
  const ORDER_FLOW_SETTINGS_KEY = 'orderFlow.settings.v2';
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
  const DEFAULT_PRINT_STAGES = [
    { key: 'needs_printed', label: 'Needs Printed' },
    { key: 'in_build', label: 'In Build' },
    { key: 'pre_dye', label: 'Pre Dye' },
    { key: 'post_dye', label: 'Post Dye' },
    { key: 'complete', label: 'Complete' },
  ];

  const state = {
    activeSlide: 0,
    slideCount: 0,
    data: null,
    errors: [],
    updatedAt: null,
    loading: false,
  };
  let slideTimerId = null;

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

  function pluralize(value, singular, plural) {
    const count = Number(value) || 0;
    return count === 1 ? singular : plural;
  }

  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0';
    return number.toLocaleString('en-GB', { maximumFractionDigits: 0 });
  }

  function formatWorkingDays(value) {
    const days = Number(value);
    if (!Number.isFinite(days)) return '-';
    const rounded = Number(days.toFixed(2));
    return `${rounded.toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${pluralize(rounded, 'working day', 'working days')}`;
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

  function formatClock(value = new Date()) {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(value);
  }

  function formatStageKeyLabel(stageKey) {
    return String(stageKey || '')
      .trim()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
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

  function clampNumber(value, fallback, { min = 0.25, max = 1000 } = {}) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function loadOrderFlowSettings() {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(ORDER_FLOW_SETTINGS_KEY) || '{}') || {};
    } catch (_err) {
      stored = {};
    }

    const stageWorkingDays = ORDER_FLOW_STAGE_SORT_ORDER.reduce((acc, stageKey) => {
      acc[stageKey] = clampNumber(
        stored.stageWorkingDays?.[stageKey],
        ORDER_FLOW_DEFAULT_STAGE_WORKING_DAYS[stageKey],
        { min: 0.25, max: 60 }
      );
      return acc;
    }, {});

    return {
      newOrderWorkingDays: clampNumber(stored.newOrderWorkingDays, 1, { min: 0.25, max: 30 }),
      staleWorkingDays: clampNumber(stored.staleWorkingDays, 1, { min: 0.25, max: 60 }),
      maxOpenOrders: Math.max(50, Math.floor(clampNumber(stored.maxOpenOrders, 500, { min: 50, max: 1000 }))),
      stageWorkingDays,
    };
  }

  function buildOrderFlowUrl() {
    const settings = loadOrderFlowSettings();
    const params = new URLSearchParams();
    params.set('newOrderWorkingDays', String(settings.newOrderWorkingDays));
    params.set('staleWorkingDays', String(settings.staleWorkingDays));
    params.set('maxOpenOrders', String(settings.maxOpenOrders));
    params.set('stageWorkingDays', JSON.stringify(settings.stageWorkingDays));
    return `/api/order-flow/overview?${params.toString()}`;
  }

  async function fetchJson(url, label) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    let data = null;
    try {
      data = await response.json();
    } catch (_err) {
      data = null;
    }
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || `${label} failed`);
    }
    return data;
  }

  function getPrintItemTotalQuantity(item) {
    const ownQuantity = Math.max(1, Number(item?.quantity) || 1);
    const childQuantity = (Array.isArray(item?.childItems) ? item.childItems : [])
      .reduce((sum, childItem) => sum + Math.max(1, Number(childItem?.quantity) || 1), 0);
    return ownQuantity + childQuantity;
  }

  function getPrintItemLabel(item) {
    const sku = String(item?.sku || '').trim();
    return sku || String(item?.title || '').trim() || `Print item ${item?.id || ''}`;
  }

  function formatPartQuantity(value) {
    const quantity = Math.max(0, Number(value) || 0);
    return `${formatNumber(quantity)} ${pluralize(quantity, 'part', 'parts')}`;
  }

  function summarizePrintQueue(data, fallbackLabel) {
    const stages = Array.isArray(data?.stages) && data.stages.length ? data.stages : DEFAULT_PRINT_STAGES;
    const items = Array.isArray(data?.items) ? data.items : [];
    const label = String(data?.queue?.shortLabel || fallbackLabel || data?.queue?.label || '').trim() || fallbackLabel;
    const stageStats = stages.map((stage) => {
      const stageItems = items.filter((item) => String(item?.stageKey || '') === stage.key);
      const quantity = stageItems.reduce((sum, item) => sum + getPrintItemTotalQuantity(item), 0);
      return {
        key: stage.key,
        label: stage.label,
        items: stageItems,
        jobCount: stageItems.length,
        quantity,
      };
    });
    const activeItems = items.filter((item) => String(item?.stageKey || '') !== 'complete');
    const activeQuantity = activeItems.reduce((sum, item) => sum + getPrintItemTotalQuantity(item), 0);
    return {
      label,
      items,
      stages,
      stageStats,
      activeItems,
      activeJobCount: activeItems.length,
      activeQuantity,
      needsPrinted: stageStats.find((stage) => stage.key === 'needs_printed') || null,
      inBuild: stageStats.find((stage) => stage.key === 'in_build') || null,
    };
  }

  function summarizeAwaitingParts(data) {
    const items = Array.isArray(data?.items) ? data.items : [];
    const filters = Array.isArray(data?.filters) ? data.filters : [];
    const uniqueOrders = new Set();
    let totalQuantity = 0;
    let oldestOpenAt = null;

    items.forEach((item) => {
      totalQuantity += Number(item?.totalQuantity || 0);
      (Array.isArray(item?.orders) ? item.orders : []).forEach((order) => {
        const orderKey = String(order?.orderId || order?.orderNumber || '').trim();
        if (orderKey) uniqueOrders.add(orderKey);
        if (order?.createdAt && (!oldestOpenAt || String(order.createdAt) < String(oldestOpenAt))) {
          oldestOpenAt = order.createdAt;
        }
      });
    });

    return {
      items,
      filters,
      openPartSkuCount: items.length,
      blockedOrderCount: uniqueOrders.size,
      totalQuantity,
      oldestOpenAt,
      topItems: items.slice(0, 8),
    };
  }

  function buildStageIssueGroups(issues) {
    const groups = (Array.isArray(issues) ? issues : [])
      .filter((issue) => String(issue?.type || '') === 'stale_stage')
      .reduce((acc, issue) => {
        const key = getIssueStageKey(issue);
        const existing = acc.get(key) || {
          key,
          label: getIssueStageLabel(issue),
          count: 0,
          criticalCount: 0,
        };
        existing.count += 1;
        if (String(issue?.severity || '') === 'critical') existing.criticalCount += 1;
        acc.set(key, existing);
        return acc;
      }, new Map());

    return Array.from(groups.values()).sort((left, right) => {
      const criticalDiff = right.criticalCount - left.criticalCount;
      if (criticalDiff !== 0) return criticalDiff;
      const countDiff = right.count - left.count;
      if (countDiff !== 0) return countDiff;
      return left.label.localeCompare(right.label);
    });
  }

  function renderErrorPanel(title, error) {
    return `
      <section class="dashboard-panel dashboard-panel--error">
        <p class="dashboard-panel__eyebrow">Unavailable</p>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(error?.message || 'This panel could not be loaded.')}</p>
      </section>
    `;
  }

  function renderMetric(label, value, tone = '') {
    return `
      <article class="dashboard-metric${tone ? ` dashboard-metric--${escapeHtmlAttribute(tone)}` : ''}">
        <p>${escapeHtml(label)}</p>
        <strong>${escapeHtml(value)}</strong>
      </article>
    `;
  }

  function renderDailyOutputMetric(metric) {
    const today = Number(metric?.today || 0);
    const yesterday = Number(metric?.yesterday || 0);
    const week = Number(metric?.week || 0);
    const delta = Number(metric?.delta || 0);
    const tone = delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat');
    const deltaLabel = delta > 0 ? `+${formatNumber(delta)}` : formatNumber(delta);

    return `
      <article class="dashboard-output-card dashboard-output-card--${escapeHtmlAttribute(tone)}">
        <p>${escapeHtml(metric?.label || 'Output')}</p>
        <strong>${escapeHtml(formatNumber(today))}</strong>
        <div class="dashboard-output-card__meta">
          <span>Yesterday <b>${escapeHtml(formatNumber(yesterday))}</b></span>
          <span class="dashboard-output-delta">${escapeHtml(deltaLabel)}</span>
          <span>Week <b>${escapeHtml(formatNumber(week))}</b></span>
        </div>
      </article>
    `;
  }

  function renderDailyOutputSlide(data, error) {
    if (error) {
      return `
        <article class="dashboard-slide">
          <div class="dashboard-slide__head">
            <p class="dashboard-slide__eyebrow">Daily Output</p>
            <h2>Production Totals</h2>
          </div>
          ${renderErrorPanel('Daily Output', error)}
        </article>
      `;
    }

    const metrics = Array.isArray(data?.metrics) ? data.metrics : [];
    const topStaff = Array.isArray(data?.topStaff) ? data.topStaff : [];
    const staffRows = topStaff.map((item) => `
      <div class="dashboard-stage-row">
        <span>${escapeHtml(item.staff || 'Unknown')}</span>
        <strong>${escapeHtml(formatNumber(item.count || 0))}</strong>
      </div>
    `).join('');

    return `
      <article class="dashboard-slide">
        <div class="dashboard-slide__head">
          <p class="dashboard-slide__eyebrow">Daily Output</p>
          <h2>Production Totals</h2>
        </div>
        <div class="dashboard-grid dashboard-grid--daily">
          <section class="dashboard-panel dashboard-output-panel">
            <div class="dashboard-output-grid">
              ${metrics.length ? metrics.map(renderDailyOutputMetric).join('') : '<p class="dashboard-empty-text">No output data available.</p>'}
            </div>
          </section>
          <section class="dashboard-panel dashboard-output-staff-panel">
            <div class="dashboard-panel__head">
              <p class="dashboard-panel__eyebrow">Today By Staff</p>
              <h3>${escapeHtml(formatNumber(topStaff.reduce((sum, item) => sum + Number(item.count || 0), 0)))}</h3>
            </div>
            <div class="dashboard-stage-list">
              ${staffRows || '<p class="dashboard-empty-text">No staff activity recorded today.</p>'}
            </div>
          </section>
        </div>
      </article>
    `;
  }

  function renderIssueRow(issue) {
    const orderLabel = String(issue?.orderNumber || issue?.barcode || 'Unknown order').trim();
    const severity = String(issue?.severity || 'warning').trim();
    const idle = issue?.idleWorkingDays == null ? issue?.ageWorkingDays : issue.idleWorkingDays;
    return `
      <li class="dashboard-list-row dashboard-list-row--${escapeHtmlAttribute(severity)}">
        <div>
          <span>${escapeHtml(getIssueTypeLabel(issue))}</span>
          <strong>${escapeHtml(orderLabel)}</strong>
        </div>
        <div>
          <span>${escapeHtml(getIssueStageLabel(issue))}</span>
          <strong>${escapeHtml(formatWorkingDays(idle))}</strong>
        </div>
      </li>
    `;
  }

  function renderEmptyList(message) {
    return `<li class="dashboard-empty-row">${escapeHtml(message)}</li>`;
  }

  function renderMonitorSlide(data, error) {
    if (error) {
      return `
        <article class="dashboard-slide">
          <div class="dashboard-slide__head">
            <p class="dashboard-slide__eyebrow">Monitor</p>
            <h2>Order Flow</h2>
          </div>
          ${renderErrorPanel('Monitor', error)}
        </article>
      `;
    }

    const summary = data?.summary || {};
    const issues = Array.isArray(data?.issues) ? data.issues : [];
    const stageGroups = buildStageIssueGroups(issues).slice(0, 6);
    const issueRows = issues.slice(0, 8).map(renderIssueRow).join('');
    const scan = data?.scan || {};

    return `
      <article class="dashboard-slide">
        <div class="dashboard-slide__head">
          <p class="dashboard-slide__eyebrow">Monitor</p>
          <h2>Order Flow</h2>
          <span>${escapeHtml(formatNumber(scan.openOrdersScanned || summary.openOrdersScanned || 0))} open Shopify orders scanned</span>
        </div>
        <div class="dashboard-grid dashboard-grid--monitor">
          <section class="dashboard-panel dashboard-panel--wide">
            <div class="dashboard-metric-grid">
              ${renderMetric('Critical', formatNumber(summary.criticalCount || 0), 'danger')}
              ${renderMetric('New Orders', formatNumber(summary.unstartedCount || 0), 'accent')}
              ${renderMetric('No Tracker', formatNumber(summary.untrackedCount || 0), 'warning')}
              ${renderMetric('Stuck Statuses', formatNumber(summary.staleStageCount || 0), 'warning')}
              ${renderMetric('Snoozed', formatNumber(summary.snoozedCount || 0))}
              ${renderMetric('Active Trackers', formatNumber(summary.activeTrackersScanned || 0))}
            </div>
          </section>
          <section class="dashboard-panel">
            <div class="dashboard-panel__head">
              <p class="dashboard-panel__eyebrow">Priority Exceptions</p>
              <h3>${escapeHtml(formatNumber(issues.length))} active</h3>
            </div>
            <ul class="dashboard-list">
              ${issueRows || renderEmptyList('No active order warnings.')}
            </ul>
          </section>
          <section class="dashboard-panel">
            <div class="dashboard-panel__head">
              <p class="dashboard-panel__eyebrow">Stuck Statuses</p>
              <h3>${escapeHtml(formatNumber(stageGroups.reduce((sum, item) => sum + item.count, 0)))}</h3>
            </div>
            <div class="dashboard-stage-list">
              ${stageGroups.length ? stageGroups.map((stage) => `
                <div class="dashboard-stage-row">
                  <span>${escapeHtml(stage.label)}</span>
                  <strong>${escapeHtml(formatNumber(stage.count))}</strong>
                </div>
              `).join('') : '<p class="dashboard-empty-text">No stale status warnings.</p>'}
            </div>
          </section>
        </div>
      </article>
    `;
  }

  function renderQueueStageChart(queue) {
    const maxQuantity = Math.max(1, ...queue.stageStats.map((stage) => Number(stage.quantity || 0)));
    return `
      <div class="dashboard-stage-bars">
        ${queue.stageStats.map((stage) => {
          const width = Math.max(2, Math.round((Number(stage.quantity || 0) / maxQuantity) * 100));
          return `
            <div class="dashboard-stage-bar">
              <div class="dashboard-stage-bar__label">
                <span>${escapeHtml(stage.label)}</span>
                <strong>${escapeHtml(formatPartQuantity(stage.quantity))}</strong>
              </div>
              <div class="dashboard-stage-bar__track">
                <span style="width: ${escapeHtmlAttribute(width)}%;"></span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderQueuePanel(queue, error, fallbackLabel) {
    if (error) return renderErrorPanel(fallbackLabel, error);
    return `
      <section class="dashboard-panel dashboard-print-panel">
        <div class="dashboard-panel__head">
          <p class="dashboard-panel__eyebrow">${escapeHtml(queue.label)}</p>
          <h3>${escapeHtml(formatPartQuantity(queue.activeQuantity))}</h3>
        </div>
        <div class="dashboard-print-stats">
          ${renderMetric('Active Jobs', formatNumber(queue.activeJobCount))}
          ${renderMetric('Needs Printed', formatPartQuantity(queue.needsPrinted?.quantity || 0), 'accent')}
          ${renderMetric('In Build', formatPartQuantity(queue.inBuild?.quantity || 0), 'warning')}
        </div>
        ${renderQueueStageChart(queue)}
      </section>
    `;
  }

  function renderProductionSlide(data, errorsByKey) {
    const slsQueue = data?.printSls ? summarizePrintQueue(data.printSls, 'SLS / Adapter') : null;
    const fdmQueue = data?.printFdm ? summarizePrintQueue(data.printFdm, 'FDM') : null;
    const totalActiveQty = (slsQueue?.activeQuantity || 0) + (fdmQueue?.activeQuantity || 0);
    const totalActiveJobs = (slsQueue?.activeJobCount || 0) + (fdmQueue?.activeJobCount || 0);

    return `
      <article class="dashboard-slide">
        <div class="dashboard-slide__head">
          <p class="dashboard-slide__eyebrow">Production</p>
          <h2>Print Queues</h2>
          <span>${escapeHtml(formatNumber(totalActiveJobs))} active ${escapeHtml(pluralize(totalActiveJobs, 'job', 'jobs'))} / ${escapeHtml(formatPartQuantity(totalActiveQty))}</span>
        </div>
        <div class="dashboard-grid dashboard-grid--two">
          ${renderQueuePanel(slsQueue, errorsByKey.printSls, 'SLS / Adapter')}
          ${renderQueuePanel(fdmQueue, errorsByKey.printFdm, 'FDM')}
        </div>
      </article>
    `;
  }

  function renderAwaitingPartRow(item) {
    const orders = Number(item?.openOrderCount || 0);
    const quantity = Number(item?.totalQuantity || 0);
    return `
      <li class="dashboard-list-row">
        <div>
          <span>${escapeHtml(item?.partTypeGroup || 'UNKNOWN')}</span>
          <strong>${escapeHtml(item?.partSku || 'Unknown SKU')}</strong>
        </div>
        <div>
          <span>${escapeHtml(formatTimestamp(item?.oldestOpenAt))}</span>
          <strong>${escapeHtml(formatNumber(orders))} ${escapeHtml(pluralize(orders, 'order', 'orders'))} / ${escapeHtml(formatNumber(quantity))}</strong>
        </div>
      </li>
    `;
  }

  function renderAwaitingPartsSlide(data, error) {
    if (error) {
      return `
        <article class="dashboard-slide">
          <div class="dashboard-slide__head">
            <p class="dashboard-slide__eyebrow">Awaiting Parts</p>
            <h2>Blocked Orders</h2>
          </div>
          ${renderErrorPanel('Awaiting Parts', error)}
        </article>
      `;
    }

    const summary = summarizeAwaitingParts(data);
    const filterRows = summary.filters.slice(0, 4).map((filter) => `
      <div class="dashboard-stage-row">
        <span>${escapeHtml(filter.typeGroup || 'UNKNOWN')}</span>
        <strong>${escapeHtml(formatNumber(filter.openOrderCount || 0))}</strong>
      </div>
    `).join('');

    return `
      <article class="dashboard-slide">
        <div class="dashboard-slide__head">
          <p class="dashboard-slide__eyebrow">Awaiting Parts</p>
          <h2>Blocked Orders</h2>
          <span>${escapeHtml(formatNumber(summary.blockedOrderCount))} blocked ${escapeHtml(pluralize(summary.blockedOrderCount, 'order', 'orders'))}</span>
        </div>
        <div class="dashboard-grid dashboard-grid--awaiting">
          <section class="dashboard-panel dashboard-panel--wide">
            <div class="dashboard-metric-grid dashboard-metric-grid--four">
              ${renderMetric('Open Part SKUs', formatNumber(summary.openPartSkuCount), 'accent')}
              ${renderMetric('Blocked Orders', formatNumber(summary.blockedOrderCount), 'danger')}
              ${renderMetric('Requested Qty', formatNumber(summary.totalQuantity), 'warning')}
              ${renderMetric('Oldest Open', formatTimestamp(summary.oldestOpenAt))}
            </div>
          </section>
          <section class="dashboard-panel">
            <div class="dashboard-panel__head">
              <p class="dashboard-panel__eyebrow">Priority Parts</p>
              <h3>Top ${escapeHtml(formatNumber(summary.topItems.length))}</h3>
            </div>
            <ul class="dashboard-list">
              ${summary.topItems.length ? summary.topItems.map(renderAwaitingPartRow).join('') : renderEmptyList('No open awaiting-parts items.')}
            </ul>
          </section>
          <section class="dashboard-panel">
            <div class="dashboard-panel__head">
              <p class="dashboard-panel__eyebrow">By Type</p>
              <h3>${escapeHtml(formatNumber(summary.filters.length))} groups</h3>
            </div>
            <div class="dashboard-stage-list">
              ${filterRows || '<p class="dashboard-empty-text">No type groups currently blocked.</p>'}
            </div>
          </section>
        </div>
      </article>
    `;
  }

  function getIssueActionItems(monitorData) {
    return (Array.isArray(monitorData?.issues) ? monitorData.issues : [])
      .slice(0, 8)
      .map((issue) => ({
        tone: String(issue?.severity || 'warning') === 'critical' ? 'danger' : 'warning',
        label: getIssueTypeLabel(issue),
        title: String(issue?.orderNumber || issue?.barcode || 'Unknown order').trim(),
        meta: `${getIssueStageLabel(issue)} / ${formatWorkingDays(issue?.idleWorkingDays ?? issue?.ageWorkingDays)}`,
      }));
  }

  function getPrintActionItems(queue, label) {
    const stagePriority = new Map([
      ['needs_printed', 0],
      ['in_build', 1],
      ['pre_dye', 2],
      ['post_dye', 3],
    ]);
    return (queue?.activeItems || [])
      .filter((item) => stagePriority.has(String(item?.stageKey || '')))
      .sort((left, right) => {
        const priorityDiff = stagePriority.get(String(left?.stageKey || '')) - stagePriority.get(String(right?.stageKey || ''));
        if (priorityDiff !== 0) return priorityDiff;
        return String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || ''));
      })
      .slice(0, 4)
      .map((item) => ({
        tone: String(item?.stageKey || '') === 'needs_printed' ? 'accent' : 'warning',
        label,
        title: getPrintItemLabel(item),
        meta: `${formatStageKeyLabel(item?.stageKey)} / ${formatPartQuantity(getPrintItemTotalQuantity(item))}`,
      }));
  }

  function getAwaitingActionItems(awaitingData) {
    return summarizeAwaitingParts(awaitingData).topItems.slice(0, 4).map((item) => ({
      tone: 'danger',
      label: 'Awaiting Parts',
      title: String(item?.partSku || 'Unknown SKU').trim(),
      meta: `${formatNumber(item?.openOrderCount || 0)} ${pluralize(item?.openOrderCount || 0, 'order', 'orders')} / ${formatNumber(item?.totalQuantity || 0)} requested`,
    }));
  }

  function renderActionItem(item) {
    return `
      <li class="dashboard-action-row dashboard-action-row--${escapeHtmlAttribute(item.tone || 'info')}">
        <span>${escapeHtml(item.label)}</span>
        <strong>${escapeHtml(item.title)}</strong>
        <em>${escapeHtml(item.meta)}</em>
      </li>
    `;
  }

  function renderActionQueueSlide(data) {
    const slsQueue = data?.printSls ? summarizePrintQueue(data.printSls, 'SLS / Adapter') : null;
    const fdmQueue = data?.printFdm ? summarizePrintQueue(data.printFdm, 'FDM') : null;
    const actionItems = [
      ...getIssueActionItems(data?.monitor),
      ...getAwaitingActionItems(data?.awaitingParts),
      ...getPrintActionItems(slsQueue, 'SLS / Adapter'),
      ...getPrintActionItems(fdmQueue, 'FDM'),
    ].slice(0, 14);
    const criticalCount = actionItems.filter((item) => item.tone === 'danger').length;

    return `
      <article class="dashboard-slide">
        <div class="dashboard-slide__head">
          <p class="dashboard-slide__eyebrow">Action Queue</p>
          <h2>What Needs Attention</h2>
          <span>${escapeHtml(formatNumber(criticalCount))} critical ${escapeHtml(pluralize(criticalCount, 'item', 'items'))}</span>
        </div>
        <section class="dashboard-panel dashboard-action-panel">
          <ul class="dashboard-action-list">
            ${actionItems.length ? actionItems.map(renderActionItem).join('') : renderEmptyList('No urgent action items.')}
          </ul>
        </section>
      </article>
    `;
  }

  function setActiveSlide(index) {
    const slides = Array.from(document.querySelectorAll('.dashboard-slide'));
    const dots = Array.from(document.querySelectorAll('.dashboard-dot'));
    if (!slides.length) return;

    state.activeSlide = ((index % slides.length) + slides.length) % slides.length;
    slides.forEach((slide, slideIndex) => {
      slide.classList.toggle('is-active', slideIndex === state.activeSlide);
    });
    dots.forEach((dot, dotIndex) => {
      const isActive = dotIndex === state.activeSlide;
      dot.classList.toggle('is-active', isActive);
      dot.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      if (isActive) {
        dot.setAttribute('aria-current', 'true');
      } else {
        dot.removeAttribute('aria-current');
      }
    });
  }

  function renderDots(count) {
    const container = document.getElementById('dashboardDots');
    if (!container) return;
    container.innerHTML = Array.from({ length: count }, (_item, index) => `
      <button
        type="button"
        class="dashboard-dot${index === state.activeSlide ? ' is-active' : ''}"
        data-dashboard-slide="${escapeHtmlAttribute(index)}"
        aria-label="Show dashboard ${escapeHtmlAttribute(index + 1)}"
        aria-pressed="${index === state.activeSlide ? 'true' : 'false'}"
        ${index === state.activeSlide ? 'aria-current="true"' : ''}
      ></button>
    `).join('');
  }

  function scheduleSlideRotation() {
    if (slideTimerId) {
      clearTimeout(slideTimerId);
    }
    slideTimerId = setTimeout(() => {
      if (state.slideCount > 1) setActiveSlide(state.activeSlide + 1);
      scheduleSlideRotation();
    }, DASHBOARD_SLIDE_MS);
  }

  function bindDotNavigation() {
    const container = document.getElementById('dashboardDots');
    if (!container) return;
    container.addEventListener('click', (event) => {
      const button = event.target instanceof Element
        ? event.target.closest('[data-dashboard-slide]')
        : null;
      if (!button) return;

      const index = Number(button.getAttribute('data-dashboard-slide'));
      if (!Number.isFinite(index)) return;
      setActiveSlide(index);
      scheduleSlideRotation();
    });
  }

  function renderDashboard() {
    const container = document.getElementById('dashboardSlides');
    if (!container) return;

    const data = state.data || {};
    const errorsByKey = state.errors.reduce((acc, item) => {
      acc[item.key] = item.error;
      return acc;
    }, {});
    const slides = [
      renderDailyOutputSlide(data.dailyOutput, errorsByKey.dailyOutput),
      renderMonitorSlide(data.monitor, errorsByKey.monitor),
      renderProductionSlide(data, errorsByKey),
      renderAwaitingPartsSlide(data.awaitingParts, errorsByKey.awaitingParts),
      renderActionQueueSlide(data),
    ];

    state.slideCount = slides.length;
    container.innerHTML = slides.join('');
    renderDots(slides.length);
    setActiveSlide(Math.min(state.activeSlide, slides.length - 1));
    renderStatus();
  }

  function renderStatus() {
    const statusEl = document.getElementById('dashboardStatus');
    const updatedEl = document.getElementById('dashboardLastUpdated');
    if (statusEl) {
      if (state.loading) {
        statusEl.textContent = 'Refreshing.';
        statusEl.dataset.type = 'info';
      } else if (state.errors.length) {
        statusEl.textContent = `${state.errors.length} panel ${pluralize(state.errors.length, 'error', 'errors')}.`;
        statusEl.dataset.type = 'error';
      } else {
        statusEl.textContent = 'Live.';
        statusEl.dataset.type = 'success';
      }
    }
    if (updatedEl) {
      updatedEl.textContent = state.updatedAt
        ? `Last refreshed ${formatTimestamp(state.updatedAt)}`
        : 'Waiting for first load.';
    }
  }

  async function refreshDashboard() {
    if (state.loading) return;
    state.loading = true;
    renderStatus();

    const requests = [
      ['dailyOutput', fetchJson('/api/dashboard/daily-output', 'Daily Output')],
      ['monitor', fetchJson(buildOrderFlowUrl(), 'Monitor')],
      ['awaitingParts', fetchJson('/api/awaiting-parts-summary', 'Awaiting Parts')],
      ['printSls', fetchJson('/api/print-queue?queue=sls', 'Print Queue')],
      ['printFdm', fetchJson('/api/print-queue?queue=fdm', 'FDM Print Queue')],
    ];
    const results = await Promise.allSettled(requests.map((item) => item[1]));
    const nextData = {};
    const errors = [];

    results.forEach((result, index) => {
      const key = requests[index][0];
      if (result.status === 'fulfilled') {
        nextData[key] = result.value;
      } else {
        nextData[key] = state.data?.[key] || null;
        errors.push({ key, error: result.reason });
      }
    });

    state.data = nextData;
    state.errors = errors;
    state.updatedAt = new Date().toISOString();
    state.loading = false;
    renderDashboard();
  }

  function tickClock() {
    const el = document.getElementById('dashboardClock');
    if (el) {
      const now = new Date();
      el.textContent = formatClock(now);
      el.dateTime = now.toISOString();
    }
  }

  function init() {
    tickClock();
    bindDotNavigation();
    setInterval(tickClock, 10000);
    refreshDashboard();
    setInterval(refreshDashboard, DASHBOARD_REFRESH_MS);
    scheduleSlideRotation();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}());
