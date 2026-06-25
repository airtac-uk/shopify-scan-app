(function () {
  const DASHBOARD_REFRESH_MS = 90000;

  const state = {
    data: null,
    selectedDate: getTodayDateKey(),
    activeMetricKey: '',
    loading: false,
    error: null,
    updatedAt: null,
  };

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

  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0';
    return number.toLocaleString('en-GB', { maximumFractionDigits: 0 });
  }

  function formatDateLabel(dateKey) {
    const date = parseDateKey(dateKey);
    if (!date) return dateKey || '';
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(date);
  }

  function formatShortDateLabel(dateKey) {
    const date = parseDateKey(dateKey);
    if (!date) return dateKey || '';
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(date);
  }

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  function formatRefreshTime(value) {
    if (!value) return 'Waiting for first load.';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Waiting for first load.';
    return `Last refreshed ${new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)}`;
  }

  function getTodayDateKey() {
    return dateToKey(new Date());
  }

  function dateToKey(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
  }

  function parseDateKey(value) {
    const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function shiftDateKey(dateKey, offsetDays) {
    const date = parseDateKey(dateKey) || new Date();
    date.setDate(date.getDate() + offsetDays);
    return dateToKey(date);
  }

  function isFutureDate(dateKey) {
    const selected = parseDateKey(dateKey);
    const today = parseDateKey(getTodayDateKey());
    return Boolean(selected && today && selected.getTime() > today.getTime());
  }

  function isToday(dateKey) {
    return dateKey === getTodayDateKey();
  }

  async function fetchJson(url) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || 'Failed to load dashboard data');
    }
    return data;
  }

  function getMetrics() {
    return Array.isArray(state.data?.metrics) ? state.data.metrics : [];
  }

  function getActiveMetric() {
    const metrics = getMetrics();
    return metrics.find((metric) => metric.key === state.activeMetricKey) || metrics[0] || null;
  }

  function getMaxCount(items, field = 'count') {
    return Math.max(1, ...items.map((item) => Number(item?.[field] || 0)));
  }

  function getDeltaTone(metric) {
    const delta = Number(metric?.delta || 0);
    if (delta > 0) return 'up';
    if (delta < 0) return 'down';
    return 'flat';
  }

  function formatDelta(metric) {
    const delta = Number(metric?.delta || 0);
    return delta > 0 ? `+${formatNumber(delta)}` : formatNumber(delta);
  }

  function renderMetricCard(metric) {
    const isActive = metric.key === getActiveMetric()?.key;
    const tone = getDeltaTone(metric);
    return `
      <button
        type="button"
        class="dashboard-output-card dashboard-output-card--${escapeHtmlAttribute(tone)}${isActive ? ' is-active' : ''}"
        data-dashboard-metric="${escapeHtmlAttribute(metric.key)}"
        aria-pressed="${isActive ? 'true' : 'false'}"
      >
        <p>${escapeHtml(metric.label || 'Output')}</p>
        <strong>${escapeHtml(formatNumber(metric.today))}</strong>
        <div class="dashboard-output-card__meta">
          <span>Yesterday <b>${escapeHtml(formatNumber(metric.yesterday))}</b></span>
          <span class="dashboard-output-delta">${escapeHtml(formatDelta(metric))}</span>
          <span>Week <b>${escapeHtml(formatNumber(metric.week))}</b></span>
        </div>
      </button>
    `;
  }

  function renderTrendChart(metric) {
    const trend = Array.isArray(metric?.trend) ? metric.trend : [];
    const max = getMaxCount(trend);
    return `
      <div class="dashboard-chart dashboard-chart--trend">
        ${trend.map((point) => {
          const count = Number(point.count || 0);
          const height = Math.max(3, Math.round((count / max) * 100));
          const active = point.date === state.selectedDate;
          return `
            <div class="dashboard-chart-bar${active ? ' is-active' : ''}">
              <span class="dashboard-chart-bar__value">${escapeHtml(formatNumber(count))}</span>
              <div class="dashboard-chart-bar__track">
                <span style="height: ${escapeHtmlAttribute(height)}%;"></span>
              </div>
              <span class="dashboard-chart-bar__label">${escapeHtml(point.label || formatShortDateLabel(point.date))}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderHourlyChart(metric) {
    const hourly = Array.isArray(metric?.hourly) ? metric.hourly : [];
    const usefulHours = hourly.filter((point) => Number(point.count || 0) > 0);
    const hours = usefulHours.length ? hourly : hourly.filter((point) => (
      Number(point.hour) >= 7 && Number(point.hour) <= 19
    ));
    const max = getMaxCount(hours);
    return `
      <div class="dashboard-hourly-chart">
        ${hours.map((point) => {
          const count = Number(point.count || 0);
          const height = Math.max(3, Math.round((count / max) * 100));
          return `
            <div class="dashboard-hourly-bar">
              <span class="dashboard-hourly-bar__value">${count ? escapeHtml(formatNumber(count)) : ''}</span>
              <div class="dashboard-hourly-bar__track">
                <span style="height: ${escapeHtmlAttribute(height)}%;"></span>
              </div>
              <span>${escapeHtml(String(point.hour).padStart(2, '0'))}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderStaffRows(metric) {
    const staff = Array.isArray(metric?.staff) ? metric.staff : [];
    const max = getMaxCount(staff);
    if (!staff.length) {
      return '<p class="dashboard-empty-text">No staff activity for this stat.</p>';
    }
    return staff.map((item) => {
      const count = Number(item.count || 0);
      const width = Math.max(3, Math.round((count / max) * 100));
      return `
        <div class="dashboard-staff-row">
          <div>
            <span>${escapeHtml(item.staff || 'Unknown')}</span>
            <strong>${escapeHtml(formatNumber(count))}</strong>
          </div>
          <div class="dashboard-staff-row__bar">
            <span style="width: ${escapeHtmlAttribute(width)}%;"></span>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderRecentRows(metric) {
    const rows = Array.isArray(metric?.recentOrders) ? metric.recentOrders : [];
    if (!rows.length) {
      return '<p class="dashboard-empty-text">No orders recorded for this stat.</p>';
    }
    return rows.map((row) => `
      <div class="dashboard-recent-row">
        <strong>${escapeHtml(row.orderNumber || row.barcode || row.orderId || 'Unknown')}</strong>
        <span>${escapeHtml(row.staff || 'Unknown')}</span>
        <span>${escapeHtml(formatTime(row.createdAt))}</span>
      </div>
    `).join('');
  }

  function renderDetailPanel(metric) {
    if (!metric) {
      return `
        <section class="dashboard-panel dashboard-detail-panel">
          <p class="dashboard-empty-text">No dashboard data available.</p>
        </section>
      `;
    }

    return `
      <section class="dashboard-panel dashboard-detail-panel">
        <div class="dashboard-detail-head">
          <div>
            <p>${escapeHtml(metric.label)}</p>
            <strong>${escapeHtml(formatNumber(metric.today))}</strong>
          </div>
          <div class="dashboard-detail-head__meta">
            <span>Yesterday <b>${escapeHtml(formatNumber(metric.yesterday))}</b></span>
            <span>Change <b>${escapeHtml(formatDelta(metric))}</b></span>
            <span>Week <b>${escapeHtml(formatNumber(metric.week))}</b></span>
          </div>
        </div>

        <div class="dashboard-detail-grid">
          <section class="dashboard-detail-block dashboard-detail-block--wide">
            <div class="dashboard-detail-block__head">
              <span>Last 7 Days</span>
            </div>
            ${renderTrendChart(metric)}
          </section>

          <section class="dashboard-detail-block dashboard-detail-block--wide">
            <div class="dashboard-detail-block__head">
              <span>Selected Day By Hour</span>
            </div>
            ${renderHourlyChart(metric)}
          </section>

          <section class="dashboard-detail-block">
            <div class="dashboard-detail-block__head">
              <span>Staff</span>
            </div>
            <div class="dashboard-staff-list">
              ${renderStaffRows(metric)}
            </div>
          </section>

          <section class="dashboard-detail-block">
            <div class="dashboard-detail-block__head">
              <span>Recent Orders</span>
            </div>
            <div class="dashboard-recent-list">
              ${renderRecentRows(metric)}
            </div>
          </section>
        </div>
      </section>
    `;
  }

  function renderToolbar() {
    const today = getTodayDateKey();
    const nextDate = shiftDateKey(state.selectedDate, 1);
    return `
      <section class="dashboard-output-toolbar">
        <button type="button" class="dashboard-nav-btn" data-dashboard-date="prev" aria-label="Previous day">&lt;</button>
        <div class="dashboard-date-display">
          <strong>${escapeHtml(formatDateLabel(state.selectedDate))}</strong>
          <span>${escapeHtml(state.selectedDate)}</span>
        </div>
        <button
          type="button"
          class="dashboard-nav-btn"
          data-dashboard-date="next"
          aria-label="Next day"
          ${isFutureDate(nextDate) ? 'disabled' : ''}
        >&gt;</button>
        <button
          type="button"
          class="dashboard-today-btn"
          data-dashboard-date="today"
          ${state.selectedDate === today ? 'disabled' : ''}
        >Today</button>
      </section>
    `;
  }

  function renderDashboard() {
    const container = document.getElementById('dashboardSlides');
    if (!container) return;

    if (state.loading && !state.data) {
      container.innerHTML = `
        <article class="dashboard-single">
          <div class="dashboard-loading-panel">
            <span class="loader"></span>
            <p>Loading dashboard.</p>
          </div>
        </article>
      `;
      renderFooter();
      return;
    }

    if (state.error && !state.data) {
      container.innerHTML = `
        <article class="dashboard-single">
          <section class="dashboard-panel dashboard-panel--error">
            <p class="dashboard-panel__eyebrow">Unavailable</p>
            <h3>Dashboard</h3>
            <p>${escapeHtml(state.error.message || 'Dashboard data could not be loaded.')}</p>
          </section>
        </article>
      `;
      renderFooter();
      return;
    }

    const metrics = getMetrics();
    const activeMetric = getActiveMetric();
    container.innerHTML = `
      <article class="dashboard-single">
        ${renderToolbar()}
        <section class="dashboard-panel dashboard-output-panel">
          <div class="dashboard-output-grid dashboard-output-grid--interactive">
            ${metrics.length ? metrics.map(renderMetricCard).join('') : '<p class="dashboard-empty-text">No output data available.</p>'}
          </div>
        </section>
        ${renderDetailPanel(activeMetric)}
      </article>
    `;
    renderFooter();
  }

  function renderFooter() {
    const dots = document.getElementById('dashboardDots');
    if (dots) dots.innerHTML = '';
    const updatedEl = document.getElementById('dashboardLastUpdated');
    if (!updatedEl) return;

    const pieces = [formatRefreshTime(state.updatedAt)];
    if (state.loading) pieces.push('Refreshing.');
    if (state.error) pieces.push(state.error.message || 'Refresh failed.');
    updatedEl.textContent = pieces.filter(Boolean).join(' ');
  }

  async function refreshDashboard() {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    renderFooter();

    const params = new URLSearchParams();
    params.set('date', state.selectedDate);

    try {
      const data = await fetchJson(`/api/dashboard/daily-output?${params.toString()}`);
      state.data = data;
      const metrics = getMetrics();
      if (!metrics.some((metric) => metric.key === state.activeMetricKey)) {
        state.activeMetricKey = metrics[0]?.key || '';
      }
      state.updatedAt = new Date().toISOString();
    } catch (err) {
      state.error = err;
    } finally {
      state.loading = false;
      renderDashboard();
    }
  }

  function setSelectedDate(dateKey) {
    if (!dateKey || isFutureDate(dateKey)) return;
    if (state.selectedDate === dateKey) return;
    state.selectedDate = dateKey;
    state.data = null;
    state.error = null;
    refreshDashboard();
  }

  function bindDashboardEvents() {
    const container = document.getElementById('dashboardSlides');
    if (!container) return;

    container.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const metricButton = target.closest('[data-dashboard-metric]');
      if (metricButton) {
        const metricKey = String(metricButton.getAttribute('data-dashboard-metric') || '').trim();
        if (metricKey && metricKey !== state.activeMetricKey) {
          state.activeMetricKey = metricKey;
          renderDashboard();
        }
        return;
      }

      const dateButton = target.closest('[data-dashboard-date]');
      if (!dateButton) return;
      const action = String(dateButton.getAttribute('data-dashboard-date') || '').trim();
      if (action === 'prev') {
        setSelectedDate(shiftDateKey(state.selectedDate, -1));
      } else if (action === 'next') {
        setSelectedDate(shiftDateKey(state.selectedDate, 1));
      } else if (action === 'today') {
        setSelectedDate(getTodayDateKey());
      }
    });
  }

  function init() {
    bindDashboardEvents();
    renderDashboard();
    refreshDashboard();
    setInterval(() => {
      if (isToday(state.selectedDate)) {
        refreshDashboard();
      }
    }, DASHBOARD_REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}());
