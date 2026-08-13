const fetch = require('node-fetch');
const maintenanceStore = require('./maintenanceStore');

const DEFAULT_CALENDAR_COLORS = {
  daily: '#31c48d',
  weekly: '#3b82f6',
  monthly: '#f59e0b',
};

function normalizeText(value) {
  return String(value || '').trim();
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function toDateKey(date = new Date()) {
  const parsed = date instanceof Date ? date : new Date(date);
  const safe = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return `${safe.getFullYear()}-${pad2(safe.getMonth() + 1)}-${pad2(safe.getDate())}`;
}

function parseDateKey(value, fallback = new Date()) {
  const raw = normalizeText(value);
  const fallbackDate = fallback instanceof Date && !Number.isNaN(fallback.getTime()) ? fallback : new Date();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (
      parsed.getFullYear() === Number(match[1]) &&
      parsed.getMonth() === Number(match[2]) - 1 &&
      parsed.getDate() === Number(match[3])
    ) {
      return parsed;
    }
  }
  const parsed = new Date(raw || fallbackDate);
  return Number.isNaN(parsed.getTime()) ? fallbackDate : parsed;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + Number(days || 0));
  return next;
}

function normalizeWeekday(value, fallback = 1) {
  if (value === null || value === undefined || value === '') return fallback;
  const raw = String(value).trim();
  if (!raw) return fallback;
  const parsed = Math.floor(Number(raw));
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 6 ? parsed : fallback;
}

function normalizeMonthDay(value, fallback = 1) {
  if (value === null || value === undefined || value === '') return fallback;
  const raw = String(value).trim();
  if (!raw) return fallback;
  const parsed = Math.floor(Number(raw));
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(31, Math.max(1, parsed));
}

function normalizeWeekdays(value, fallback = [1, 2, 3, 4, 5]) {
  let rawItems = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (trimmed.startsWith('[')) {
      try {
        rawItems = JSON.parse(trimmed);
      } catch (_err) {
        rawItems = [];
      }
    } else {
      rawItems = trimmed.split(',');
    }
  }
  const selected = new Set(
    (Array.isArray(rawItems) ? rawItems : [])
      .map((item) => Math.floor(Number(item)))
      .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6)
  );
  const normalized = [1, 2, 3, 4, 5, 6, 0].filter((day) => selected.has(day));
  return normalized.length ? normalized : fallback;
}

function getLastDayOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function getDateRange(startDate, endDate) {
  const start = parseDateKey(startDate);
  const end = parseDateKey(endDate, start);
  const safeEnd = end < start ? start : end;
  const dates = [];
  for (let cursor = new Date(start); cursor <= safeEnd; cursor = addDays(cursor, 1)) {
    dates.push(toDateKey(cursor));
  }
  return dates;
}

function getDefaultRange(date = new Date()) {
  const base = parseDateKey(date);
  const start = new Date(base.getFullYear(), base.getMonth(), 1);
  const end = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  return {
    startDate: toDateKey(addDays(start, -7)),
    endDate: toDateKey(addDays(end, 14)),
    today: toDateKey(base),
  };
}

function getCalendarStatus(instance, today = toDateKey()) {
  if (instance.status === 'completed') return 'completed';
  if (instance.status === 'cancelled') return 'cancelled';
  if (instance.status === 'skipped') return 'skipped';
  if (instance.dueDate < today) return 'overdue';
  if (instance.dueDate === today) return 'due_today';
  return 'upcoming';
}

function isTemplateDueOnDate(templateRow, dateKey) {
  const type = normalizeText(templateRow.scheduleType).toLowerCase();
  const interval = Math.max(1, Number(templateRow.intervalValue || 1));
  const date = parseDateKey(dateKey);

  if (type === 'daily') return normalizeWeekdays(templateRow.scheduleDaysOfWeekJson, [1, 2, 3, 4, 5]).includes(date.getDay());
  if (type === 'weekly') {
    return date.getDay() === normalizeWeekday(templateRow.scheduleDayOfWeek, 1);
  }
  if (type === 'monthly') {
    const dueDay = Math.min(normalizeMonthDay(templateRow.scheduleDayOfMonth, 1), getLastDayOfMonth(date));
    return date.getDate() === dueDay;
  }
  if (type === 'every_x_days' || type === 'every_n_days') {
    const created = parseDateKey(templateRow.createdAt, date);
    const diffDays = Math.floor((date - created) / 86400000);
    return diffDays >= 0 && diffDays % interval === 0;
  }

  return false;
}

