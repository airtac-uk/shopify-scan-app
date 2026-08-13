const MAINTENANCE_POLL_MS = 60000;
const MAINTENANCE_UPLOAD_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif,application/pdf';
const MAINTENANCE_IMAGE_UPLOAD_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif';
const WEEKDAY_OPTIONS = [
  [1, 'Monday'],
  [2, 'Tuesday'],
  [3, 'Wednesday'],
  [4, 'Thursday'],
  [5, 'Friday'],
  [6, 'Saturday'],
  [0, 'Sunday'],
];

let maintenanceState = {
  data: null,
  loading: false,
  activeTab: 'machine',
  calendarView: 'month',
  dashboardTaskView: 'due_today',
  selectedMachineId: null,
  selectedTaskId: null,
  selectedAssetId: null,
  selectedTemplateMachineType: '',
  editingAssetId: null,
  editingTemplateId: null,
  returnTabAfterTask: null,
  filters: {
    asset: '',
    type: '',
    frequency: '',
    status: '',
  },
};

let maintenancePollId = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value);
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
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

function formatLabel(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getSelectedDate() {
  return document.getElementById('maintenanceDate')?.value || todayKey();
}

function getRangeForSelectedDate() {
  const date = new Date(`${getSelectedDate()}T00:00:00`);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const start = new Date(safeDate.getFullYear(), safeDate.getMonth(), 1);
  const end = new Date(safeDate.getFullYear(), safeDate.getMonth() + 1, 0);
  start.setDate(start.getDate() - 7);
  end.setDate(end.getDate() + 14);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function setStatus(message, type = 'info') {
  const el = document.getElementById('maintenanceStatus');
  if (!el) return;
  el.textContent = message || '';
  el.dataset.type = type;
}

function setLoading(isLoading) {
  maintenanceState.loading = Boolean(isLoading);
  const spinner = document.getElementById('maintenanceSpinner');
  const refreshBtn = document.getElementById('maintenanceRefreshBtn');
  if (spinner) spinner.style.display = maintenanceState.loading ? 'inline-block' : 'none';
  if (refreshBtn) refreshBtn.disabled = maintenanceState.loading;
  updateClearOverdueDailyButton();
}

function updateLastUpdatedLabel() {
  const el = document.getElementById('maintenanceUpdated');
  if (!el) return;
  el.textContent = `Last refreshed ${formatTimestamp(new Date().toISOString())}`;
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    cache: 'no-store',
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) {
    throw new Error(data?.error || 'Request failed');
  }
  return data;
}

async function apiFormData(url, formData, options = {}) {
  const response = await fetch(url, {
    ...options,
    method: options.method || 'POST',
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
    body: formData,
    cache: 'no-store',
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) {
    throw new Error(data?.error || 'Request failed');
  }
  return data;
}

function getAssets() {
  return Array.isArray(maintenanceState.data?.assets) ? maintenanceState.data.assets : [];
}

function getActiveAssets() {
  return getAssets().filter((asset) => !asset.archivedAt);
}

function getEquipmentTypes() {
  return Array.from(new Set(
    getActiveAssets()
      .map((asset) => String(asset.equipmentType || '').trim())
      .filter(Boolean)
  )).sort((left, right) => left.localeCompare(right));
}

function getFrequencies() {
  return Array.isArray(maintenanceState.data?.frequencies) ? maintenanceState.data.frequencies : [];
}

function findFrequency(frequencyId) {
  return getFrequencies().find((frequency) => String(frequency.id) === String(frequencyId)) || null;
}

function getTemplates() {
  return Array.isArray(maintenanceState.data?.templates) ? maintenanceState.data.templates : [];
}

function getScheduled() {
  return Array.isArray(maintenanceState.data?.scheduledInstances) ? maintenanceState.data.scheduledInstances : [];
}

function getFaults() {
  return Array.isArray(maintenanceState.data?.faults) ? maintenanceState.data.faults : [];
}

function getCorrectiveTasks() {
  return Array.isArray(maintenanceState.data?.correctiveTasks) ? maintenanceState.data.correctiveTasks : [];
}

function getKnownUsers() {
  return Array.isArray(maintenanceState.data?.knownUsers) ? maintenanceState.data.knownUsers : [];
}

function findAsset(assetId) {
  return getAssets().find((asset) => String(asset.id) === String(assetId)) || null;
}

function findTemplate(templateId) {
  return getTemplates().find((template) => String(template.id) === String(templateId)) || null;
}

function getTemplateFrequencyScheduleType(template) {
  return template?.frequencyScheduleType || findFrequency(template?.frequencyId)?.scheduleType || template?.frequencyKey || '';
}

function formatWeekday(value) {
  const day = WEEKDAY_OPTIONS.find(([key]) => String(key) === String(value));
  return day ? day[1] : 'Monday';
}

function normalizeWeekdaysForUi(value) {
  const selected = new Set((Array.isArray(value) ? value : [1, 2, 3, 4, 5]).map((item) => Number(item)));
  const days = WEEKDAY_OPTIONS.filter(([key]) => selected.has(Number(key))).map(([key]) => Number(key));
  return days.length ? days : [1, 2, 3, 4, 5];
}

function formatWeekdays(value) {
  const days = normalizeWeekdaysForUi(value);
  const key = days.join(',');
  if (key === '1,2,3,4,5') return 'Mon-Fri';
  if (key === '1,2,3,4,5,6,0') return 'Every day';
  const labels = new Map(WEEKDAY_OPTIONS.map(([day, label]) => [Number(day), label.slice(0, 3)]));
  return days.map((day) => labels.get(day) || String(day)).join(', ');
}

function formatTemplateSchedule(template) {
  const type = getTemplateFrequencyScheduleType(template);
  if (type === 'daily') return `${template.frequencyLabel} · ${formatWeekdays(template.scheduleDaysOfWeek)}`;
  if (type === 'weekly') return `${template.frequencyLabel} · ${formatWeekday(template.scheduleDayOfWeek)}`;
  if (type === 'monthly') return `${template.frequencyLabel} · Day ${template.scheduleDayOfMonth || 1}`;
  return template.frequencyLabel;
}

function getTemplateMachineType(template) {
  return template?.targetEquipmentType || template?.equipmentType || 'Unassigned type';
}

function getTemplateFrequencyRank(template) {
  const type = getTemplateFrequencyScheduleType(template);
  if (type === 'daily') return 0;
  if (type === 'weekly') return 1;
  if (type === 'monthly') return 2;
  return 3;
}

function findScheduled(taskId) {
  return getScheduled().find((task) => String(task.id) === String(taskId)) || null;
}

function isClosedScheduledStatus(status) {
  return ['completed', 'cancelled', 'skipped'].includes(String(status || '').toLowerCase());
}

function getOpenFaultsForAsset(assetId) {
  return getFaults().filter((fault) => (
    String(fault.assetId) === String(assetId) &&
    !['resolved', 'closed'].includes(String(fault.status || '').toLowerCase())
  ));
}

function getMachineTasks(assetId) {
  return getScheduled().filter((task) => String(task.assetId) === String(assetId));
}

function getMachineWorkflowTasks(assetId) {
  const selectedDate = getSelectedDate();
  const tasks = getMachineTasks(assetId);
  const outstanding = tasks
    .filter((task) => !isClosedScheduledStatus(task.status) && task.dueDate <= selectedDate)
    .sort((left, right) => String(left.dueDate).localeCompare(String(right.dueDate)) || String(left.taskTitle).localeCompare(String(right.taskTitle)));
  const completedToday = tasks
    .filter((task) => task.status === 'completed' && task.dueDate === selectedDate)
    .sort((left, right) => String(left.taskTitle).localeCompare(String(right.taskTitle)));
  const skippedToday = tasks
    .filter((task) => task.status === 'skipped' && task.dueDate === selectedDate)
    .sort((left, right) => String(left.taskTitle).localeCompare(String(right.taskTitle)));
  const today = tasks
    .filter((task) => task.dueDate === selectedDate && !['cancelled', 'skipped'].includes(String(task.status || '').toLowerCase()));

  return { outstanding, completedToday, skippedToday, today };
}

function getMachineSummary(asset) {
  const workflow = getMachineWorkflowTasks(asset.id);
  return {
    ...workflow,
    openFaults: getOpenFaultsForAsset(asset.id),
    totalToday: workflow.today.length,
  };
}

function getMachineReadiness(asset, summary) {
  if (asset.availabilityStatus === 'out_of_service') return 'out_of_service';
  if (summary.openFaults.length) return 'faults_open';
  if (summary.outstanding.length) return 'needs_checks';
  if (asset.availabilityStatus === 'restricted_use') return 'restricted_use';
  return 'ready';
}

function statusPill(status) {
  const key = String(status || 'upcoming').trim();
  return `<span class="maintenance-pill maintenance-pill--${escapeHtmlAttribute(key)}">${escapeHtml(formatLabel(key))}</span>`;
}

function availabilityPill(status) {
  const key = String(status || 'available').trim();
  return `<span class="maintenance-availability maintenance-availability--${escapeHtmlAttribute(key)}">${escapeHtml(formatLabel(key))}</span>`;
}

function normalizeAssigneeName(value) {
  return String(value || '').trim();
}

function getAssigneeInitials(name) {
  const words = normalizeAssigneeName(name).split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0] || ''}${words[words.length - 1][0] || ''}`.toUpperCase();
}

function assigneeBadge(assignedTo, options = {}) {
  const name = normalizeAssigneeName(assignedTo);
  const showName = options.showName !== false;
  const label = name || 'Unassigned';
  return `
    <span class="maintenance-assignee ${name ? '' : 'maintenance-assignee--unassigned'}" title="Responsible: ${escapeHtmlAttribute(label)}">
      <span class="maintenance-assignee__avatar" aria-hidden="true">${escapeHtml(getAssigneeInitials(name))}</span>
      ${showName ? `<span class="maintenance-assignee__name">${escapeHtml(label)}</span>` : ''}
    </span>
  `;
}

function renderAssigneeOptions(selectedValue) {
  const selected = normalizeAssigneeName(selectedValue);
  const users = getKnownUsers()
    .map(normalizeAssigneeName)
    .filter(Boolean);
  const uniqueUsers = Array.from(new Set(selected && !users.includes(selected) ? [selected, ...users] : users));
  return [
    `<option value="" ${selected ? '' : 'selected'}>Unassigned</option>`,
    ...uniqueUsers.map((user) => `<option value="${escapeHtmlAttribute(user)}" ${user === selected ? 'selected' : ''}>${escapeHtml(user)}</option>`),
  ].join('');
}

function renderSummary(summary = {}) {
  const container = document.getElementById('maintenanceSummary');
  if (!container) return;
  const stats = [
    ['Due Today', summary.dueToday || 0],
    ['Overdue', summary.overdue || 0],
    ['Completion', `${summary.completionPercent ?? 0}%`],
    ['Open Faults', summary.openFaults || 0],
    ['Restricted', summary.restrictedEquipment || 0],
    ['Out of Service', summary.outOfServiceEquipment || 0],
  ];

  container.innerHTML = stats.map(([label, value]) => `
    <article class="maintenance-stat">
      <p>${escapeHtml(label)}</p>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `).join('');
}

function renderTaskTable(containerId, tasks = [], options = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  if (!safeTasks.length) {
    container.innerHTML = `<p class="pick-list-empty">${escapeHtml(options.emptyText || 'No maintenance tasks found.')}</p>`;
    return;
  }

  container.innerHTML = `
    <div class="maintenance-table-wrap">
      <table class="maintenance-table">
        <thead>
          <tr>
            <th>Equipment</th>
            <th>Task</th>
            <th>Frequency</th>
            <th>Due</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${safeTasks.map((task) => `
            <tr>
              <td>
                <strong>${escapeHtml(task.equipmentName)}</strong>
                ${task.assetAvailabilityStatus && task.assetAvailabilityStatus !== 'available' ? availabilityPill(task.assetAvailabilityStatus) : ''}
              </td>
              <td>
                <div class="maintenance-task-title-cell">
                  ${assigneeBadge(task.assignedTo)}
                  <strong>${escapeHtml(task.taskTitle)}</strong>
                </div>
              </td>
              <td><span class="maintenance-frequency-dot" style="background:${escapeHtmlAttribute(task.frequencyColor)}"></span>${escapeHtml(task.frequencyLabel)}</td>
              <td>${escapeHtml(formatDate(task.dueDate))}</td>
              <td>${statusPill(task.calendarStatus || task.status)}</td>
              <td>
                <button type="button" class="maintenance-small-btn" data-open-task-id="${escapeHtmlAttribute(task.id)}">
                  Open
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderMachineTaskRows(title, tasks = [], emptyText = '', options = {}) {
  return `
    <section class="maintenance-machine-task-section">
      <div class="maintenance-machine-task-section__head">
        <h3>${escapeHtml(title)}</h3>
        <span>${escapeHtml(tasks.length)} task${tasks.length === 1 ? '' : 's'}</span>
      </div>
      ${tasks.length ? `
        <div class="maintenance-machine-task-list">
          ${tasks.map((task) => {
            const checklistCount = (task.checklist || []).length;
            const mandatoryCount = (task.checklist || []).filter((item) => item.mandatory !== false).length;
            const status = task.calendarStatus || task.status;
            const canSkip = options.allowSkip && !isClosedScheduledStatus(task.status);
            return `
              <article class="maintenance-machine-task-row maintenance-machine-task-row--${escapeHtmlAttribute(status)}">
                <button
                  type="button"
                  class="maintenance-machine-task-open"
                  data-open-machine-task-id="${escapeHtmlAttribute(task.id)}"
                >
                  <span class="maintenance-task-title-line">
                    ${assigneeBadge(task.assignedTo, { showName: false })}
                    <strong>${escapeHtml(task.taskTitle)}</strong>
                  </span>
                  <small>${escapeHtml(task.frequencyLabel)} · Due ${escapeHtml(formatDate(task.dueDate))}</small>
                  <small>${escapeHtml(checklistCount)} checks${mandatoryCount ? ` · ${escapeHtml(mandatoryCount)} mandatory` : ''}</small>
                  ${task.skipReason ? `<small>Reason: ${escapeHtml(task.skipReason)}</small>` : ''}
                </button>
                <div class="maintenance-machine-task-actions">
                  ${statusPill(status)}
                  ${canSkip ? `<button type="button" class="maintenance-small-btn" data-skip-machine-task-id="${escapeHtmlAttribute(task.id)}">Not Relevant Today</button>` : ''}
                </div>
              </article>
            `;
          }).join('')}
        </div>
      ` : `<p class="pick-list-empty">${escapeHtml(emptyText)}</p>`}
    </section>
  `;
}

function renderMachineWorkflow() {
  const machineSelect = document.getElementById('maintenanceMachineSelect');
  const detailContainer = document.getElementById('maintenanceMachineTasks');
  if (!machineSelect || !detailContainer) return;

  const activeAssets = getActiveAssets();
  if (!activeAssets.length) {
    machineSelect.innerHTML = '<option value="">No active equipment configured</option>';
    machineSelect.disabled = true;
    detailContainer.innerHTML = '<p class="pick-list-empty">No machine selected.</p>';
    return;
  }

  const rankedAssets = activeAssets
    .map((asset) => ({ asset, summary: getMachineSummary(asset) }))
    .sort((left, right) => {
      const leftPriority = left.summary.outstanding.length + left.summary.openFaults.length;
      const rightPriority = right.summary.outstanding.length + right.summary.openFaults.length;
      return rightPriority - leftPriority || String(left.asset.name).localeCompare(String(right.asset.name));
    });

  if (!findAsset(maintenanceState.selectedMachineId)) {
    maintenanceState.selectedMachineId = (rankedAssets.find((item) => item.summary.outstanding.length || item.summary.openFaults.length) || rankedAssets[0]).asset.id;
  }

  machineSelect.disabled = false;
  machineSelect.innerHTML = rankedAssets.map(({ asset, summary }) => {
    const openCopy = `${summary.outstanding.length} open`;
    const faultCopy = summary.openFaults.length ? `, ${summary.openFaults.length} fault${summary.openFaults.length === 1 ? '' : 's'}` : '';
    const locationCopy = asset.location ? ` - ${asset.location}` : '';
    const label = `${asset.name} - ${asset.equipmentType || 'No type'}${locationCopy} - ${openCopy}${faultCopy}`;
    return `<option value="${escapeHtmlAttribute(asset.id)}">${escapeHtml(label)}</option>`;
  }).join('');
  machineSelect.value = String(maintenanceState.selectedMachineId);

  const asset = findAsset(maintenanceState.selectedMachineId);
  if (!asset) {
    detailContainer.innerHTML = '<p class="pick-list-empty">No machine selected.</p>';
    return;
  }

  const summary = getMachineSummary(asset);
  const readiness = getMachineReadiness(asset, summary);
  const readyCopy = readiness === 'ready'
    ? 'Ready to run'
    : readiness === 'needs_checks'
      ? `${summary.outstanding.length} check${summary.outstanding.length === 1 ? '' : 's'} required`
      : formatLabel(readiness);

  detailContainer.innerHTML = `
    <div class="maintenance-machine-head">
      <div>
        <p class="maintenance-eyebrow">${escapeHtml(asset.equipmentType || 'Equipment')}</p>
        <h2>${escapeHtml(asset.name)}</h2>
        <p>${escapeHtml(asset.location || '')}${asset.uniqueIdentifier ? ` · ${escapeHtml(asset.uniqueIdentifier)}` : ''}</p>
      </div>
      <div class="maintenance-machine-head__status">
        ${statusPill(readiness)}
        ${asset.availabilityStatus !== 'available' ? availabilityPill(asset.availabilityStatus) : ''}
        <button type="button" class="maintenance-small-btn" data-schedule-extra-daily-asset-id="${escapeHtmlAttribute(asset.id)}">Add Daily Tasks</button>
      </div>
    </div>
    <div class="maintenance-machine-stats">
      <article><strong>${escapeHtml(summary.outstanding.length)}</strong><span>Open Checks</span></article>
      <article><strong>${escapeHtml(summary.completedToday.length)} / ${escapeHtml(summary.totalToday)}</strong><span>Today Complete</span></article>
      <article><strong>${escapeHtml(summary.openFaults.length)}</strong><span>Open Faults</span></article>
      <article><strong>${escapeHtml(readyCopy)}</strong><span>Run State</span></article>
    </div>
    ${renderMachineTaskRows('Required Before Running', summary.outstanding, 'No outstanding checks for this machine.', { allowSkip: true })}
    ${renderMachineTaskRows('Completed Today', summary.completedToday, 'No completed checks recorded today.')}
    ${renderMachineTaskRows('Not Relevant Today', summary.skippedToday, 'No checks skipped today.')}
  `;
}

function renderDashboard() {
  const dashboard = maintenanceState.data?.dashboard || {};
  renderSummary(dashboard.summary || {});
  renderDashboardTaskPanel(dashboard);
  renderTaskTable('maintenanceUpcoming', dashboard.upcoming || [], { emptyText: 'No upcoming maintenance in this range.' });

  const recentContainer = document.getElementById('maintenanceRecent');
  const recent = Array.isArray(dashboard.recentlyCompleted) ? dashboard.recentlyCompleted : [];
  if (recentContainer) {
    recentContainer.innerHTML = recent.length ? `
      <div class="maintenance-table-wrap">
        <table class="maintenance-table">
          <thead>
            <tr>
              <th>Equipment</th>
              <th>Task</th>
              <th>Completed By</th>
              <th>Completed</th>
              <th>Timing</th>
            </tr>
          </thead>
          <tbody>
            ${recent.slice(0, 12).map((item) => `
              <tr>
                <td>${escapeHtml(item.equipmentName)}</td>
                <td>${escapeHtml(item.taskTitle)}</td>
                <td>${escapeHtml(item.completedBy || 'Unknown')}</td>
                <td>${escapeHtml(formatTimestamp(item.completedAt))}</td>
                <td>${statusPill(item.timeliness)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : '<p class="pick-list-empty">No completed maintenance yet.</p>';
  }

  const progressContainer = document.getElementById('maintenanceProgress');
  const progress = Array.isArray(dashboard.progressByAsset) ? dashboard.progressByAsset : [];
  if (progressContainer) {
    progressContainer.innerHTML = progress.length ? `
      <div class="maintenance-progress-list">
        ${progress.map((asset) => `
          <button type="button" class="maintenance-progress-row" data-open-asset-id="${escapeHtmlAttribute(asset.assetId)}">
            <span>
              <strong>${escapeHtml(asset.name)}</strong>
              ${asset.openFaults ? `<small>${escapeHtml(asset.openFaults)} open fault${asset.openFaults === 1 ? '' : 's'}</small>` : ''}
            </span>
            <span>${escapeHtml(asset.completed)} / ${escapeHtml(asset.total)} Complete</span>
            ${availabilityPill(asset.availabilityStatus)}
          </button>
        `).join('')}
      </div>
    ` : '<p class="pick-list-empty">No equipment configured.</p>';
  }
}

function updateCalendarFilters() {
  const assetSelect = document.getElementById('maintenanceFilterAsset');
  const typeSelect = document.getElementById('maintenanceFilterType');
  const frequencySelect = document.getElementById('maintenanceFilterFrequency');
  const statusSelect = document.getElementById('maintenanceFilterStatus');

  if (assetSelect) {
    assetSelect.innerHTML = [
      '<option value="">All equipment</option>',
      ...getActiveAssets().map((asset) => `<option value="${escapeHtmlAttribute(asset.id)}">${escapeHtml(asset.name)}</option>`),
    ].join('');
    assetSelect.value = maintenanceState.filters.asset;
  }

  if (typeSelect) {
    const types = Array.from(new Set(getActiveAssets().map((asset) => asset.equipmentType).filter(Boolean))).sort();
    typeSelect.innerHTML = [
      '<option value="">All equipment types</option>',
      ...types.map((type) => `<option value="${escapeHtmlAttribute(type)}">${escapeHtml(type)}</option>`),
    ].join('');
    typeSelect.value = maintenanceState.filters.type;
  }

  if (frequencySelect) {
    frequencySelect.innerHTML = [
      '<option value="">All frequencies</option>',
      ...getFrequencies().map((frequency) => `<option value="${escapeHtmlAttribute(frequency.key)}">${escapeHtml(frequency.label)}</option>`),
    ].join('');
    frequencySelect.value = maintenanceState.filters.frequency;
  }

  if (statusSelect) {
    statusSelect.innerHTML = [
      ['','All statuses'],
      ['upcoming','Upcoming'],
      ['due_today','Due Today'],
      ['overdue','Overdue'],
      ['completed','Completed'],
    ].map(([value, label]) => `<option value="${escapeHtmlAttribute(value)}">${escapeHtml(label)}</option>`).join('');
    statusSelect.value = maintenanceState.filters.status;
  }
}

function getFilteredScheduled() {
  const filters = maintenanceState.filters;
  return getScheduled().filter((task) => {
    if (filters.asset && String(task.assetId) !== String(filters.asset)) return false;
    if (filters.type && task.equipmentType !== filters.type) return false;
    if (filters.frequency && task.frequencyKey !== filters.frequency) return false;
    if (filters.status && (task.calendarStatus || task.status) !== filters.status) return false;
    return true;
  });
}

function renderMonthCalendar(tasks) {
  const selected = new Date(`${getSelectedDate()}T00:00:00`);
  const monthStart = new Date(selected.getFullYear(), selected.getMonth(), 1);
  const monthEnd = new Date(selected.getFullYear(), selected.getMonth() + 1, 0);
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - ((gridStart.getDay() + 6) % 7));
  const days = [];
  for (let cursor = new Date(gridStart); days.length < 42; cursor.setDate(cursor.getDate() + 1)) {
    days.push(new Date(cursor));
  }
  const byDate = new Map();
  tasks.forEach((task) => {
    const list = byDate.get(task.dueDate) || [];
    list.push(task);
    byDate.set(task.dueDate, list);
  });

  return `
    <div class="maintenance-calendar-grid">
      ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => `<div class="maintenance-calendar-heading">${day}</div>`).join('')}
      ${days.map((date) => {
        const dateKey = date.toISOString().slice(0, 10);
        const inMonth = date.getMonth() === monthStart.getMonth();
        const dayTasks = byDate.get(dateKey) || [];
        return `
          <article class="maintenance-calendar-day${inMonth ? '' : ' is-muted'}">
            <strong>${escapeHtml(date.getDate())}</strong>
            <div>
              ${dayTasks.slice(0, 5).map((task) => `
                <button
                  type="button"
                  class="maintenance-calendar-event maintenance-calendar-event--${escapeHtmlAttribute(task.calendarStatus || task.status)}"
                  style="border-left-color:${escapeHtmlAttribute(task.frequencyColor)}"
                  data-open-task-id="${escapeHtmlAttribute(task.id)}"
                >
                  ${escapeHtml(task.equipmentName)} · ${escapeHtml(task.taskTitle)}
                </button>
              `).join('')}
              ${dayTasks.length > 5 ? `<span class="maintenance-calendar-more">+${escapeHtml(dayTasks.length - 5)} more</span>` : ''}
            </div>
          </article>
        `;
      }).join('')}
    </div>
  `;
}

function renderAgendaCalendar(tasks) {
  const selected = new Date(`${getSelectedDate()}T00:00:00`);
  const view = maintenanceState.calendarView;
  const start = new Date(selected);
  const end = new Date(selected);
  if (view === 'week') {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    end.setDate(start.getDate() + 6);
  }
  const startKey = start.toISOString().slice(0, 10);
  const endKey = end.toISOString().slice(0, 10);
  const visible = tasks.filter((task) => task.dueDate >= startKey && task.dueDate <= endKey);
  if (!visible.length) return '<p class="pick-list-empty">No scheduled maintenance for this view.</p>';
  return `
    <div class="maintenance-agenda">
      ${visible.map((task) => `
        <button
          type="button"
          class="maintenance-agenda-item"
          data-open-task-id="${escapeHtmlAttribute(task.id)}"
          style="border-left-color:${escapeHtmlAttribute(task.frequencyColor)}"
        >
          <span>
            <strong>${escapeHtml(formatDate(task.dueDate))}</strong>
            <small>${escapeHtml(task.equipmentName)} · ${escapeHtml(task.frequencyLabel)}</small>
          </span>
          <span>${escapeHtml(task.taskTitle)}</span>
          ${statusPill(task.calendarStatus || task.status)}
        </button>
      `).join('')}
    </div>
  `;
}

function renderCalendar() {
  updateCalendarFilters();
  const container = document.getElementById('maintenanceCalendar');
  if (!container) return;
  const tasks = getFilteredScheduled();
  container.innerHTML = maintenanceState.calendarView === 'month'
    ? renderMonthCalendar(tasks)
    : renderAgendaCalendar(tasks);
}

function parseChecklistTextarea(value) {
  return String(value || '')
    .split('\n')
    .map((line, index) => {
      const raw = line.trim();
      if (!raw) return null;
      const optional = raw.startsWith('?') || /^\[optional\]/i.test(raw);
      const text = raw.replace(/^\?/, '').replace(/^\[optional\]\s*/i, '').trim();
      return {
        id: `item_${index + 1}`,
        text,
        mandatory: !optional,
        sortOrder: index,
      };
    })
    .filter(Boolean);
}

function normalizeDocumentRecord(doc, index = 0) {
  const url = String(doc?.url || doc?.href || '').trim();
  const label = String(doc?.label || doc?.name || doc?.originalName || url || 'Uploaded file').trim();
  if (!url && !label) return null;
  const mimeType = String(doc?.mimeType || '').toLowerCase();
  const type = String(doc?.type || (mimeType === 'application/pdf' || /\.pdf(\?|$)/i.test(url) ? 'pdf' : 'image')).toLowerCase();
  return {
    id: String(doc?.id || `doc_${index + 1}`),
    label,
    originalName: String(doc?.originalName || label),
    url,
    type,
    mimeType,
    size: Number(doc?.size || 0),
    uploadedBy: String(doc?.uploadedBy || ''),
    uploadedAt: String(doc?.uploadedAt || ''),
    sortOrder: Number.isFinite(Number(doc?.sortOrder)) ? Number(doc.sortOrder) : index,
  };
}

function normalizeDocumentList(documents = []) {
  return (Array.isArray(documents) ? documents : [])
    .map(normalizeDocumentRecord)
    .filter(Boolean)
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

function getDocumentKey(doc) {
  return String(doc?.id || doc?.url || doc?.label || '');
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (!size) return '';
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)}MB`;
  if (size >= 1024) return `${Math.ceil(size / 1024)}KB`;
  return `${size}B`;
}

function renderCompactDocumentLinks(documents = []) {
  const safeDocuments = normalizeDocumentList(documents);
  if (!safeDocuments.length) return '';
  return `
    <div class="maintenance-file-links">
      ${safeDocuments.map((doc) => doc.url ? `
        <a href="${escapeHtmlAttribute(doc.url)}" target="_blank" rel="noreferrer">
          ${escapeHtml(doc.label || 'Open file')}
        </a>
      ` : `<span>${escapeHtml(doc.label || 'Uploaded file')}</span>`).join('')}
    </div>
  `;
}

function renderUploadField({
  name,
  label,
  documents = [],
  multiple = true,
  disabled = false,
  accept = MAINTENANCE_UPLOAD_ACCEPT,
  hint = 'Images or PDFs only. Max 25MB each.',
} = {}) {
  const safeDocuments = normalizeDocumentList(documents);
  const existingJson = escapeHtmlAttribute(JSON.stringify(safeDocuments));
  return `
    <div class="maintenance-upload-field" data-upload-field data-upload-name="${escapeHtmlAttribute(name)}">
      <div class="maintenance-upload-field__head">
        <span>${escapeHtml(label)}</span>
        <small>${escapeHtml(hint)}</small>
      </div>
      <input type="hidden" name="${escapeHtmlAttribute(name)}ExistingJson" value="${existingJson}" />
      ${safeDocuments.length ? `
        <div class="maintenance-upload-existing">
          ${safeDocuments.map((doc) => {
            const key = getDocumentKey(doc);
            return `
              <div class="maintenance-upload-item">
                <label class="maintenance-checkbox">
                  <input type="checkbox" data-upload-keep="${escapeHtmlAttribute(name)}" value="${escapeHtmlAttribute(key)}" ${disabled ? 'disabled' : 'checked'} />
                  <span>Keep</span>
                </label>
                <div>
                  <strong>${escapeHtml(doc.label || 'Uploaded file')}</strong>
                  <small>${escapeHtml([formatLabel(doc.type), formatFileSize(doc.size)].filter(Boolean).join(' · '))}</small>
                </div>
                ${doc.url ? `<a href="${escapeHtmlAttribute(doc.url)}" target="_blank" rel="noreferrer">Open</a>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      ` : ''}
      <label class="maintenance-upload-picker">
        <span>${multiple ? 'Add Files' : 'Choose File'}</span>
        <input
          type="file"
          data-upload-input="${escapeHtmlAttribute(name)}"
          accept="${escapeHtmlAttribute(accept)}"
          ${multiple ? 'multiple' : ''}
          ${disabled ? 'disabled' : ''}
        />
      </label>
      <div class="maintenance-upload-selected" data-upload-selected="${escapeHtmlAttribute(name)}"></div>
    </div>
  `;
}

function getExistingUploadDocuments(form, name) {
  const hidden = form.querySelector(`[name="${name}ExistingJson"]`);
  let existingDocuments = [];
  try {
    existingDocuments = JSON.parse(hidden?.value || '[]');
  } catch (err) {
    existingDocuments = [];
  }
  const documents = normalizeDocumentList(existingDocuments);
  const keepInputs = Array.from(form.querySelectorAll(`[data-upload-keep="${name}"]`));
  if (!keepInputs.length) return documents;
  const keptKeys = new Set(keepInputs.filter((input) => input.checked).map((input) => input.value));
  return documents.filter((doc) => keptKeys.has(getDocumentKey(doc)));
}

async function uploadMaintenanceFiles(form, name, options = {}) {
  const input = form.querySelector(`[data-upload-input="${name}"]`);
  const files = Array.from(input?.files || []).filter((file) => file.size > 0);
  const existing = getExistingUploadDocuments(form, name);
  if (!files.length) {
    return existing.map((doc, index) => ({ ...doc, sortOrder: index }));
  }

  const formData = new FormData();
  files.forEach((file) => formData.append('files', file));
  formData.append('field', name);
  setStatus(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}.`, 'info');
  const result = await apiFormData('/api/maintenance/uploads', formData);
  const uploaded = normalizeDocumentList(result.documents || []);
  const documents = options.single ? uploaded.slice(0, 1) : [...existing, ...uploaded];
  return documents.map((doc, index) => ({ ...doc, sortOrder: index }));
}

async function uploadSingleMaintenanceFileUrl(form, name) {
  const documents = await uploadMaintenanceFiles(form, name, { single: true });
  return documents[0]?.url || '';
}

function renderSelectedUploadNames(input) {
  const name = input?.dataset?.uploadInput;
  if (!name) return;
  const selected = input.closest('[data-upload-field]')?.querySelector(`[data-upload-selected="${name}"]`);
  if (!selected) return;
  const files = Array.from(input.files || []);
  selected.innerHTML = files.length
    ? files.map((file) => `<span>${escapeHtml(file.name)}${file.size ? ` · ${escapeHtml(formatFileSize(file.size))}` : ''}</span>`).join('')
    : '';
}

function checklistToTextarea(checklist = []) {
  return (Array.isArray(checklist) ? checklist : [])
    .map((item) => `${item.mandatory === false ? '? ' : ''}${item.text}`)
    .join('\n');
}

function renderAssetForm() {
  const form = document.getElementById('maintenanceAssetForm');
  if (!form) return;
  form.noValidate = true;
  const asset = maintenanceState.editingAssetId ? findAsset(maintenanceState.editingAssetId) : null;
  form.innerHTML = `
    <input type="hidden" name="id" value="${escapeHtmlAttribute(asset?.id || '')}" />
    <label>Name<input name="name" required value="${escapeHtmlAttribute(asset?.name || '')}" /></label>
    <label>Equipment Type<input name="equipmentType" value="${escapeHtmlAttribute(asset?.equipmentType || '')}" /></label>
    <label>Identifier<input name="uniqueIdentifier" value="${escapeHtmlAttribute(asset?.uniqueIdentifier || '')}" /></label>
    <label>Manufacturer<input name="manufacturer" value="${escapeHtmlAttribute(asset?.manufacturer || '')}" /></label>
    <label>Model<input name="model" value="${escapeHtmlAttribute(asset?.model || '')}" /></label>
    <label>Serial Number<input name="serialNumber" value="${escapeHtmlAttribute(asset?.serialNumber || '')}" /></label>
    <label>Location<input name="location" value="${escapeHtmlAttribute(asset?.location || '')}" /></label>
    <label>Availability
      <select name="availabilityStatus">
        ${['available', 'restricted_use', 'out_of_service'].map((status) => `
          <option value="${status}" ${asset?.availabilityStatus === status ? 'selected' : ''}>${escapeHtml(formatLabel(status))}</option>
        `).join('')}
      </select>
    </label>
    ${renderUploadField({
      name: 'photo',
      label: 'Equipment Photo',
      documents: asset?.photoUrl ? [{ id: 'photo', url: asset.photoUrl, label: 'Equipment photo', type: 'image' }] : [],
      multiple: false,
      accept: MAINTENANCE_IMAGE_UPLOAD_ACCEPT,
      hint: 'Images only. Max 25MB.',
    })}
    <label>Description<textarea name="description" rows="3">${escapeHtml(asset?.description || '')}</textarea></label>
    <label>Notes<textarea name="notes" rows="3">${escapeHtml(asset?.notes || '')}</textarea></label>
    <label class="maintenance-checkbox"><input name="active" type="checkbox" ${asset?.active === false ? '' : 'checked'} /> Active</label>
    <div class="maintenance-form-actions">
      <button type="submit">${asset ? 'Save Equipment' : 'Add Equipment'}</button>
      <button type="button" data-reset-asset-form>New</button>
    </div>
  `;
}

function renderAssetList() {
  const container = document.getElementById('maintenanceAssetList');
  if (!container) return;
  const assets = getAssets();
  container.innerHTML = assets.length ? `
    <div class="maintenance-table-wrap">
      <table class="maintenance-table">
        <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Location</th><th>Actions</th></tr></thead>
        <tbody>
          ${assets.map((asset) => `
            <tr class="${asset.archivedAt ? 'is-archived' : ''}">
              <td><strong>${escapeHtml(asset.name)}</strong><span>${escapeHtml(asset.uniqueIdentifier)}</span></td>
              <td>${escapeHtml(asset.equipmentType || '-')}</td>
              <td>${availabilityPill(asset.availabilityStatus)}${asset.archivedAt ? statusPill('archived') : ''}</td>
              <td>${escapeHtml(asset.location || '-')}</td>
              <td class="maintenance-row-actions">
                <button type="button" data-edit-asset-id="${escapeHtmlAttribute(asset.id)}">Edit</button>
                <button type="button" data-open-asset-id="${escapeHtmlAttribute(asset.id)}">History</button>
                <button type="button" data-duplicate-asset-id="${escapeHtmlAttribute(asset.id)}">Duplicate</button>
                ${asset.archivedAt ? '' : `<button type="button" data-archive-asset-id="${escapeHtmlAttribute(asset.id)}">Archive</button>`}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '<p class="pick-list-empty">No equipment configured.</p>';
}

function renderAssetHistory() {
  const container = document.getElementById('maintenanceAssetHistory');
  if (!container) return;
  const asset = maintenanceState.selectedAssetId ? findAsset(maintenanceState.selectedAssetId) : getActiveAssets()[0];
  if (!asset) {
    container.innerHTML = '<p class="pick-list-empty">Select equipment to view history.</p>';
    return;
  }
  maintenanceState.selectedAssetId = asset.id;
  const scheduled = getScheduled().filter((task) => task.assetId === asset.id);
  const faults = getFaults().filter((fault) => fault.assetId === asset.id);
  const corrective = getCorrectiveTasks().filter((task) => task.assetId === asset.id);
  const completions = maintenanceState.data?.reports?.maintenanceHistory?.filter((item) => item.assetId === asset.id) || [];
  container.innerHTML = `
    <div class="maintenance-history-head">
      <div>
        <h3>${escapeHtml(asset.name)}</h3>
        <p>${escapeHtml(asset.equipmentType || '')} ${asset.location ? `· ${escapeHtml(asset.location)}` : ''}</p>
      </div>
      ${availabilityPill(asset.availabilityStatus)}
    </div>
    <div class="maintenance-history-grid">
      <article><strong>${escapeHtml(scheduled.filter((task) => task.calendarStatus === 'due_today').length)}</strong><span>Due Today</span></article>
      <article><strong>${escapeHtml(scheduled.filter((task) => task.calendarStatus === 'overdue').length)}</strong><span>Overdue</span></article>
      <article><strong>${escapeHtml(completions.length)}</strong><span>Completions</span></article>
      <article><strong>${escapeHtml(faults.filter((fault) => !['resolved', 'closed'].includes(fault.status)).length)}</strong><span>Open Faults</span></article>
      <article><strong>${escapeHtml(corrective.filter((task) => !['completed', 'cancelled'].includes(task.status)).length)}</strong><span>Corrective</span></article>
    </div>
    <div class="maintenance-history-columns">
      <div>
        <h4>Previous Maintenance</h4>
        ${completions.slice(0, 8).map((item) => `
          <div class="maintenance-history-entry">
            <p><strong>${escapeHtml(formatDate(item.dueDate))}</strong> ${escapeHtml(item.taskTitle)} · ${escapeHtml(item.completedBy || 'Unknown')}</p>
            ${renderCompactDocumentLinks(item.evidence)}
          </div>
        `).join('') || '<p>No maintenance completions.</p>'}
      </div>
      <div>
        <h4>Fault History</h4>
        ${faults.slice(0, 8).map((fault) => `
          <div class="maintenance-history-entry">
            <p><strong>${escapeHtml(fault.faultRef)}</strong> ${escapeHtml(fault.title)} · ${statusPill(fault.status)}</p>
            ${renderCompactDocumentLinks(fault.attachments)}
          </div>
        `).join('') || '<p>No faults recorded.</p>'}
      </div>
    </div>
  `;
}

function renderTemplateForm() {
  const form = document.getElementById('maintenanceTemplateForm');
  if (!form) return;
  form.noValidate = true;
  const template = maintenanceState.editingTemplateId ? findTemplate(maintenanceState.editingTemplateId) : null;
  const selectedType = template?.targetEquipmentType || template?.equipmentType || maintenanceState.selectedTemplateMachineType || '';
  const equipmentTypes = getEquipmentTypes();
  const typeOptions = selectedType && !equipmentTypes.includes(selectedType)
    ? [selectedType, ...equipmentTypes]
    : equipmentTypes;
  const selectedDailyDays = normalizeWeekdaysForUi(template?.scheduleDaysOfWeek);
  form.innerHTML = `
    <input type="hidden" name="id" value="${escapeHtmlAttribute(template?.id || '')}" />
    <input type="hidden" name="targetScope" value="equipment_type" />
    <label>Machine Type
      <select name="targetEquipmentType" required>
        <option value="">Select machine type</option>
        ${typeOptions.map((type) => `<option value="${escapeHtmlAttribute(type)}" ${selectedType === type ? 'selected' : ''}>${escapeHtml(type)}</option>`).join('')}
      </select>
    </label>
    <label>Frequency
      <select name="frequencyId" required>
        <option value="">Select frequency</option>
        ${getFrequencies().map((frequency) => `<option value="${escapeHtmlAttribute(frequency.id)}" ${String(template?.frequencyId) === String(frequency.id) ? 'selected' : ''}>${escapeHtml(frequency.label)}</option>`).join('')}
      </select>
    </label>
    <label>Responsible
      <select name="assignedTo">
        ${renderAssigneeOptions(template?.assignedTo)}
      </select>
    </label>
    <div class="maintenance-template-schedule-fields">
      <fieldset class="maintenance-weekday-picker" data-template-schedule-field="daily">
        <legend>Days of Week</legend>
        ${WEEKDAY_OPTIONS.map(([value, label]) => `
          <label>
            <input name="scheduleDaysOfWeek" type="checkbox" value="${escapeHtmlAttribute(value)}" ${selectedDailyDays.includes(Number(value)) ? 'checked' : ''} />
            <span>${escapeHtml(label)}</span>
          </label>
        `).join('')}
      </fieldset>
      <label data-template-schedule-field="weekly">Day of Week
        <select name="scheduleDayOfWeek">
          ${WEEKDAY_OPTIONS.map(([value, label]) => `
            <option value="${escapeHtmlAttribute(value)}" ${String(template?.scheduleDayOfWeek ?? 1) === String(value) ? 'selected' : ''}>${escapeHtml(label)}</option>
          `).join('')}
        </select>
      </label>
      <label data-template-schedule-field="monthly">Day of Month
        <input name="scheduleDayOfMonth" type="number" min="1" max="31" step="1" value="${escapeHtmlAttribute(template?.scheduleDayOfMonth || 1)}" />
      </label>
    </div>
    <label>Title<input name="title" required value="${escapeHtmlAttribute(template?.title || '')}" /></label>
    <label>Estimated Minutes<input name="estimatedMinutes" type="number" min="0" value="${escapeHtmlAttribute(template?.estimatedMinutes || '')}" /></label>
    <label>Instructions<textarea name="instructions" rows="5">${escapeHtml(template?.instructions || '')}</textarea></label>
    <label>Checklist<textarea name="checklist" rows="6" placeholder="? Optional item">${escapeHtml(checklistToTextarea(template?.checklist || []))}</textarea></label>
    ${renderUploadField({
      name: 'documents',
      label: 'Instruction Files',
      documents: template?.documents || [],
    })}
    <label class="maintenance-checkbox"><input name="completionNotesRequired" type="checkbox" ${template?.completionNotesRequired ? 'checked' : ''} /> Completion notes required</label>
    <label class="maintenance-checkbox"><input name="evidenceRequired" type="checkbox" ${template?.evidenceRequired ? 'checked' : ''} /> Evidence required</label>
    <label class="maintenance-checkbox"><input name="active" type="checkbox" ${template?.active === false ? '' : 'checked'} /> Active</label>
    <div class="maintenance-form-actions">
      <button type="button" data-save-template>${template ? 'Save Instructions' : 'Add Instructions'}</button>
      <button type="button" data-reset-template-form>New</button>
    </div>
  `;
  updateTemplateScheduleFields(form);
}

function updateTemplateScheduleFields(form) {
  if (!form) return;
  const frequency = findFrequency(form.querySelector('[name="frequencyId"]')?.value);
  const scheduleType = frequency?.scheduleType || '';
  form.querySelectorAll('[data-template-schedule-field]').forEach((field) => {
    const active = field.dataset.templateScheduleField === scheduleType;
    field.hidden = !active;
    field.querySelectorAll('input, select').forEach((input) => {
      input.required = active && input.type !== 'checkbox';
      input.disabled = !active;
    });
  });
}

function formatTemplateTarget(template) {
  const type = template.targetEquipmentType || template.equipmentType || 'Unassigned type';
  const count = Number(template.targetAssetCount || 0);
  return `${type}${count ? ` · ${count} machine${count === 1 ? '' : 's'}` : ''}`;
}

function renderTemplateGroup(title, templates = []) {
  if (!templates.length) return '';
  return `
    <section class="maintenance-template-group">
      <div class="maintenance-template-group__head">
        <h3>${escapeHtml(title)}</h3>
        <span>${escapeHtml(templates.length)} instruction${templates.length === 1 ? '' : 's'}</span>
      </div>
      <div class="maintenance-table-wrap">
        <table class="maintenance-table maintenance-table--compact">
          <thead><tr><th>Instruction</th><th>Assignee</th><th>Schedule</th><th>Checklist</th><th>Actions</th></tr></thead>
          <tbody>
            ${templates.map((template) => `
              <tr>
                <td><strong>${escapeHtml(template.title)}</strong>${template.active ? '' : statusPill('inactive')}</td>
                <td>${assigneeBadge(template.assignedTo)}</td>
                <td><span class="maintenance-frequency-dot" style="background:${escapeHtmlAttribute(template.frequencyColor)}"></span>${escapeHtml(formatTemplateSchedule(template))}</td>
                <td>${escapeHtml((template.checklist || []).length)} items</td>
                <td class="maintenance-row-actions">
                  <button type="button" data-edit-template-id="${escapeHtmlAttribute(template.id)}">Edit</button>
                  <button type="button" data-duplicate-template-id="${escapeHtmlAttribute(template.id)}">Duplicate</button>
                  <button type="button" data-archive-template-id="${escapeHtmlAttribute(template.id)}">Archive</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderTemplateList() {
  const container = document.getElementById('maintenanceTemplateList');
  if (!container) return;
  const templates = getTemplates().filter((template) => !template.archivedAt);
  if (!templates.length) {
    container.innerHTML = '<p class="pick-list-empty">No instructions configured.</p>';
    return;
  }

  const types = Array.from(new Set(templates.map(getTemplateMachineType))).sort((left, right) => left.localeCompare(right));
  if (!types.includes(maintenanceState.selectedTemplateMachineType)) {
    maintenanceState.selectedTemplateMachineType = types[0];
  }

  const selectedType = maintenanceState.selectedTemplateMachineType;
  const selectedTemplates = templates
    .filter((template) => getTemplateMachineType(template) === selectedType)
    .sort((left, right) => getTemplateFrequencyRank(left) - getTemplateFrequencyRank(right) || String(left.title).localeCompare(String(right.title)));
  const representative = selectedTemplates[0];
  const grouped = [
    ['Daily Instructions', selectedTemplates.filter((template) => getTemplateFrequencyScheduleType(template) === 'daily')],
    ['Weekly Instructions', selectedTemplates.filter((template) => getTemplateFrequencyScheduleType(template) === 'weekly')],
    ['Monthly Instructions', selectedTemplates.filter((template) => getTemplateFrequencyScheduleType(template) === 'monthly')],
    ['Other Instructions', selectedTemplates.filter((template) => !['daily', 'weekly', 'monthly'].includes(getTemplateFrequencyScheduleType(template)))],
  ];

  container.innerHTML = `
    <div class="maintenance-template-browser">
      <div class="maintenance-template-type-tabs" aria-label="Machine type instructions">
        ${types.map((type) => `
          <button
            type="button"
            class="${type === selectedType ? 'is-active' : ''}"
            data-template-machine-type="${escapeHtmlAttribute(type)}"
          >
            ${escapeHtml(type)}
          </button>
        `).join('')}
      </div>
      <div class="maintenance-template-type-summary">
        <strong>${escapeHtml(formatTemplateTarget(representative || { targetEquipmentType: selectedType }))}</strong>
      </div>
      ${grouped.map(([title, groupTemplates]) => renderTemplateGroup(title, groupTemplates)).join('')}
    </div>
  `;
}

function renderDashboardTaskPanel(dashboard = {}) {
  const dueToday = Array.isArray(dashboard.dueToday) ? dashboard.dueToday : [];
  const overdue = Array.isArray(dashboard.overdue) ? dashboard.overdue : [];
  if (!['due_today', 'overdue'].includes(maintenanceState.dashboardTaskView)) {
    maintenanceState.dashboardTaskView = 'due_today';
  }

  document.querySelectorAll('[data-dashboard-task-view]').forEach((button) => {
    const active = button.dataset.dashboardTaskView === maintenanceState.dashboardTaskView;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const dueCount = document.getElementById('maintenanceDueTodayCount');
  const overdueCount = document.getElementById('maintenanceOverdueCount');
  if (dueCount) dueCount.textContent = String(dueToday.length);
  if (overdueCount) overdueCount.textContent = String(overdue.length);

  const activeTasks = maintenanceState.dashboardTaskView === 'overdue' ? overdue : dueToday;
  const emptyText = maintenanceState.dashboardTaskView === 'overdue'
    ? 'No overdue maintenance.'
    : 'No maintenance due today.';
  renderTaskTable('maintenanceDashboardTaskList', activeTasks, { emptyText });
  updateClearOverdueDailyButton();
}

function getOverdueDailyTasks() {
  const dashboard = maintenanceState.data?.dashboard || {};
  return (Array.isArray(dashboard.overdue) ? dashboard.overdue : [])
    .filter((task) => {
      const key = String(task.frequencyKey || '').toLowerCase();
      const label = String(task.frequencyLabel || '').toLowerCase();
      return key === 'daily' || label === 'daily';
    });
}

function updateClearOverdueDailyButton() {
  const clearOverdueDailyBtn = document.getElementById('maintenanceClearOverdueDailyBtn');
  if (!clearOverdueDailyBtn) return;
  const overdueDaily = getOverdueDailyTasks();
  clearOverdueDailyBtn.hidden = maintenanceState.dashboardTaskView !== 'overdue';
  clearOverdueDailyBtn.disabled = !overdueDaily.length || maintenanceState.loading;
  clearOverdueDailyBtn.textContent = 'Clear Overdue Daily';
  clearOverdueDailyBtn.title = overdueDaily.length
    ? `Clear ${overdueDaily.length} overdue daily task${overdueDaily.length === 1 ? '' : 's'}`
    : 'There are no overdue daily tasks to clear';
}

function renderDocuments(documents = []) {
  const safeDocuments = Array.isArray(documents) ? documents : [];
  if (!safeDocuments.length) return '';
  return `
    <div class="maintenance-documents">
      ${safeDocuments.map((doc) => {
        const url = String(doc.url || '').trim();
        const isPdf = /\.pdf(\?|$)/i.test(url) || doc.type === 'pdf';
        const isImage = /\.(png|jpg|jpeg|gif|webp)(\?|$)/i.test(url) || doc.type === 'image';
        return `
          <article>
            <strong>${escapeHtml(doc.label || url)}</strong>
            ${isPdf && url ? `<iframe src="${escapeHtmlAttribute(url)}" title="${escapeHtmlAttribute(doc.label || 'PDF')}"></iframe>` : ''}
            ${isImage && url ? `<img src="${escapeHtmlAttribute(url)}" alt="${escapeHtmlAttribute(doc.label || 'Maintenance image')}" />` : ''}
            ${url ? `<a href="${escapeHtmlAttribute(url)}" target="_blank" rel="noreferrer">Open original</a>` : ''}
          </article>
        `;
      }).join('')}
    </div>
  `;
}

function renderTaskDetail() {
  const container = document.getElementById('maintenanceTaskDetail');
  if (!container) return;
  const task = maintenanceState.selectedTaskId ? findScheduled(maintenanceState.selectedTaskId) : null;
  if (!task) {
    container.innerHTML = '<p class="pick-list-empty">Select a scheduled maintenance task.</p>';
    return;
  }
  const previous = (maintenanceState.data?.reports?.maintenanceHistory || [])
    .filter((item) => item.templateId === task.templateId && item.id !== task.completionRecordId)
    .sort((left, right) => String(right.completedAt || '').localeCompare(String(left.completedAt || '')))[0];
  const completed = task.status === 'completed';
  const skipped = task.status === 'skipped';
  const closed = isClosedScheduledStatus(task.status);

  container.innerHTML = `
    <div class="maintenance-task-hero">
      <div>
        <p class="maintenance-eyebrow">${escapeHtml(task.equipmentName)} · ${escapeHtml(task.frequencyLabel)}</p>
        <div class="maintenance-task-heading-line">
          ${assigneeBadge(task.assignedTo)}
          <h2>${escapeHtml(task.taskTitle)}</h2>
        </div>
        <p>Due ${escapeHtml(formatDate(task.dueDate))}${previous ? ` · Previous ${escapeHtml(formatTimestamp(previous.completedAt))}` : ''}</p>
        ${skipped ? `<p>Skipped by ${escapeHtml(task.skippedBy || 'Unknown')}${task.skippedAt ? ` · ${escapeHtml(formatTimestamp(task.skippedAt))}` : ''}${task.skipReason ? ` · ${escapeHtml(task.skipReason)}` : ''}</p>` : ''}
      </div>
      <div>
        ${statusPill(task.calendarStatus || task.status)}
        ${task.assetAvailabilityStatus !== 'available' ? availabilityPill(task.assetAvailabilityStatus) : ''}
        ${maintenanceState.returnTabAfterTask === 'machine' && maintenanceState.selectedMachineId ? '<button type="button" class="maintenance-small-btn" data-back-to-machine-workflow>Back to Machine</button>' : ''}
      </div>
    </div>
    <div class="maintenance-task-body">
      <section>
        <h3>Instructions</h3>
        <p>${escapeHtml(task.instructions || 'No instructions configured.')}</p>
        ${renderDocuments(task.documents)}
      </section>
      <form id="maintenanceCompleteForm" class="maintenance-form maintenance-complete-form">
        <h3>Checklist</h3>
        ${(task.checklist || []).map((item) => `
          <label class="maintenance-check-row">
            <input type="checkbox" name="checklist" value="${escapeHtmlAttribute(item.id)}" ${completed ? 'checked' : ''} ${closed ? 'disabled' : ''} />
            <span>
              <strong>${escapeHtml(item.text)}</strong>
              <small>${item.mandatory === false ? 'Optional' : 'Mandatory'}</small>
            </span>
          </label>
        `).join('') || '<p>No checklist items configured.</p>'}
        <label>Completion Notes<textarea name="notes" rows="3" ${closed ? 'disabled' : ''}></textarea></label>
        <label>Problems Found<textarea name="problemsFound" rows="3" ${closed ? 'disabled' : ''}></textarea></label>
        <label>Corrective Action Taken<textarea name="correctiveActionTaken" rows="3" ${closed ? 'disabled' : ''}></textarea></label>
        ${renderUploadField({
          name: 'evidence',
          label: 'Evidence',
          documents: [],
          disabled: closed,
        })}
        <div class="maintenance-form-actions">
          <button type="submit" ${closed ? 'disabled' : ''}>Complete Maintenance</button>
          <button type="button" data-skip-task-id="${escapeHtmlAttribute(task.id)}" ${closed ? 'disabled' : ''}>Not Relevant Today</button>
          <button type="button" data-show-task-fault-form>Report Fault</button>
        </div>
      </form>
      <form id="maintenanceTaskFaultForm" class="maintenance-form maintenance-task-fault-form" hidden>
        <h3>Report Fault</h3>
        <label>Title<input name="title" required /></label>
        <label>Description<textarea name="description" rows="3"></textarea></label>
        <label>Severity
          <select name="severity">
            <option value="low">Low</option>
            <option value="medium" selected>Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        <label>Equipment Impact
          <select name="equipmentImpact">
            <option value="none">No status change</option>
            <option value="restricted_use">Restricted Use</option>
            <option value="out_of_service">Out of Service</option>
          </select>
        </label>
        ${renderUploadField({
          name: 'attachments',
          label: 'Attachments',
          documents: [],
        })}
        <div class="maintenance-form-actions">
          <button type="submit">Save Fault</button>
        </div>
      </form>
    </div>
  `;
}

function renderFaultForm() {
  const form = document.getElementById('maintenanceFaultForm');
  if (!form) return;
  form.innerHTML = `
    <label>Equipment
      <select name="assetId">
        <option value="">General / Unassigned</option>
        ${getActiveAssets().map((asset) => `<option value="${escapeHtmlAttribute(asset.id)}">${escapeHtml(asset.name)}</option>`).join('')}
      </select>
    </label>
    <label>Title<input name="title" required /></label>
    <label>Description<textarea name="description" rows="4"></textarea></label>
    <label>Severity
      <select name="severity">
        <option value="low">Low</option>
        <option value="medium" selected>Medium</option>
        <option value="high">High</option>
        <option value="critical">Critical</option>
      </select>
    </label>
    <label>Equipment Impact
      <select name="equipmentImpact">
        <option value="none">No status change</option>
        <option value="restricted_use">Restricted Use</option>
        <option value="out_of_service">Out of Service</option>
      </select>
    </label>
    ${renderUploadField({
      name: 'attachments',
      label: 'Attachments',
      documents: [],
    })}
    <div class="maintenance-form-actions">
      <button type="submit">Report Fault</button>
    </div>
  `;
}

function renderFaultList() {
  const container = document.getElementById('maintenanceFaultList');
  if (!container) return;
  const faults = getFaults();
  container.innerHTML = faults.length ? `
    <div class="maintenance-table-wrap">
      <table class="maintenance-table">
        <thead><tr><th>Fault</th><th>Equipment</th><th>Severity</th><th>Status</th><th>Reported</th><th>Actions</th></tr></thead>
        <tbody>
          ${faults.map((fault) => `
            <tr>
              <td><strong>${escapeHtml(fault.faultRef)}</strong><span>${escapeHtml(fault.title)}</span>${renderCompactDocumentLinks(fault.attachments)}</td>
              <td>${escapeHtml(fault.assetName || 'General')}</td>
              <td>${statusPill(fault.severity)}</td>
              <td>
                <select data-fault-status-id="${escapeHtmlAttribute(fault.id)}">
                  ${['reported', 'acknowledged', 'investigating', 'awaiting_parts', 'corrective_maintenance_required', 'in_progress', 'resolved', 'closed'].map((status) => `
                    <option value="${status}" ${fault.status === status ? 'selected' : ''}>${escapeHtml(formatLabel(status))}</option>
                  `).join('')}
                </select>
              </td>
              <td>${escapeHtml(formatTimestamp(fault.createdAt))}</td>
              <td class="maintenance-row-actions">
                <button type="button" data-create-corrective-fault-id="${escapeHtmlAttribute(fault.id)}">Corrective</button>
                <button type="button" data-return-available-fault-id="${escapeHtmlAttribute(fault.id)}">Resolve</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '<p class="pick-list-empty">No faults recorded.</p>';
}

function renderCorrectiveList() {
  const container = document.getElementById('maintenanceCorrectiveList');
  if (!container) return;
  const tasks = getCorrectiveTasks();
  container.innerHTML = tasks.length ? `
    <div class="maintenance-table-wrap">
      <table class="maintenance-table">
        <thead><tr><th>Task</th><th>Fault</th><th>Equipment</th><th>Priority</th><th>Target</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          ${tasks.map((task) => `
            <tr>
              <td><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.assignedTo || '')}</span></td>
              <td>${escapeHtml(task.faultRef || '-')}</td>
              <td>${escapeHtml(task.assetName || '-')}</td>
              <td>${statusPill(task.priority || 'medium')}</td>
              <td>${escapeHtml(task.targetDate ? formatDate(task.targetDate) : '-')}</td>
              <td>${statusPill(task.status)}</td>
              <td>
                ${task.status === 'completed' ? '' : `<button type="button" class="maintenance-small-btn" data-complete-corrective-id="${escapeHtmlAttribute(task.id)}">Complete</button>`}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '<p class="pick-list-empty">No corrective maintenance recorded.</p>';
}

function renderReports() {
  const container = document.getElementById('maintenanceReports');
  if (!container) return;
  const reports = maintenanceState.data?.reports || {};
  const metrics = reports.metrics || {};
  const cards = [
    ['Total Due', metrics.totalDue || 0],
    ['Completed', metrics.totalCompleted || 0],
    ['Overdue', metrics.totalOverdue || 0],
    ['Completion', `${metrics.completionPercent ?? 0}%`],
    ['Completed Late', metrics.completedLate || 0],
    ['Open Faults', metrics.openFaults || 0],
    ['Critical Faults', metrics.criticalFaults || 0],
    ['Corrective Outstanding', metrics.correctiveOutstanding || 0],
  ];
  container.innerHTML = `
    <div class="maintenance-summary-grid">
      ${cards.map(([label, value]) => `
        <article class="maintenance-stat">
          <p>${escapeHtml(label)}</p>
          <strong>${escapeHtml(value)}</strong>
        </article>
      `).join('')}
    </div>
    <div class="maintenance-two-col">
      <section>
        <h3>Performance By Equipment</h3>
        ${renderSimpleReportTable(reports.byEquipment || [], ['equipmentName', 'due', 'completed', 'overdue'])}
      </section>
      <section>
        <h3>Faults By Severity</h3>
        ${renderSimpleReportTable(reports.faultBySeverity || [], ['severity', 'count'])}
      </section>
    </div>
    <section>
      <h3>Maintenance History</h3>
      ${renderSimpleReportTable((reports.maintenanceHistory || []).slice(0, 30), ['dueDate', 'equipmentName', 'taskTitle', 'completedBy', 'completedAt', 'timeliness', 'evidence'])}
    </section>
    <section>
      <h3>Fault History</h3>
      ${renderSimpleReportTable((reports.faultHistory || []).slice(0, 30), ['faultRef', 'assetName', 'createdAt', 'reportedBy', 'severity', 'status', 'resolvedAt', 'attachments'])}
    </section>
  `;
}

function renderReportCell(row, key) {
  const value = row?.[key];
  if (Array.isArray(value)) return renderCompactDocumentLinks(value) || '-';
  if (key.toLowerCase().includes('at')) return escapeHtml(formatTimestamp(value));
  return escapeHtml(value ?? '');
}

function renderSimpleReportTable(rows, keys) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) return '<p class="pick-list-empty">No records.</p>';
  return `
    <div class="maintenance-table-wrap">
      <table class="maintenance-table">
        <thead><tr>${keys.map((key) => `<th>${escapeHtml(formatLabel(key))}</th>`).join('')}</tr></thead>
        <tbody>
          ${safeRows.map((row) => `
            <tr>${keys.map((key) => `<td>${renderReportCell(row, key)}</td>`).join('')}</tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderNotificationForm() {
  const form = document.getElementById('maintenanceNotificationForm');
  if (!form) return;
  const settings = maintenanceState.data?.notificationSettings || {};
  form.innerHTML = `
    <label class="maintenance-checkbox"><input name="googleChatEnabled" type="checkbox" ${settings.googleChatEnabled ? 'checked' : ''} /> Enable Google Chat</label>
    <label class="maintenance-checkbox"><input name="dailyCompletionEnabled" type="checkbox" ${settings.dailyCompletionEnabled === false ? '' : 'checked'} /> Daily equipment completion notification</label>
    <label>Destination Name<input name="googleChatDestinationName" value="${escapeHtmlAttribute(settings.googleChatDestinationName || '')}" /></label>
    <label>Webhook URL<input name="googleChatWebhookUrl" type="password" placeholder="${settings.hasGoogleChatWebhook ? 'Webhook configured' : 'Paste webhook URL'}" /></label>
    <div class="maintenance-form-actions">
      <button type="submit">Save Notifications</button>
      <button type="button" data-test-google-chat>Test Google Chat</button>
    </div>
  `;
}

function renderAll() {
  renderMachineWorkflow();
  renderDashboard();
  renderCalendar();
  renderTaskDetail();
  renderAssetList();
  renderAssetForm();
  renderAssetHistory();
  renderTemplateList();
  renderTemplateForm();
  renderFaultList();
  renderFaultForm();
  renderCorrectiveList();
  renderReports();
  renderNotificationForm();
}

async function fetchMaintenance({ silent = false } = {}) {
  if (maintenanceState.loading) return;
  setLoading(true);
  if (!silent) setStatus('Loading maintenance.', 'info');
  try {
    const range = getRangeForSelectedDate();
    const params = new URLSearchParams(range);
    params.set('date', getSelectedDate());
    const data = await apiJson(`/api/maintenance/bootstrap?${params.toString()}`);
    maintenanceState.data = data;
    renderAll();
    updateLastUpdatedLabel();
    if (!silent) {
      setStatus(`Loaded maintenance. ${data.generated?.generatedCount || 0} schedule checks processed.`, 'success');
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

function activateTab(tab) {
  maintenanceState.activeTab = tab;
  document.querySelectorAll('[data-maintenance-tab]').forEach((button) => {
    const active = button.dataset.maintenanceTab === tab;
    button.classList.toggle('is-active', active);
  });
  document.querySelectorAll('[data-maintenance-panel]').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.maintenancePanel === tab);
  });
}

function openTask(taskId, options = {}) {
  const task = findScheduled(taskId);
  maintenanceState.selectedTaskId = taskId;
  if (options.fromMachine && task) {
    maintenanceState.selectedMachineId = task.assetId;
    maintenanceState.returnTabAfterTask = 'machine';
  } else {
    maintenanceState.returnTabAfterTask = null;
  }
  renderTaskDetail();
  activateTab('work');
  document.getElementById('maintenancePanelWork')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openAsset(assetId) {
  maintenanceState.selectedAssetId = assetId;
  renderAssetHistory();
  activateTab('assets');
}

function serializeAssetForm(form) {
  const formData = new FormData(form);
  return {
    id: formData.get('id'),
    name: formData.get('name'),
    equipmentType: formData.get('equipmentType'),
    uniqueIdentifier: formData.get('uniqueIdentifier'),
    manufacturer: formData.get('manufacturer'),
    model: formData.get('model'),
    serialNumber: formData.get('serialNumber'),
    location: formData.get('location'),
    availabilityStatus: formData.get('availabilityStatus'),
    photoUrl: '',
    description: formData.get('description'),
    notes: formData.get('notes'),
    active: formData.get('active') === 'on',
  };
}

function serializeTemplateForm(form) {
  const formData = new FormData(form);
  return {
    id: formData.get('id'),
    targetScope: formData.get('targetScope') || 'equipment_type',
    targetEquipmentType: formData.get('targetEquipmentType'),
    frequencyId: formData.get('frequencyId'),
    assignedTo: formData.get('assignedTo'),
    scheduleDaysOfWeek: formData.getAll('scheduleDaysOfWeek'),
    scheduleDayOfWeek: formData.get('scheduleDayOfWeek'),
    scheduleDayOfMonth: formData.get('scheduleDayOfMonth'),
    title: formData.get('title'),
    estimatedMinutes: formData.get('estimatedMinutes'),
    instructions: formData.get('instructions'),
    checklist: parseChecklistTextarea(formData.get('checklist')),
    documents: [],
    completionNotesRequired: formData.get('completionNotesRequired') === 'on',
    evidenceRequired: formData.get('evidenceRequired') === 'on',
    active: formData.get('active') === 'on',
  };
}

function serializeFaultForm(form, extras = {}) {
  const formData = new FormData(form);
  return {
    assetId: formData.get('assetId') || extras.assetId,
    scheduledInstanceId: extras.scheduledInstanceId,
    completionRecordId: extras.completionRecordId,
    title: formData.get('title'),
    description: formData.get('description'),
    severity: formData.get('severity'),
    equipmentImpact: formData.get('equipmentImpact'),
    attachments: [],
  };
}

async function saveAsset(form) {
  const payload = serializeAssetForm(form);
  payload.name = String(payload.name || '').trim();
  if (!payload.name) {
    form.querySelector('[name="name"]')?.focus();
    setStatus('Enter an equipment name before saving.', 'error');
    return;
  }

  const id = String(payload.id || '').trim();
  const submitButton = form.querySelector('button[type="submit"]');
  const previousButtonText = submitButton?.textContent || '';
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = 'Saving...';
  }
  setStatus(id ? 'Saving equipment changes.' : 'Adding equipment.', 'info');

  try {
    payload.photoUrl = await uploadSingleMaintenanceFileUrl(form, 'photo');
    await apiJson(id ? `/api/maintenance/assets/${encodeURIComponent(id)}` : '/api/maintenance/assets', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    maintenanceState.editingAssetId = null;
    await fetchMaintenance({ silent: true });
    setStatus('Equipment saved.', 'success');
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = previousButtonText;
    }
  }
}

async function saveTemplate(form) {
  if (!form) {
    setStatus('Instruction form was not found.', 'error');
    return;
  }
  const payload = serializeTemplateForm(form);
  payload.targetEquipmentType = String(payload.targetEquipmentType || '').trim();
  payload.frequencyId = String(payload.frequencyId || '').trim();
  payload.title = String(payload.title || '').trim();
  if (!payload.targetEquipmentType) {
    form.querySelector('[name="targetEquipmentType"]')?.focus();
    setStatus('Choose a machine type before saving instructions.', 'error');
    return;
  }
  if (!payload.frequencyId) {
    form.querySelector('[name="frequencyId"]')?.focus();
    setStatus('Choose a frequency before saving instructions.', 'error');
    return;
  }
  if (!payload.title) {
    form.querySelector('[name="title"]')?.focus();
    setStatus('Enter an instruction title before saving.', 'error');
    return;
  }

  const id = String(payload.id || '').trim();
  const submitButton = form.querySelector('[data-save-template]');
  const previousButtonText = submitButton?.textContent || '';
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = 'Saving...';
  }
  setStatus(id ? 'Saving instruction changes.' : 'Adding instructions.', 'info');

  try {
    payload.documents = await uploadMaintenanceFiles(form, 'documents');
    await apiJson(id ? `/api/maintenance/templates/${encodeURIComponent(id)}` : '/api/maintenance/templates', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    maintenanceState.selectedTemplateMachineType = payload.targetEquipmentType || maintenanceState.selectedTemplateMachineType;
    maintenanceState.editingTemplateId = null;
    await fetchMaintenance({ silent: true });
    setStatus('Instructions saved.', 'success');
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = previousButtonText;
    }
  }
}

async function completeSelectedTask(form) {
  const task = findScheduled(maintenanceState.selectedTaskId);
  if (!task) return;
  const formData = new FormData(form);
  const checked = new Set(formData.getAll('checklist').map(String));
  const responses = (task.checklist || []).map((item) => ({
    ...item,
    completed: checked.has(String(item.id)),
  }));
  const payload = {
    checklistResponses: responses,
    notes: formData.get('notes'),
    problemsFound: formData.get('problemsFound'),
    correctiveActionTaken: formData.get('correctiveActionTaken'),
    evidence: await uploadMaintenanceFiles(form, 'evidence'),
  };
  await apiJson(`/api/maintenance/scheduled/${encodeURIComponent(task.id)}/complete`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  await fetchMaintenance({ silent: true });
  if (maintenanceState.returnTabAfterTask === 'machine' && maintenanceState.selectedMachineId) {
    maintenanceState.selectedTaskId = null;
    renderMachineWorkflow();
    activateTab('machine');
    setStatus(`${task.taskTitle} completed.`, 'success');
    return;
  }
  maintenanceState.selectedTaskId = task.id;
  renderTaskDetail();
  setStatus(`${task.taskTitle} completed.`, 'success');
}

async function skipScheduledTask(taskId, options = {}) {
  const task = findScheduled(taskId);
  if (!task || isClosedScheduledStatus(task.status)) return;

  const reason = window.prompt('Reason for marking this not relevant today', 'Not deemed necessary today');
  if (reason === null) return;

  await apiJson(`/api/maintenance/scheduled/${encodeURIComponent(task.id)}/skip`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  await fetchMaintenance({ silent: true });

  if (options.fromMachine || maintenanceState.returnTabAfterTask === 'machine') {
    maintenanceState.selectedMachineId = task.assetId;
    maintenanceState.selectedTaskId = null;
    renderMachineWorkflow();
    activateTab('machine');
    setStatus(`${task.taskTitle} marked not relevant today.`, 'success');
    return;
  }

  maintenanceState.selectedTaskId = task.id;
  renderTaskDetail();
  setStatus(`${task.taskTitle} marked not relevant today.`, 'success');
}

async function scheduleExtraDailyTasks(assetId) {
  const asset = findAsset(assetId);
  if (!asset) return;
  const date = getSelectedDate();
  const confirmed = window.confirm(`Schedule all daily tasks for ${asset.name} on ${formatDate(date)}?`);
  if (!confirmed) return;

  const result = await apiJson(`/api/maintenance/assets/${encodeURIComponent(asset.id)}/schedule-daily`, {
    method: 'POST',
    body: JSON.stringify({ date }),
  });
  maintenanceState.selectedMachineId = asset.id;
  await fetchMaintenance({ silent: true });
  renderMachineWorkflow();
  activateTab('machine');
  const added = Number(result.scheduledCount || 0);
  const existing = Number(result.existingCount || 0);
  setStatus(`Daily tasks scheduled for ${asset.name}: ${added} added${existing ? `, ${existing} already present` : ''}.`, 'success');
}

async function clearOverdueDailyTasks() {
  const overdueDaily = getOverdueDailyTasks();
  if (!overdueDaily.length) {
    setStatus('There are no overdue daily tasks to clear.', 'info');
    return;
  }

  const date = getSelectedDate();
  const confirmed = window.confirm(`Clear ${overdueDaily.length} overdue daily task${overdueDaily.length === 1 ? '' : 's'} before ${formatDate(date)}?`);
  if (!confirmed) return;

  const result = await apiJson('/api/maintenance/scheduled/clear-overdue-daily', {
    method: 'POST',
    body: JSON.stringify({ beforeDate: date }),
  });
  await fetchMaintenance({ silent: true });
  renderDashboard();
  setStatus(`Cleared ${Number(result.clearedCount || 0)} overdue daily task${Number(result.clearedCount || 0) === 1 ? '' : 's'}.`, 'success');
}

async function reportFault(payload) {
  await apiJson('/api/maintenance/faults', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  await fetchMaintenance({ silent: true });
  setStatus('Fault recorded.', 'success');
}

async function updateFaultStatus(faultId, status, returnEquipmentToAvailable = false) {
  await apiJson(`/api/maintenance/faults/${encodeURIComponent(faultId)}`, {
    method: 'PUT',
    body: JSON.stringify({
      status,
      returnEquipmentToAvailable,
      resolutionNotes: returnEquipmentToAvailable ? 'Resolved from maintenance dashboard' : '',
    }),
  });
  await fetchMaintenance({ silent: true });
  setStatus('Fault updated.', 'success');
}

async function createCorrectiveTask(faultId) {
  const fault = getFaults().find((item) => String(item.id) === String(faultId));
  if (!fault) return;
  const title = window.prompt('Corrective maintenance title', `Corrective maintenance for ${fault.faultRef}`);
  if (!title) return;
  await apiJson(`/api/maintenance/faults/${encodeURIComponent(faultId)}/corrective`, {
    method: 'POST',
    body: JSON.stringify({
      title,
      instructions: 'Describe the corrective work required before assigning.',
      checklist: [{ id: 'item_1', text: 'Corrective work completed and checked', mandatory: true, sortOrder: 0 }],
      priority: fault.severity,
      assetId: fault.assetId,
    }),
  });
  await fetchMaintenance({ silent: true });
  setStatus('Corrective maintenance created.', 'success');
}

async function completeCorrectiveTask(taskId) {
  const task = getCorrectiveTasks().find((item) => String(item.id) === String(taskId));
  if (!task) return;
  const completionNotes = window.prompt('Completion notes', '');
  if (completionNotes === null) return;
  await apiJson(`/api/maintenance/corrective/${encodeURIComponent(taskId)}/complete`, {
    method: 'POST',
    body: JSON.stringify({
      checklistResponses: (task.checklist || []).map((item) => ({ ...item, completed: true })),
      completionNotes,
      faultResolution: '',
    }),
  });
  await fetchMaintenance({ silent: true });
  setStatus('Corrective maintenance completed.', 'success');
}

async function saveNotificationSettings(form) {
  const formData = new FormData(form);
  const webhookUrl = String(formData.get('googleChatWebhookUrl') || '').trim();
  const payload = {
    googleChatEnabled: formData.get('googleChatEnabled') === 'on',
    dailyCompletionEnabled: formData.get('dailyCompletionEnabled') === 'on',
    googleChatDestinationName: formData.get('googleChatDestinationName'),
  };
  if (webhookUrl) payload.googleChatWebhookUrl = webhookUrl;
  await apiJson('/api/maintenance/settings/notifications', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  await fetchMaintenance({ silent: true });
  setStatus('Notification settings saved.', 'success');
}

async function testGoogleChat() {
  await apiJson('/api/maintenance/settings/notifications/test', {
    method: 'POST',
    body: JSON.stringify({ message: 'Workshop maintenance Google Chat test notification.' }),
  });
  setStatus('Google Chat test sent.', 'success');
}

function installHandlers() {
  document.getElementById('maintenanceRefreshBtn')?.addEventListener('click', () => fetchMaintenance());
  document.getElementById('maintenanceDate')?.addEventListener('change', () => fetchMaintenance());
  document.getElementById('maintenanceMachineSelect')?.addEventListener('change', (event) => {
    maintenanceState.selectedMachineId = event.target.value;
    renderMachineWorkflow();
  });

  document.querySelector('.maintenance-tabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-maintenance-tab]');
    if (button) activateTab(button.dataset.maintenanceTab);
  });

  document.querySelector('.maintenance-view-toggle')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-maintenance-view]');
    if (!button) return;
    maintenanceState.calendarView = button.dataset.maintenanceView;
    document.querySelectorAll('[data-maintenance-view]').forEach((item) => {
      item.classList.toggle('is-active', item === button);
    });
    renderCalendar();
  });

  ['maintenanceFilterAsset', 'maintenanceFilterType', 'maintenanceFilterFrequency', 'maintenanceFilterStatus'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', (event) => {
      const key = id.replace('maintenanceFilter', '').toLowerCase();
      maintenanceState.filters[key === 'asset' ? 'asset' : key === 'type' ? 'type' : key === 'frequency' ? 'frequency' : 'status'] = event.target.value;
      renderCalendar();
    });
  });

  document.body.addEventListener('click', async (event) => {
    try {
    const dashboardTaskTab = event.target.closest('[data-dashboard-task-view]');
    if (dashboardTaskTab) {
      maintenanceState.dashboardTaskView = dashboardTaskTab.dataset.dashboardTaskView;
      renderDashboard();
      return;
    }

    const backToMachineButton = event.target.closest('[data-back-to-machine-workflow]');
    if (backToMachineButton) {
      renderMachineWorkflow();
      activateTab('machine');
      return;
    }

    const openMachineTaskButton = event.target.closest('[data-open-machine-task-id]');
    if (openMachineTaskButton) {
      openTask(openMachineTaskButton.dataset.openMachineTaskId, { fromMachine: true });
      return;
    }

    const scheduleExtraDailyButton = event.target.closest('[data-schedule-extra-daily-asset-id]');
    if (scheduleExtraDailyButton) {
      await scheduleExtraDailyTasks(scheduleExtraDailyButton.dataset.scheduleExtraDailyAssetId);
      return;
    }

    const skipMachineTaskButton = event.target.closest('[data-skip-machine-task-id]');
    if (skipMachineTaskButton) {
      await skipScheduledTask(skipMachineTaskButton.dataset.skipMachineTaskId, { fromMachine: true });
      return;
    }

    const skipTaskButton = event.target.closest('[data-skip-task-id]');
    if (skipTaskButton) {
      await skipScheduledTask(skipTaskButton.dataset.skipTaskId);
      return;
    }

    if (event.target.closest('[data-clear-overdue-daily]')) {
      await clearOverdueDailyTasks();
      return;
    }

    const openTaskButton = event.target.closest('[data-open-task-id]');
    if (openTaskButton) {
      openTask(openTaskButton.dataset.openTaskId);
      return;
    }

    const openAssetButton = event.target.closest('[data-open-asset-id]');
    if (openAssetButton) {
      openAsset(openAssetButton.dataset.openAssetId);
      return;
    }

    const editAssetButton = event.target.closest('[data-edit-asset-id]');
    if (editAssetButton) {
      maintenanceState.editingAssetId = editAssetButton.dataset.editAssetId;
      renderAssetForm();
      return;
    }

    if (event.target.closest('[data-reset-asset-form]')) {
      maintenanceState.editingAssetId = null;
      renderAssetForm();
      return;
    }

    const duplicateAssetButton = event.target.closest('[data-duplicate-asset-id]');
    if (duplicateAssetButton) {
      await apiJson(`/api/maintenance/assets/${encodeURIComponent(duplicateAssetButton.dataset.duplicateAssetId)}/duplicate`, { method: 'POST' });
      await fetchMaintenance({ silent: true });
      setStatus('Equipment duplicated.', 'success');
      return;
    }

    const archiveAssetButton = event.target.closest('[data-archive-asset-id]');
    if (archiveAssetButton) {
      if (!window.confirm('Archive this equipment and retain its history?')) return;
      await apiJson(`/api/maintenance/assets/${encodeURIComponent(archiveAssetButton.dataset.archiveAssetId)}/archive`, { method: 'POST' });
      await fetchMaintenance({ silent: true });
      setStatus('Equipment archived.', 'success');
      return;
    }

    const templateMachineTypeButton = event.target.closest('[data-template-machine-type]');
    if (templateMachineTypeButton) {
      maintenanceState.selectedTemplateMachineType = templateMachineTypeButton.dataset.templateMachineType;
      renderTemplateList();
      if (!maintenanceState.editingTemplateId) renderTemplateForm();
      return;
    }

    const editTemplateButton = event.target.closest('[data-edit-template-id]');
    if (editTemplateButton) {
      maintenanceState.editingTemplateId = editTemplateButton.dataset.editTemplateId;
      const template = findTemplate(maintenanceState.editingTemplateId);
      if (template) maintenanceState.selectedTemplateMachineType = getTemplateMachineType(template);
      renderTemplateList();
      renderTemplateForm();
      return;
    }

    const saveTemplateButton = event.target.closest('[data-save-template]');
    if (saveTemplateButton) {
      try {
        await saveTemplate(saveTemplateButton.form);
      } catch (err) {
        setStatus(`Error: ${err.message}`, 'error');
      }
      return;
    }

    if (event.target.closest('[data-reset-template-form]')) {
      maintenanceState.editingTemplateId = null;
      renderTemplateForm();
      return;
    }

    const duplicateTemplateButton = event.target.closest('[data-duplicate-template-id]');
    if (duplicateTemplateButton) {
      await apiJson(`/api/maintenance/templates/${encodeURIComponent(duplicateTemplateButton.dataset.duplicateTemplateId)}/duplicate`, { method: 'POST' });
      await fetchMaintenance({ silent: true });
      setStatus('Instruction duplicated.', 'success');
      return;
    }

    const archiveTemplateButton = event.target.closest('[data-archive-template-id]');
    if (archiveTemplateButton) {
      if (!window.confirm('Archive this instruction and stop future scheduled maintenance from it?')) return;
      await apiJson(`/api/maintenance/templates/${encodeURIComponent(archiveTemplateButton.dataset.archiveTemplateId)}/archive`, { method: 'POST' });
      await fetchMaintenance({ silent: true });
      setStatus('Instruction archived.', 'success');
      return;
    }

    if (event.target.closest('[data-show-task-fault-form]')) {
      const form = document.getElementById('maintenanceTaskFaultForm');
      if (form) form.hidden = !form.hidden;
      return;
    }

    const correctiveButton = event.target.closest('[data-create-corrective-fault-id]');
    if (correctiveButton) {
      await createCorrectiveTask(correctiveButton.dataset.createCorrectiveFaultId);
      return;
    }

    const resolveButton = event.target.closest('[data-return-available-fault-id]');
    if (resolveButton) {
      await updateFaultStatus(resolveButton.dataset.returnAvailableFaultId, 'resolved', true);
      return;
    }

    const completeCorrectiveButton = event.target.closest('[data-complete-corrective-id]');
    if (completeCorrectiveButton) {
      await completeCorrectiveTask(completeCorrectiveButton.dataset.completeCorrectiveId);
      return;
    }

    if (event.target.closest('[data-test-google-chat]')) {
      await testGoogleChat();
    }
    } catch (err) {
      setStatus(`Error: ${err.message}`, 'error');
    }
  });

  document.body.addEventListener('change', async (event) => {
    try {
    const uploadInput = event.target.closest('[data-upload-input]');
    if (uploadInput) {
      renderSelectedUploadNames(uploadInput);
      return;
    }

    const templateFrequencySelect = event.target.closest('#maintenanceTemplateForm [name="frequencyId"]');
    if (templateFrequencySelect) {
      updateTemplateScheduleFields(templateFrequencySelect.form);
      return;
    }

    const statusSelect = event.target.closest('[data-fault-status-id]');
    if (statusSelect) {
      await updateFaultStatus(statusSelect.dataset.faultStatusId, statusSelect.value, false);
    }
    } catch (err) {
      setStatus(`Error: ${err.message}`, 'error');
    }
  });

  document.body.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      if (event.target.id === 'maintenanceAssetForm') {
        await saveAsset(event.target);
        return;
      }
      if (event.target.id === 'maintenanceTemplateForm') {
        await saveTemplate(event.target);
        return;
      }
      if (event.target.id === 'maintenanceCompleteForm') {
        await completeSelectedTask(event.target);
        return;
      }
      if (event.target.id === 'maintenanceFaultForm') {
        const payload = serializeFaultForm(event.target);
        payload.attachments = await uploadMaintenanceFiles(event.target, 'attachments');
        await reportFault(payload);
        event.target.reset();
        return;
      }
      if (event.target.id === 'maintenanceTaskFaultForm') {
        const task = findScheduled(maintenanceState.selectedTaskId);
        const payload = serializeFaultForm(event.target, {
          assetId: task?.assetId,
          scheduledInstanceId: task?.id,
        });
        payload.attachments = await uploadMaintenanceFiles(event.target, 'attachments');
        await reportFault(payload);
        event.target.reset();
        event.target.hidden = true;
        return;
      }
      if (event.target.id === 'maintenanceNotificationForm') {
        await saveNotificationSettings(event.target);
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`, 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const dateInput = document.getElementById('maintenanceDate');
  if (dateInput && !dateInput.value) dateInput.value = todayKey();
  installHandlers();
  fetchMaintenance();
  if (maintenancePollId) clearInterval(maintenancePollId);
  maintenancePollId = setInterval(() => fetchMaintenance({ silent: true }), MAINTENANCE_POLL_MS);
});
