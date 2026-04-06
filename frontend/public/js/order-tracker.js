const TRACKER_POLL_MS = 15000;
const TRACKER_INTRO_STEP_MS = 520;
const TRACKER_INTRO_FINAL_PAUSE_MS = 180;
const TRACKER_DEFAULT_STEP_COUNT = 5;
const TRACKER_SEGMENT_GAP = 5;
const TRACKER_ORB_CENTER = 120;
const TRACKER_SEGMENT_SHORT_LABELS = {
  'ORDER PLACED': 'ORDER',
  'IN WORKSHOP': 'WORKSHOP',
  'QUALITY CHECK': 'QC',
  'PACKED': 'PACKED',
  'COMPLETE': 'DONE',
  'FULFILLED': 'FULFILLED',
  'PART FULFILLED': 'PARTIAL',
  'CANCELLED': 'CANCELLED',
};
let trackerPollId = null;
let trackerHasPlayedIntro = false;
let trackerIntroRunId = 0;
const TRACKER_RING_RADIUS = 92;
const TRACKER_RING_CIRCUMFERENCE = 2 * Math.PI * TRACKER_RING_RADIUS;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getTrackerToken() {
  const pathMatch = window.location.pathname.match(/\/track\/([^/]+)$/);
  if (pathMatch?.[1]) {
    return decodeURIComponent(pathMatch[1]);
  }

  const params = new URLSearchParams(window.location.search);
  return params.get('token') || '';
}