function getRangeFromRequest(query = {}) {
  const defaults = getDefaultRange(query.date || new Date());
  return {
    startDate: normalizeText(query.startDate) || defaults.startDate,
    endDate: normalizeText(query.endDate) || defaults.endDate,
    today: defaults.today,
  };
}

function generateScheduledMaintenance({ shop, startDate, endDate } = {}) {
  const templates = maintenanceStore.listActiveTemplateRows({ shop });
  const dates = getDateRange(startDate, endDate);
  let generatedCount = 0;
  const expectedKeys = new Set();

  templates.forEach((template) => {
    dates.forEach((dateKey) => {
      if (!isTemplateDueOnDate(template, dateKey)) return;
      const assetId = Number(template.resolvedAssetId || template.assetId || 0);
      if (assetId > 0) expectedKeys.add(`${template.id}:${assetId}:${dateKey}`);
      const inserted = maintenanceStore.insertScheduledInstanceIfMissing({
        shop,
        templateRow: template,
        dueDate: dateKey,
      });
      if (inserted) generatedCount += 1;
    });
  });

  const prunedCount = maintenanceStore.prunePendingPreventiveScheduledInstances({
    shop,
    startDate,
    endDate,
    expectedKeys: Array.from(expectedKeys),
  });

  return { generatedCount, prunedCount, templateCount: templates.length, dateCount: dates.length };
}

function scheduleUnexpectedDailyMaintenance({ shop, assetId, date, user = null } = {}) {
  const normalizedAssetId = Number(assetId || 0);
  const dueDate = toDateKey(parseDateKey(date || new Date()));
  const asset = maintenanceStore.getAsset({ shop, id: normalizedAssetId });
  if (!asset || asset.archivedAt || !asset.active) {
    const err = new Error('Active machine not found');
    err.statusCode = 404;
    throw err;
  }

  const templates = maintenanceStore.listActiveTemplateRows({ shop })
    .filter((template) => (
      Number(template.resolvedAssetId || template.assetId) === normalizedAssetId &&
      normalizeText(template.scheduleType).toLowerCase() === 'daily'
    ));

  let scheduledCount = 0;
  templates.forEach((template) => {
    const inserted = maintenanceStore.insertScheduledInstanceIfMissing({
      shop,
      templateRow: template,
      dueDate,
      sourceType: 'ad_hoc_daily',
    });
    if (inserted) scheduledCount += 1;
  });

  return {
    asset,
    date: dueDate,
    templateCount: templates.length,
    scheduledCount,
    existingCount: Math.max(0, templates.length - scheduledCount),
    scheduledBy: normalizeText(user),
  };
}

function clearOverdueDailyMaintenance({ shop, beforeDate = null, user = null } = {}) {
  const cutoffDate = toDateKey(parseDateKey(beforeDate || new Date()));
  return maintenanceStore.clearOverdueDailyScheduledInstances({
    shop,
    beforeDate: cutoffDate,
    user,
  });
}

function attachCalendarStatus(instances = [], today = toDateKey()) {
  return (Array.isArray(instances) ? instances : []).map((instance) => ({
    ...instance,
    calendarStatus: getCalendarStatus(instance, today),
  }));
}

function buildDashboard({ shop, startDate, endDate, today = toDateKey() } = {}) {
  const scheduled = attachCalendarStatus(
    maintenanceStore.listScheduledInstances({ shop, startDate, endDate }),
    today
  );
  const faults = maintenanceStore.listFaults({ shop, includeClosed: true });
  const openFaults = faults.filter((fault) => !['resolved', 'closed'].includes(fault.status));
  const correctiveTasks = maintenanceStore.listCorrectiveTasks({ shop, includeCompleted: true });
  const recentCompleted = maintenanceStore.listCompletions({ shop, limit: 20 });
  const assets = maintenanceStore.listAssets({ shop, includeArchived: false });

  const dueToday = scheduled.filter((item) => item.calendarStatus === 'due_today');
  const overdue = scheduled.filter((item) => item.calendarStatus === 'overdue');
  const completedToday = scheduled.filter((item) => item.status === 'completed' && item.dueDate === today);
  const upcoming = scheduled
    .filter((item) => item.calendarStatus === 'upcoming' && item.dueDate <= toDateKey(addDays(parseDateKey(today), 7)))
    .slice(0, 50);

  const progressByAsset = assets.map((asset) => {
    const todaysItems = scheduled.filter((item) => item.assetId === asset.id && item.dueDate === today);
    const completed = todaysItems.filter((item) => item.status === 'completed').length;
    const overdueCount = todaysItems.filter((item) => item.calendarStatus === 'overdue').length;
    const assetOpenFaults = openFaults.filter((fault) => fault.assetId === asset.id).length;
    return {
      assetId: asset.id,
      name: asset.name,
      equipmentType: asset.equipmentType,
      availabilityStatus: asset.availabilityStatus,
      total: todaysItems.length,
      completed,
      outstanding: Math.max(0, todaysItems.length - completed),
      overdue: overdueCount,
      openFaults: assetOpenFaults,
    };
  });

  const onTimeCompletions = recentCompleted.filter((completion) => completion.timeliness === 'on_time' || completion.timeliness === 'early').length;
  const completedInRange = scheduled.filter((item) => item.status === 'completed').length;
  const dueInRange = scheduled.filter((item) => !['cancelled', 'skipped'].includes(item.status)).length;
  const criticalFaults = openFaults.filter((fault) => fault.severity === 'critical');
  const restrictedAssets = assets.filter((asset) => asset.availabilityStatus === 'restricted_use');
  const outOfServiceAssets = assets.filter((asset) => asset.availabilityStatus === 'out_of_service');
  const openCorrective = correctiveTasks.filter((task) => !['completed', 'cancelled'].includes(task.status));

  return {
    generatedAt: new Date().toISOString(),
    today,
    summary: {
      totalDue: dueInRange,
      completed: completedInRange,
      overdue: overdue.length,
      completionPercent: dueInRange > 0 ? Math.round((completedInRange / dueInRange) * 100) : 100,
      onTimeCompletions,
      dueToday: dueToday.length,
      completedToday: completedToday.length,
      openFaults: openFaults.length,
      criticalFaults: criticalFaults.length,
      restrictedEquipment: restrictedAssets.length,
      outOfServiceEquipment: outOfServiceAssets.length,
      correctiveOutstanding: openCorrective.length,
      correctiveOverdue: openCorrective.filter((task) => task.targetDate && task.targetDate < today).length,
    },
    dueToday,
    overdue,
    completedToday,
    recentlyCompleted: recentCompleted,
    upcoming,
    progressByAsset,
    openFaults,
    correctiveTasks,
  };
}

function buildReports({ shop, startDate, endDate, today = toDateKey() } = {}) {
  const scheduled = attachCalendarStatus(
    maintenanceStore.listScheduledInstances({ shop, startDate, endDate }),
    today
  );
  const completions = maintenanceStore.listCompletions({ shop, startDate, endDate, limit: 1000 });
  const faults = maintenanceStore.listFaults({ shop, includeClosed: true, limit: 1000 });
  const correctiveTasks = maintenanceStore.listCorrectiveTasks({ shop, includeCompleted: true });

  const byEquipment = new Map();
  scheduled.forEach((item) => {
    const current = byEquipment.get(item.assetId) || {
      assetId: item.assetId,
      equipmentName: item.equipmentName,
      due: 0,
      completed: 0,
      overdue: 0,
    };
    current.due += ['cancelled', 'skipped'].includes(item.status) ? 0 : 1;
    current.completed += item.status === 'completed' ? 1 : 0;
    current.overdue += item.calendarStatus === 'overdue' ? 1 : 0;
    byEquipment.set(item.assetId, current);
  });

  const byFrequency = new Map();
  scheduled.forEach((item) => {
    const key = item.frequencyKey || item.frequencyLabel || 'unknown';
    const current = byFrequency.get(key) || {
      key,
      label: item.frequencyLabel || key,
      color: item.frequencyColor || DEFAULT_CALENDAR_COLORS[key] || '#6ba6ff',
      due: 0,
      completed: 0,
      overdue: 0,
    };
    current.due += ['cancelled', 'skipped'].includes(item.status) ? 0 : 1;
    current.completed += item.status === 'completed' ? 1 : 0;
    current.overdue += item.calendarStatus === 'overdue' ? 1 : 0;
    byFrequency.set(key, current);
  });

  const byOperator = new Map();
  completions.forEach((completion) => {
    const key = completion.completedBy || 'Unknown';
    const current = byOperator.get(key) || { operator: key, completed: 0, late: 0 };
    current.completed += 1;
    current.late += completion.timeliness === 'overdue' ? 1 : 0;
    byOperator.set(key, current);
  });

  const faultBySeverity = ['low', 'medium', 'high', 'critical'].map((severity) => ({
    severity,
    count: faults.filter((fault) => fault.severity === severity).length,
  }));

  const due = scheduled.filter((item) => !['cancelled', 'skipped'].includes(item.status)).length;
  const completed = scheduled.filter((item) => item.status === 'completed').length;
  const openFaults = faults.filter((fault) => !['resolved', 'closed'].includes(fault.status));

  return {
    metrics: {
      totalDue: due,
      totalCompleted: completed,
      totalOverdue: scheduled.filter((item) => item.calendarStatus === 'overdue').length,
      completionPercent: due > 0 ? Math.round((completed / due) * 100) : 100,
      completedOnTime: completions.filter((completion) => completion.timeliness !== 'overdue').length,
      completedLate: completions.filter((completion) => completion.timeliness === 'overdue').length,
      openFaults: openFaults.length,
      criticalFaults: openFaults.filter((fault) => fault.severity === 'critical').length,
      faultsRaised: faults.filter((fault) => fault.createdAt && fault.createdAt.slice(0, 10) >= startDate && fault.createdAt.slice(0, 10) <= endDate).length,
      faultsResolved: faults.filter((fault) => fault.resolvedAt && fault.resolvedAt.slice(0, 10) >= startDate && fault.resolvedAt.slice(0, 10) <= endDate).length,
      correctiveOutstanding: correctiveTasks.filter((task) => !['completed', 'cancelled'].includes(task.status)).length,
    },
    byEquipment: Array.from(byEquipment.values()),
    byFrequency: Array.from(byFrequency.values()),
    byOperator: Array.from(byOperator.values()),
    faultBySeverity,
    maintenanceHistory: completions,
    faultHistory: faults,
  };
}