function formatTrackerTimestamp(value) {
  if (!value) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function isCompactTrackerViewport() {
  return Boolean(window.matchMedia?.('(max-width: 700px)').matches);
}

function buildPlaceholderMilestones(count = TRACKER_DEFAULT_STEP_COUNT) {
  return Array.from({ length: count }, (_, index) => ({
    key: `placeholder-${index + 1}`,
    label: `Step ${index + 1}`,
    state: 'todo',
  }));
}

function resolveMilestoneStates(milestones, activeIndex = null) {
  if (!Array.isArray(milestones) || milestones.length === 0) {
    return [];
  }

  return Number.isInteger(activeIndex)
    ? buildMilestoneStates(milestones, activeIndex)
    : milestones;
}

function setTrackerProgressSummary(milestones, activeIndex = null, fallbackText = '') {
  const progressValue = document.getElementById('trackerProgressValue');
  if (!progressValue) return;

  const totalSteps = Array.isArray(milestones) && milestones.length > 0
    ? milestones.length
    : TRACKER_DEFAULT_STEP_COUNT;

  if (fallbackText) {
    progressValue.textContent = fallbackText;
    return;
  }

  if (activeIndex === -1) {
    progressValue.textContent = `Step 0 of ${totalSteps}`;
    return;
  }

  if (Number.isInteger(activeIndex)) {
    progressValue.textContent = `Step ${Math.min(activeIndex + 1, totalSteps)} of ${totalSteps}`;
    return;
  }

  const currentIndex = getCurrentMilestoneIndex(milestones);
  progressValue.textContent = `Step ${Math.min(currentIndex + 1, totalSteps)} of ${totalSteps}`;
}

function setTrackerStageLabelText(label, fallbackText = 'Status unavailable') {
  const stageLabel = document.getElementById('trackerStageLabel');
  if (!stageLabel) return;

  stageLabel.textContent = String(label || '').trim() || fallbackText;
}

function getCurrentMilestoneIndex(milestones) {
  if (!Array.isArray(milestones) || milestones.length === 0) {
    return 0;
  }

  const currentIndex = milestones.findIndex((milestone) => milestone?.state === 'current');
  if (currentIndex >= 0) {
    return currentIndex;
  }

  const lastDoneIndex = milestones.reduce((index, milestone, milestoneIndex) => (
    milestone?.state === 'done' ? milestoneIndex : index
  ), -1);

  return Math.max(0, lastDoneIndex);
}

function buildMilestoneStates(milestones, activeIndex) {
  return (milestones || []).map((milestone, milestoneIndex) => ({
    ...milestone,
    state: milestoneIndex < activeIndex
      ? 'done'
      : milestoneIndex === activeIndex
        ? 'current'
        : 'todo',
  }));
}

function normalizeAngle(angle) {
  const normalized = Number(angle) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function polarToCartesian(radius, angleDegrees) {
  const radians = (normalizeAngle(angleDegrees) * Math.PI) / 180;
  return {
    x: TRACKER_ORB_CENTER + (radius * Math.sin(radians)),
    y: TRACKER_ORB_CENTER - (radius * Math.cos(radians)),
  };
}

function describeArcPath(radius, startAngle, endAngle, sweepFlag = 1) {
  const start = polarToCartesian(radius, startAngle);
  const end = polarToCartesian(radius, endAngle);
  const delta = sweepFlag === 1
    ? normalizeAngle(endAngle - startAngle)
    : normalizeAngle(startAngle - endAngle);
  const largeArcFlag = delta > 180 ? 1 : 0;

  return [
    `M ${start.x.toFixed(3)} ${start.y.toFixed(3)}`,
    `A ${radius} ${radius} 0 ${largeArcFlag} ${sweepFlag} ${end.x.toFixed(3)} ${end.y.toFixed(3)}`,
  ].join(' ');
}

function buildSegmentGeometry(segmentCount, segmentIndex) {
  const unitAngle = 360 / segmentCount;
  const gapAngle = (TRACKER_SEGMENT_GAP / TRACKER_RING_CIRCUMFERENCE) * 360;
  const startAngle = (segmentIndex * unitAngle) + (gapAngle / 2);
  const endAngle = ((segmentIndex + 1) * unitAngle) - (gapAngle / 2);
  const segmentAngle = normalizeAngle(endAngle - startAngle);

  return {
    startAngle,
    endAngle,
    segmentAngle,
    centerAngle: normalizeAngle(startAngle + (segmentAngle / 2)),
  };
}

function shouldReverseSegmentLabel(centerAngle) {
  const normalized = normalizeAngle(centerAngle);
  return normalized > 90 && normalized < 270;
}

function formatSegmentLabel(label, segmentIndex) {
  return String(label || `Step ${segmentIndex + 1}`)
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function getDisplaySegmentLabel(label, segmentIndex) {
  const value = formatSegmentLabel(label, segmentIndex);
  return isCompactTrackerViewport()
    ? (TRACKER_SEGMENT_SHORT_LABELS[value] || value)
    : value;
}

function getSegmentLabelMetrics(displayLabel, segmentAngle) {
  const normalized = String(displayLabel || '').trim().replace(/\s+/g, ' ').toUpperCase();
  const glyphCount = normalized.replace(/\s/g, '').length || 1;
  const gapCount = Math.max(normalized.length - 1, 0);
  const availableArcLength = Math.max(28, ((segmentAngle * Math.PI) / 180) * TRACKER_RING_RADIUS - 16);
  const widthUnits = (glyphCount * 0.62) + (gapCount * 0.12);
  const maxFontSize = 8.2;
  const minFontSize = 5.7;
  const fontSize = Math.max(minFontSize, Math.min(maxFontSize, availableArcLength / Math.max(widthUnits, 1)));
  const letterSpacing = glyphCount >= 12
    ? 0.04
    : glyphCount >= 9
      ? 0.07
      : isCompactTrackerViewport()
        ? 0.1
        : 0.14;

  return {
    fontSize: Number(fontSize.toFixed(2)),
    letterSpacing: Number(letterSpacing.toFixed(2)),
  };
}

function getSegmentLabelRadius() {
  return TRACKER_RING_RADIUS;
}

function getSegmentGlyphAdvanceUnits(character) {
  if (character === ' ') return 0.38;
  if (character === '-') return 0.42;
  if ('IJ1'.includes(character)) return 0.36;
  if ('MW'.includes(character)) return 0.9;
  if ('ABCDEFGHKNOPQRSUVXYZ023456789'.includes(character)) return 0.66;
  if ('LT'.includes(character)) return 0.54;
  return 0.6;
}

function getSegmentLabelLayout(displayLabel, geometry, labelMetrics) {
  const radius = getSegmentLabelRadius();
  const characters = Array.from(String(displayLabel || ''));
  const letterSpacingPx = labelMetrics.fontSize * labelMetrics.letterSpacing;
  const direction = shouldReverseSegmentLabel(geometry.centerAngle) ? -1 : 1;
  const glyphs = [];

  let totalWidth = 0;
  characters.forEach((character, index) => {
    totalWidth += getSegmentGlyphAdvanceUnits(character) * labelMetrics.fontSize;
    if (index < characters.length - 1) {
      totalWidth += letterSpacingPx;
    }
  });

  let offsetPx = -totalWidth / 2;

  characters.forEach((character, index) => {
    const glyphWidth = getSegmentGlyphAdvanceUnits(character) * labelMetrics.fontSize;
    const centerOffsetPx = offsetPx + (glyphWidth / 2);
    const centerAngle = geometry.centerAngle + (direction * ((centerOffsetPx / radius) * (180 / Math.PI)));
    const point = polarToCartesian(radius, centerAngle);
    let rotation = normalizeAngle(centerAngle);

    if (rotation > 90 && rotation < 270) {
      rotation -= 180;
    }

    glyphs.push({
      character,
      x: Number(point.x.toFixed(3)),
      y: Number(point.y.toFixed(3)),
      rotation: Number(rotation.toFixed(3)),
      index,
    });

    offsetPx += glyphWidth + letterSpacingPx;
  });

  return glyphs;
}

function renderTrackerStepSegments(milestones, activeIndex = null) {
  const container = document.getElementById('trackerProgressSegments');
  if (!container) return;

  const resolvedMilestones = resolveMilestoneStates(milestones, activeIndex);
  const segmentCount = resolvedMilestones.length;
  if (segmentCount === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = resolvedMilestones.map((milestone, segmentIndex) => {
    const geometry = buildSegmentGeometry(segmentCount, segmentIndex);
    const state = milestone.state || 'todo';
    const isCurrent = state === 'current';
    const segmentPath = describeArcPath(TRACKER_RING_RADIUS, geometry.startAngle, geometry.endAngle, 1);
    const displayLabel = getDisplaySegmentLabel(milestone.label, segmentIndex);
    const safeLabel = escapeHtml(displayLabel);
    const labelMetrics = getSegmentLabelMetrics(displayLabel, geometry.segmentAngle);
    const glyphs = getSegmentLabelLayout(displayLabel, geometry, labelMetrics);
    const glyphMarkup = glyphs.map((glyph) => {
      if (glyph.character === ' ') {
        return '';
      }

      return `
        <text
          class="tracker-orb-segment-label"
          x="${glyph.x}"
          y="${glyph.y}"
          transform="rotate(${glyph.rotation} ${glyph.x} ${glyph.y})"
          text-anchor="middle"
          dominant-baseline="middle"
          alignment-baseline="middle"
          style="font-size:${labelMetrics.fontSize}px;"
        >${escapeHtml(glyph.character)}</text>
      `;
    }).join('');

    return `
      <g class="tracker-orb-segment-group" data-state="${state}">
        <path
          class="tracker-orb-segment"
          data-state="${state}"
          d="${segmentPath}"
        >
          <title>${safeLabel}</title>
        </path>
        ${glyphMarkup}
      </g>
    `;
  }).join('');
}

function getTrackerIntroFrames(tracker) {
  const milestones = Array.isArray(tracker?.milestones) ? tracker.milestones : [];
  const currentMilestoneIndex = getCurrentMilestoneIndex(milestones);
  const frames = [];

  for (let milestoneIndex = 0; milestoneIndex <= currentMilestoneIndex; milestoneIndex += 1) {
    frames.push({
      milestoneIndex,
      label: milestoneIndex === currentMilestoneIndex
        ? (tracker?.currentStage?.label || milestones[milestoneIndex]?.label || 'Status unavailable')
        : (milestones[milestoneIndex]?.label || 'Status unavailable'),
    });
  }

  if (frames.length === 0) {
    frames.push({
      milestoneIndex: 0,
      label: tracker?.currentStage?.label || milestones[0]?.label || 'Status unavailable',
    });
  }

  return frames;
}

function setTrackerError(message) {
  const orderNumber = document.getElementById('trackerOrderNumber');
  const stageLabel = document.getElementById('trackerStageLabel');
  const stageText = document.getElementById('trackerStageText');
  const quote = document.getElementById('trackerQuote');
  const updated = document.getElementById('trackerUpdated');
  const tips = document.getElementById('trackerTips');
  const items = document.getElementById('trackerItems');
  const timeline = document.getElementById('trackerTimeline');
  const milestones = document.getElementById('trackerMilestones');
  const card = document.getElementById('trackerStatusCard');

  if (orderNumber) orderNumber.textContent = 'Order tracker';
  if (stageLabel) stageLabel.textContent = 'No live tracker found';
  if (stageText) stageText.textContent = message || 'This tracker link is invalid or not ready yet.';
  if (quote) quote.textContent = 'The tracker lights are currently off.';
  if (updated) updated.textContent = 'This page could not load a live update.';
  if (tips) tips.innerHTML = '<li>Please check the link or try again later.</li>';
  if (items) items.innerHTML = '<p class="tracker-empty">No order details available.</p>';
  if (timeline) timeline.innerHTML = '<p class="tracker-empty">No timeline updates available.</p>';
  if (milestones) milestones.innerHTML = '';
  renderTrackerStepSegments(buildPlaceholderMilestones());
  setTrackerProgressSummary(null, null, 'Unavailable');
  if (card) card.dataset.tone = 'warn';
  trackerIntroRunId += 1;
  trackerHasPlayedIntro = false;
  document.title = 'AIRTAC Order Tracker';
}

function renderTrackerItems(items) {
  const container = document.getElementById('trackerItems');
  if (!container) return;

  if (!Array.isArray(items) || items.length === 0) {
    container.innerHTML = '<p class="tracker-empty">No line items available.</p>';
    return;
  }

  const markup = items.map((item) => {
    const subtitle = [item.variantTitle, item.sku].filter(Boolean).join(' | ');
    return `
      <article class="tracker-item">
        <div>
          <h3>${escapeHtml(item.title)}</h3>
          ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
        </div>
        <span>x${escapeHtml(item.quantity)}</span>
      </article>
    `;
  }).join('');

  container.innerHTML = markup;
}

function renderTrackerTips(tips) {
  const container = document.getElementById('trackerTips');
  if (!container) return;

  if (!Array.isArray(tips) || tips.length === 0) {
    container.innerHTML = '<li>No special tips for this order yet.</li>';
    return;
  }

  container.innerHTML = tips.map((tip) => `<li>${escapeHtml(tip)}</li>`).join('');
}

function renderTrackerTimeline(timeline) {
  const container = document.getElementById('trackerTimeline');
  if (!container) return;

  if (!Array.isArray(timeline) || timeline.length === 0) {
    container.innerHTML = '<p class="tracker-empty">No timeline updates yet.</p>';
    return;
  }

  container.innerHTML = timeline.map((event) => `
    <article class="tracker-timeline-item">
      <div class="tracker-timeline-head">
        <h3>${escapeHtml(event.title)}</h3>
        <time>${escapeHtml(formatTrackerTimestamp(event.createdAt))}</time>
      </div>
      ${event.description ? `<p>${escapeHtml(event.description)}</p>` : ''}
    </article>
  `).join('');
}

function renderTrackerMilestones(milestones, activeIndex = null) {
  const container = document.getElementById('trackerMilestones');
  if (!container) return;

  if (!Array.isArray(milestones) || milestones.length === 0) {
    container.innerHTML = '';
    return;
  }

  const resolvedMilestones = resolveMilestoneStates(milestones, activeIndex);

  container.innerHTML = resolvedMilestones.map((milestone) => `
    <div class="tracker-milestone" data-state="${milestone.state || 'todo'}">
      <span class="tracker-milestone-dot"></span>
      <span class="tracker-milestone-label">${escapeHtml(milestone.label)}</span>
    </div>
  `).join('');
}

async function playTrackerIntro(tracker) {
  if (prefersReducedMotion()) {
    renderTrackerStepSegments(tracker.milestones);
    renderTrackerMilestones(tracker.milestones);
    setTrackerStageLabelText(tracker.currentStage?.label);
    setTrackerProgressSummary(tracker.milestones);
    trackerHasPlayedIntro = true;
    return;
  }

  const runId = ++trackerIntroRunId;
  const frames = getTrackerIntroFrames(tracker);
  renderTrackerStepSegments(tracker.milestones, -1);
  renderTrackerMilestones(tracker.milestones, -1);
  setTrackerStageLabelText(frames[0]?.label || tracker.currentStage?.label);
  setTrackerProgressSummary(tracker.milestones, -1);

  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    if (runId !== trackerIntroRunId) {
      return;
    }

    const frame = frames[frameIndex];
    renderTrackerStepSegments(tracker.milestones, frame.milestoneIndex);
    renderTrackerMilestones(tracker.milestones, frame.milestoneIndex);
    setTrackerStageLabelText(frame.label);
    setTrackerProgressSummary(tracker.milestones, frame.milestoneIndex);

    const pause = frameIndex === frames.length - 1
      ? TRACKER_INTRO_FINAL_PAUSE_MS
      : TRACKER_INTRO_STEP_MS;
    await wait(pause);
  }

  if (runId !== trackerIntroRunId) {
    return;
  }

  renderTrackerStepSegments(tracker.milestones);
  renderTrackerMilestones(tracker.milestones);
  setTrackerStageLabelText(tracker.currentStage?.label);
  setTrackerProgressSummary(tracker.milestones);
  trackerHasPlayedIntro = true;
}

function renderTracker(tracker) {
  const orderNumber = document.getElementById('trackerOrderNumber');
  const stageLabel = document.getElementById('trackerStageLabel');
  const stageText = document.getElementById('trackerStageText');
  const quote = document.getElementById('trackerQuote');
  const updated = document.getElementById('trackerUpdated');
  const card = document.getElementById('trackerStatusCard');

  if (orderNumber) orderNumber.textContent = tracker.orderNumber ? `Order ${tracker.orderNumber}` : 'AIRTAC order';
  if (stageLabel) stageLabel.textContent = tracker.currentStage?.label || 'Status unavailable';
  if (stageText) stageText.textContent = tracker.currentStage?.description || '';
  if (quote) quote.textContent = tracker.quote || 'Workshop update incoming.';
  if (updated) {
    const updatedText = formatTrackerTimestamp(tracker.updatedAt);
    updated.textContent = updatedText ? `Last updated ${updatedText}` : 'Waiting for live workshop updates.';
  }

  if (card) card.dataset.tone = tracker.currentStage?.tone || 'info';
  document.title = `${tracker.currentStage?.label || 'Order Tracker'} | ${tracker.orderNumber || 'AIRTAC'}`;

  renderTrackerTips(tracker.tips);
  renderTrackerItems(tracker.items);
  renderTrackerTimeline(tracker.timeline);

  if (!trackerHasPlayedIntro) {
    playTrackerIntro(tracker).catch(() => {
      renderTrackerStepSegments(tracker.milestones);
      renderTrackerMilestones(tracker.milestones);
      setTrackerStageLabelText(tracker.currentStage?.label);
      setTrackerProgressSummary(tracker.milestones);
      trackerHasPlayedIntro = true;
    });
    return;
  }

  renderTrackerStepSegments(tracker.milestones);
  renderTrackerMilestones(tracker.milestones);
  setTrackerProgressSummary(tracker.milestones);
}

async function loadTracker() {
  const token = getTrackerToken();
  if (!token) {
    setTrackerError('Missing tracker token.');
    return;
  }

  try {
    const response = await fetch(`/api/order-tracker/${encodeURIComponent(token)}`, {
      headers: { 'Accept': 'application/json' },
    });
    const data = await response.json();

    if (!response.ok || !data.success || !data.tracker) {
      throw new Error(data.error || 'Tracker unavailable');
    }

    renderTracker(data.tracker);
  } catch (err) {
    setTrackerError(err.message || 'Tracker unavailable');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderTrackerStepSegments(buildPlaceholderMilestones());
  setTrackerProgressSummary(null, -1);
  loadTracker();

  if (trackerPollId) {
    clearInterval(trackerPollId);
  }

  trackerPollId = setInterval(loadTracker, TRACKER_POLL_MS);
});