function buildGoogleChatMessage(payload = {}) {
  if (payload.eventType === 'MaintenanceTaskSkipped') {
    return [
      '*Maintenance Skipped - Not Relevant Today*',
      '',
      `*${payload.taskTitle || 'Maintenance task'}*`,
      `Equipment: ${payload.equipmentName || 'Equipment'}`,
      `Machine type: ${payload.equipmentType || '-'}`,
      `Due date: ${payload.dueDate || '-'}`,
      `Skipped by: ${payload.skippedBy || 'Unknown'}`,
      `Reason: ${payload.reason || 'Not deemed necessary today'}`,
      '',
      'This maintenance task was marked not relevant today because it was not deemed necessary.',
    ].join('\n');
  }

  const faultLine = payload.openFaultCount > 0
    ? `\nOpen faults reported today: ${payload.openFaultCount}`
    : '';
  return [
    '*Workshop Maintenance Complete*',
    '',
    `*${payload.equipmentName || 'Equipment'}*`,
    `All scheduled maintenance for ${payload.date} has been completed.`,
    `Completed tasks: ${payload.completedCount} / ${payload.totalRequired}`,
    `Completed by: ${(payload.completedBy || []).join(', ') || 'Unknown'}`,
    `Final task completed: ${payload.finalCompletedAt || '-'}`,
    `Equipment status: ${payload.availabilityStatus || 'available'}${faultLine}`,
  ].join('\n');
}

async function dispatchGoogleChatNotification({ shop, event, settings }) {
  const webhookUrl = normalizeText(settings?.googleChatWebhookUrl);
  if (!settings?.googleChatEnabled || !webhookUrl) return;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: buildGoogleChatMessage(event.payload) }),
    });
    const body = await response.text().catch(() => '');
    maintenanceStore.recordNotificationAttempt({
      shop,
      eventId: event.id,
      provider: 'google_chat',
      status: response.ok ? 'sent' : 'failed',
      httpStatus: response.status,
      responseBody: body,
    });
  } catch (err) {
    maintenanceStore.recordNotificationAttempt({
      shop,
      eventId: event.id,
      provider: 'google_chat',
      status: 'failed',
      errorMessage: err.message || 'Google Chat notification failed',
    });
  }
}

async function evaluateDailyEquipmentCompletion({ shop, assetId, dueDate } = {}) {
  const state = maintenanceStore.getDailyEquipmentCompletionState({ shop, assetId, dueDate });
  if (!state?.isComplete) return { complete: false, notificationCreated: false };

  const instances = state.instances || [];
  const completions = instances
    .map((instance) => instance.completedAt)
    .filter(Boolean)
    .sort();
  const completedBy = new Set();
  maintenanceStore.listCompletions({ shop, startDate: dueDate, endDate: dueDate, assetId, limit: 500 })
    .forEach((completion) => {
      if (completion.completedBy) completedBy.add(completion.completedBy);
    });

  const asset = maintenanceStore.getAsset({ shop, id: assetId });
  const payload = {
    eventType: 'EquipmentDailyMaintenanceCompleted',
    equipmentId: assetId,
    equipmentName: asset?.name || instances[0]?.equipmentName,
    equipmentType: asset?.equipmentType || '',
    location: asset?.location || '',
    availabilityStatus: asset?.availabilityStatus || instances[0]?.assetAvailabilityStatus || 'available',
    date: dueDate,
    completedCount: state.completedCount,
    totalRequired: state.totalRequired,
    completedBy: Array.from(completedBy),
    finalCompletedAt: completions.pop() || new Date().toISOString(),
    openFaultCount: maintenanceStore.getOpenFaultCountForAssetDate({ shop, assetId, date: dueDate }),
  };

  const { event, created } = maintenanceStore.createNotificationEventIfMissing({
    shop,
    eventType: 'EquipmentDailyMaintenanceCompleted',
    assetId,
    eventDate: dueDate,
    cycle: 1,
    payload,
  });

  if (created && event) {
    const settings = maintenanceStore.getNotificationSettings({ shop, includeSecret: true });
    if (settings?.dailyCompletionEnabled) {
      await dispatchGoogleChatNotification({ shop, event, settings });
    }
  }

  return { complete: true, notificationCreated: created, event };
}

async function completeScheduledMaintenance({ shop, id, user, payload = {} } = {}) {
  const result = maintenanceStore.completeScheduledInstance({ shop, id, user, payload });
  if (!result?.instance) return null;
  await evaluateDailyEquipmentCompletion({
    shop,
    assetId: result.instance.assetId,
    dueDate: result.instance.dueDate,
  });
  return result;
}

async function skipScheduledMaintenance({ shop, id, user, payload = {} } = {}) {
  const result = maintenanceStore.skipScheduledInstance({ shop, id, user, payload });
  if (!result?.instance) return null;

  const instance = result.instance;
  const notificationPayload = {
    eventType: 'MaintenanceTaskSkipped',
    scheduledInstanceId: instance.id,
    templateId: instance.templateId,
    equipmentId: instance.assetId,
    equipmentName: instance.equipmentName,
    equipmentType: instance.equipmentType,
    taskTitle: instance.taskTitle,
    frequencyLabel: instance.frequencyLabel,
    dueDate: instance.dueDate,
    skippedAt: instance.skippedAt,
    skippedBy: instance.skippedBy || normalizeText(user) || '',
    reason: instance.skipReason || normalizeText(payload.reason) || 'Not deemed necessary today',
  };

  const { event, created } = maintenanceStore.createNotificationEventIfMissing({
    shop,
    eventType: 'MaintenanceTaskSkipped',
    assetId: instance.assetId,
    eventDate: instance.dueDate,
    cycle: instance.id,
    payload: notificationPayload,
  });

  if (created && event) {
    const settings = maintenanceStore.getNotificationSettings({ shop, includeSecret: true });
    await dispatchGoogleChatNotification({ shop, event, settings });
  }

  await evaluateDailyEquipmentCompletion({
    shop,
    assetId: instance.assetId,
    dueDate: instance.dueDate,
  });

  return {
    ...result,
    notificationCreated: created,
  };
}

async function testGoogleChatWebhook({ shop, message = null } = {}) {
  const settings = maintenanceStore.getNotificationSettings({ shop, includeSecret: true });
  const webhookUrl = normalizeText(settings?.googleChatWebhookUrl);
  if (!webhookUrl) {
    const err = new Error('No Google Chat webhook URL is configured');
    err.statusCode = 400;
    throw err;
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: message || 'Workshop maintenance Google Chat test notification.',
    }),
  });
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    const err = new Error(`Google Chat returned HTTP ${response.status}`);
    err.statusCode = 502;
    err.responseBody = body;
    throw err;
  }
  return { status: response.status, body };
}

module.exports = {
  DEFAULT_CALENDAR_COLORS,
  toDateKey,
  parseDateKey,
  addDays,
  getDefaultRange,
  getRangeFromRequest,
  getCalendarStatus,
  generateScheduledMaintenance,
  scheduleUnexpectedDailyMaintenance,
  clearOverdueDailyMaintenance,
  attachCalendarStatus,
  buildDashboard,
  buildReports,
  completeScheduledMaintenance,
  skipScheduledMaintenance,
  evaluateDailyEquipmentCompletion,
  testGoogleChatWebhook,
};
