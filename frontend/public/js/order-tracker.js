const TRACKER_POLL_MS = 15000;
const TRACKER_INTRO_STEP_MS = 520;
const TRACKER_INTRO_FINAL_PAUSE_MS = 180;
const TRACKER_WAKEUP_START_DELAY_MS = 140;
const TRACKER_WAKEUP_DURATION_MS = 980;
const TRACKER_TERMINAL_BOOT_PAUSE_MS = 140;
const TRACKER_TERMINAL_INTRO_HOLD_MS = 2200;
const TRACKER_TERMINAL_CHAR_MS = 14;
const TRACKER_IDLE_FACT_DELAY_MS = 18000;
const TRACKER_IDLE_FACT_INTERVAL_MS = 14000;
const TRACKER_REGGIE_SPAM_WINDOW_MS = 1400;
const TRACKER_REGGIE_SPAM_THRESHOLD = 2;
const TRACKER_REGGIE_MAD_DURATION_MS = 3600;
const TRACKER_DEFAULT_STEP_COUNT = 5;
const TRACKER_SEGMENT_GAP = 5;
const TRACKER_ORB_CENTER = 120;
const TRACKER_SEGMENT_SHORT_LABELS = {
  'ORDER PLACED': 'ORDERED',
  'IN WORKSHOP': 'WORKSHOP',
  'QUALITY CHECK': 'QC',
  'PACKED': 'PACKED',
  'COMPLETE': 'DONE',
  'FULFILLED': 'FULFILLED',
  'PART FULFILLED': 'PARTIAL',
  'CANCELLED': 'CANCELLED',
};
const TRACKER_IDLE_FACTS = [
  'Buying a new sidearm is always faster than reloading',
  'Wind only affects your opponents shots.',
  'If you think you\'ve hit someone, stop playing and immediately tell a marshal. You\'ll feel SO much better',
];
const TRACKER_REGGIE_MAD_MESSAGES = [
  'OI. EASY ON THE TAPPING.',
  'PLEASE STOP POKING THE REGULATOR.',
  'THAT IS QUITE ENOUGH CLICKING.',
  'I AM TRYING TO MAINTAIN PROFESSIONAL COMPOSURE.',
];
let trackerPollId = null;
let trackerHasPlayedIntro = false;
let trackerIntroRunId = 0;
let trackerAudioContext = null;
let trackerPendingCue = null;
let trackerLastRenderedStageKey = '';
let trackerLastStatusStageKey = '';
let trackerLastStatusMessage = '';
let trackerLastTerminalText = '';
let trackerTerminalRunId = 0;
let trackerIdleFactTimerId = null;
let trackerIdleFactContextKey = '';
let trackerIdleFactQueue = [];
let trackerReggieClickTimes = [];
let trackerReggieMadTimerId = null;
let trackerHasScheduledWakeUp = false;
let trackerWakeUpTimerIds = [];
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

function clearTrackerWakeUpTimers() {
  trackerWakeUpTimerIds.forEach((timerId) => {
    window.clearTimeout(timerId);
  });
  trackerWakeUpTimerIds = [];
}

function setTrackerWakeState(state) {
  const card = document.getElementById('trackerStatusCard');
  if (!card) return;

  card.dataset.awake = state;
}

function scheduleTrackerWakeUp() {
  if (trackerHasScheduledWakeUp) {
    setTrackerWakeState('awake');
    return;
  }

  trackerHasScheduledWakeUp = true;
  clearTrackerWakeUpTimers();

  if (prefersReducedMotion()) {
    setTrackerWakeState('awake');
    return;
  }

  setTrackerWakeState('sleeping');

  trackerWakeUpTimerIds.push(window.setTimeout(() => {
    setTrackerWakeState('waking');
  }, TRACKER_WAKEUP_START_DELAY_MS));

  trackerWakeUpTimerIds.push(window.setTimeout(() => {
    setTrackerWakeState('awake');
    clearTrackerWakeUpTimers();
  }, TRACKER_WAKEUP_START_DELAY_MS + TRACKER_WAKEUP_DURATION_MS));
}

function getTrackerAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;

  if (!trackerAudioContext) {
    trackerAudioContext = new AudioCtx();
  }

  return trackerAudioContext;
}

async function resumeTrackerAudioContext() {
  const ctx = getTrackerAudioContext();
  if (!ctx) return null;

  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch (err) {
      return null;
    }
  }

  return ctx.state === 'running' ? ctx : null;
}

function playTrackerTone(ctx, options = {}) {
  const {
    startOffset = 0,
    frequency = 520,
    endFrequency = frequency,
    duration = 0.1,
    gain = 0.018,
    type = 'triangle',
  } = options;

  const oscillator = ctx.createOscillator();
  const volume = ctx.createGain();
  const startAt = ctx.currentTime + startOffset;
  const endAt = startAt + duration;

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(Math.max(1, frequency), startAt);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), endAt);

  volume.gain.setValueAtTime(Math.max(0.0001, gain), startAt);
  volume.gain.exponentialRampToValueAtTime(0.0001, endAt);

  oscillator.connect(volume).connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(endAt);
}

function playTrackerStartupCue(ctx) {
  playTrackerTone(ctx, {
    startOffset: 0,
    frequency: 420,
    endFrequency: 560,
    duration: 0.09,
    gain: 0.018,
    type: 'triangle',
  });
  playTrackerTone(ctx, {
    startOffset: 0.11,
    frequency: 560,
    endFrequency: 710,
    duration: 0.09,
    gain: 0.018,
    type: 'triangle',
  });
  playTrackerTone(ctx, {
    startOffset: 0.22,
    frequency: 710,
    endFrequency: 920,
    duration: 0.12,
    gain: 0.02,
    type: 'sine',
  });
}

function playTrackerStageChangeCue(ctx, stageKey) {
  switch (String(stageKey || '').trim()) {
    case 'awaiting_parts':
      playTrackerTone(ctx, {
        startOffset: 0,
        frequency: 480,
        endFrequency: 560,
        duration: 0.11,
        gain: 0.018,
        type: 'triangle',
      });
      playTrackerTone(ctx, {
        startOffset: 0.16,
        frequency: 540,
        endFrequency: 470,
        duration: 0.14,
        gain: 0.017,
        type: 'triangle',
      });
      return;
    case 'quality_check':
      playTrackerTone(ctx, {
        startOffset: 0,
        frequency: 760,
        endFrequency: 860,
        duration: 0.08,
        gain: 0.017,
        type: 'sine',
      });
      playTrackerTone(ctx, {
        startOffset: 0.1,
        frequency: 860,
        endFrequency: 940,
        duration: 0.08,
        gain: 0.015,
        type: 'sine',
      });
      return;
    case 'passed_qc':
    case 'packaged':
    case 'fulfilled':
      playTrackerTone(ctx, {
        startOffset: 0,
        frequency: 620,
        endFrequency: 780,
        duration: 0.08,
        gain: 0.018,
        type: 'triangle',
      });
      playTrackerTone(ctx, {
        startOffset: 0.1,
        frequency: 780,
        endFrequency: 980,
        duration: 0.1,
        gain: 0.018,
        type: 'triangle',
      });
      return;
    case 'cancelled':
    case 'on_hold':
      playTrackerTone(ctx, {
        startOffset: 0,
        frequency: 420,
        endFrequency: 300,
        duration: 0.14,
        gain: 0.018,
        type: 'sawtooth',
      });
      return;
    default:
      playTrackerTone(ctx, {
        startOffset: 0,
        frequency: 520,
        endFrequency: 680,
        duration: 0.09,
        gain: 0.017,
        type: 'triangle',
      });
      playTrackerTone(ctx, {
        startOffset: 0.1,
        frequency: 680,
        endFrequency: 760,
        duration: 0.08,
        gain: 0.015,
        type: 'triangle',
      });
  }
}

function triggerTrackerCue(cue) {
  const ctx = getTrackerAudioContext();
  if (!ctx) return;

  if (ctx.state !== 'running') {
    trackerPendingCue = cue;
    return;
  }

  if (cue?.type === 'startup') {
    playTrackerStartupCue(ctx);
    return;
  }

  playTrackerStageChangeCue(ctx, cue?.stageKey);
}

async function flushTrackerPendingCue() {
  if (!trackerPendingCue) return;

  const ctx = await resumeTrackerAudioContext();
  if (!ctx) return;

  const nextCue = trackerPendingCue;
  trackerPendingCue = null;

  if (nextCue?.type === 'startup') {
    playTrackerStartupCue(ctx);
    return;
  }

  playTrackerStageChangeCue(ctx, nextCue?.stageKey);
}

function installTrackerAudioUnlock() {
  const unlockAudio = () => {
    flushTrackerPendingCue().catch(() => {});
  };

  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  document.addEventListener('keydown', unlockAudio);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      unlockAudio();
    }
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

function getTrackerTerminalMessage(message, fallbackText = 'Workshop update incoming.') {
  const normalized = String(message || '').trim();
  return normalized || fallbackText;
}

function getTrackerIntroductionMessage() {
  return 'HELLO. I AM REGGIE THE REG.';
}

function setTrackerReggieMood(mood = '') {
  const card = document.getElementById('trackerStatusCard');
  if (!card) return;

  if (mood) {
    card.dataset.mood = mood;
    return;
  }

  delete card.dataset.mood;
}

function clearTrackerReggieMadTimer() {
  if (trackerReggieMadTimerId) {
    window.clearTimeout(trackerReggieMadTimerId);
    trackerReggieMadTimerId = null;
  }
}

function getTrackerReggieMadMessage() {
  if (!TRACKER_REGGIE_MAD_MESSAGES.length) {
    return 'PLEASE STOP POKING THE REGULATOR.';
  }

  const index = Math.floor(Math.random() * TRACKER_REGGIE_MAD_MESSAGES.length);
  return TRACKER_REGGIE_MAD_MESSAGES[index];
}

function clearTrackerIdleFactTimer() {
  if (trackerIdleFactTimerId) {
    window.clearTimeout(trackerIdleFactTimerId);
    trackerIdleFactTimerId = null;
  }
}

function restoreTrackerStatusMessage() {
  const restoreMessage = trackerLastStatusMessage || 'Workshop update incoming.';

  setTrackerTerminalText(restoreMessage, {
    forceAnimate: true,
    fallbackText: restoreMessage,
  }).then((completed) => {
    if (completed && trackerLastStatusStageKey && trackerLastStatusStageKey !== 'error') {
      scheduleTrackerIdleFactCycle(trackerLastStatusStageKey, restoreMessage);
    }
  }).catch(() => {});
}

function shuffleTrackerIdleFacts(facts) {
  const nextFacts = Array.from(facts || []);
  for (let index = nextFacts.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [nextFacts[index], nextFacts[randomIndex]] = [nextFacts[randomIndex], nextFacts[index]];
  }
  return nextFacts;
}

function getNextTrackerIdleFact() {
  if (!TRACKER_IDLE_FACTS.length) {
    return '';
  }

  if (trackerIdleFactQueue.length === 0) {
    trackerIdleFactQueue = shuffleTrackerIdleFacts(TRACKER_IDLE_FACTS);
  }

  return trackerIdleFactQueue.shift() || '';
}

async function runTrackerIdleFactCycle(contextKey) {
  if (!contextKey || contextKey !== trackerIdleFactContextKey) {
    return;
  }

  const fact = getNextTrackerIdleFact();
  if (!fact) {
    return;
  }

  const completed = await setTrackerTerminalText(`AIRSOFT FACT: ${fact}`, {
    forceAnimate: true,
    fallbackText: fact,
  });

  if (!completed || contextKey !== trackerIdleFactContextKey) {
    return;
  }

  trackerIdleFactTimerId = window.setTimeout(() => {
    runTrackerIdleFactCycle(contextKey).catch(() => {});
  }, TRACKER_IDLE_FACT_INTERVAL_MS);
}

function scheduleTrackerIdleFactCycle(stageKey, statusMessage) {
  clearTrackerIdleFactTimer();
  trackerIdleFactContextKey = '';

  const normalizedStageKey = String(stageKey || '').trim();
  const normalizedMessage = String(statusMessage || '').trim();
  if (!normalizedStageKey || !normalizedMessage) {
    return;
  }

  const contextKey = `${normalizedStageKey}::${normalizedMessage}`;
  trackerIdleFactContextKey = contextKey;
  trackerIdleFactTimerId = window.setTimeout(() => {
    runTrackerIdleFactCycle(contextKey).catch(() => {});
  }, TRACKER_IDLE_FACT_DELAY_MS);
}

function triggerTrackerReggieMad() {
  trackerReggieClickTimes = [];
  clearTrackerReggieMadTimer();
  clearTrackerIdleFactTimer();
  trackerIdleFactContextKey = '';
  setTrackerReggieMood('mad');

  const madMessage = getTrackerReggieMadMessage();
  setTrackerTerminalText(madMessage, {
    forceAnimate: true,
    fallbackText: madMessage,
  }).catch(() => {});

  trackerReggieMadTimerId = window.setTimeout(() => {
    trackerReggieMadTimerId = null;
    setTrackerReggieMood('');
    restoreTrackerStatusMessage();
  }, TRACKER_REGGIE_MAD_DURATION_MS);
}

function handleTrackerReggieClick() {
  const now = Date.now();
  trackerReggieClickTimes = trackerReggieClickTimes.filter(
    (timestamp) => now - timestamp <= TRACKER_REGGIE_SPAM_WINDOW_MS,
  );
  trackerReggieClickTimes.push(now);

  if (trackerReggieClickTimes.length >= TRACKER_REGGIE_SPAM_THRESHOLD) {
    triggerTrackerReggieMad();
  }
}

function installTrackerReggieInteraction() {
  const orb = document.querySelector('.tracker-orb');
  if (!orb) return;

  orb.addEventListener('click', handleTrackerReggieClick);
}

async function setTrackerTerminalText(message, options = {}) {
  const {
    forceAnimate = false,
    fallbackText = 'Workshop update incoming.',
    introMessage = '',
    introHoldMs = TRACKER_TERMINAL_INTRO_HOLD_MS,
  } = options;

  const terminalText = document.getElementById('trackerStageText');
  const card = document.getElementById('trackerStatusCard');
  if (!terminalText) return;

  const nextText = getTrackerTerminalMessage(message, fallbackText);
  const introText = String(introMessage || '').trim();
  const shouldAnimate = forceAnimate || nextText !== trackerLastTerminalText;
  const runId = ++trackerTerminalRunId;

  trackerLastTerminalText = nextText;

  if (card) {
    card.dataset.terminalState = shouldAnimate ? 'typing' : 'idle';
  }

  if (!shouldAnimate || prefersReducedMotion()) {
    terminalText.textContent = nextText;
    if (card) {
      card.dataset.terminalState = 'idle';
    }
    return true;
  }

  const typeTerminalLine = async (text, includeBootPause = true) => {
    terminalText.textContent = '';

    if (includeBootPause) {
      await wait(TRACKER_TERMINAL_BOOT_PAUSE_MS);
      if (runId !== trackerTerminalRunId) {
        return false;
      }
    }

    for (let index = 0; index < text.length; index += 1) {
      if (runId !== trackerTerminalRunId) {
        return false;
      }

      terminalText.textContent = text.slice(0, index + 1);
      const charDelay = /[,:.;!?]/.test(text[index])
        ? TRACKER_TERMINAL_CHAR_MS * 2
        : TRACKER_TERMINAL_CHAR_MS;
      await wait(charDelay);
    }

    return runId === trackerTerminalRunId;
  };

  if (introText) {
    const introCompleted = await typeTerminalLine(introText, true);
    if (!introCompleted) {
      return false;
    }

    await wait(introHoldMs);
    if (runId !== trackerTerminalRunId) {
      return false;
    }
  }

  const finalCompleted = await typeTerminalLine(nextText, !introText);
  if (!finalCompleted) {
    return false;
  }

  if (runId !== trackerTerminalRunId) {
    return false;
  }

  if (card) {
    card.dataset.terminalState = 'idle';
  }

  return true;
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
    ? 0.07
    : glyphCount >= 9
      ? 0.1
      : isCompactTrackerViewport()
        ? 0.13
        : 0.17;

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
  const shouldFlipGlyphs = shouldReverseSegmentLabel(geometry.centerAngle);
  const direction = shouldFlipGlyphs ? -1 : 1;
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
    const rotation = shouldFlipGlyphs
      ? centerAngle - 180
      : centerAngle;

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
  const updated = document.getElementById('trackerUpdated');
  const tips = document.getElementById('trackerTips');
  const items = document.getElementById('trackerItems');
  const timeline = document.getElementById('trackerTimeline');
  const trackingLinks = document.getElementById('trackerTrackingLinks');
  const milestones = document.getElementById('trackerMilestones');
  const card = document.getElementById('trackerStatusCard');
  const fallbackMessage = message || 'This tracker link is invalid or not ready yet.';

  clearTrackerIdleFactTimer();
  clearTrackerReggieMadTimer();
  trackerReggieClickTimes = [];
  setTrackerReggieMood('');
  trackerIdleFactContextKey = '';
  trackerLastStatusStageKey = 'error';
  trackerLastStatusMessage = fallbackMessage;

  if (orderNumber) orderNumber.textContent = 'Order tracker';
  if (stageLabel) stageLabel.textContent = 'No live tracker found';
  setTrackerTerminalText(fallbackMessage, {
    forceAnimate: true,
    fallbackText: fallbackMessage,
    introMessage: getTrackerIntroductionMessage(),
  }).catch(() => {});
  if (updated) updated.textContent = 'This page could not load a live update.';
  if (tips) tips.innerHTML = '<li>Please check the link or try again later.</li>';
  if (items) items.innerHTML = '<p class="tracker-empty">No order details available.</p>';
  if (timeline) timeline.innerHTML = '<p class="tracker-empty">No timeline updates available.</p>';
  if (trackingLinks) {
    trackingLinks.hidden = true;
    trackingLinks.innerHTML = '';
  }
  if (milestones) milestones.innerHTML = '';
  renderTrackerStepSegments(buildPlaceholderMilestones());
  setTrackerProgressSummary(null, null, 'Unavailable');
  if (card) {
    card.dataset.tone = 'warn';
    card.dataset.stageKey = 'error';
  }
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

function renderTrackerTrackingLinks(trackingLinks) {
  const container = document.getElementById('trackerTrackingLinks');
  if (!container) return;

  const safeLinks = Array.isArray(trackingLinks)
    ? trackingLinks.filter((trackingLink) => trackingLink?.url)
    : [];

  if (safeLinks.length === 0) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }

  container.hidden = false;
  container.innerHTML = safeLinks.map((trackingLink, index) => {
    const parts = [
      String(trackingLink.company || '').trim(),
      String(trackingLink.number || '').trim(),
    ].filter(Boolean);
    const label = parts.join(' ') || `Track shipment ${index + 1}`;

    return `
      <a
        class="tracker-tracking-link"
        href="${escapeHtml(trackingLink.url)}"
        target="_blank"
        rel="noopener noreferrer"
      >${escapeHtml(label)}</a>
    `;
  }).join('');
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
  const updated = document.getElementById('trackerUpdated');
  const card = document.getElementById('trackerStatusCard');
  const nextStageKey = String(tracker?.currentStage?.key || '').trim();
  const previousStageKey = trackerLastRenderedStageKey;
  const nextStatusMessage = getTrackerTerminalMessage(tracker.currentStage?.description);
  const statusChanged = nextStageKey !== trackerLastStatusStageKey
    || nextStatusMessage !== trackerLastStatusMessage;

  if (!previousStageKey && nextStageKey) {
    triggerTrackerCue({ type: 'startup', stageKey: nextStageKey });
  } else if (previousStageKey && nextStageKey && previousStageKey !== nextStageKey) {
    triggerTrackerCue({ type: 'stage_change', stageKey: nextStageKey });
  }

  trackerLastRenderedStageKey = nextStageKey;

  if (orderNumber) orderNumber.textContent = tracker.orderNumber ? `Order ${tracker.orderNumber}` : 'AIRTAC order';
  if (stageLabel) stageLabel.textContent = tracker.currentStage?.label || 'Status unavailable';
  if (statusChanged) {
    clearTrackerReggieMadTimer();
    trackerReggieClickTimes = [];
    setTrackerReggieMood('');
    clearTrackerIdleFactTimer();
    trackerIdleFactContextKey = '';
    trackerLastStatusStageKey = nextStageKey;
    trackerLastStatusMessage = nextStatusMessage;

    setTrackerTerminalText(nextStatusMessage, {
      forceAnimate: !previousStageKey,
      introMessage: !previousStageKey ? getTrackerIntroductionMessage() : '',
    }).then((completed) => {
      if (completed) {
        scheduleTrackerIdleFactCycle(nextStageKey, nextStatusMessage);
      }
    }).catch(() => {});
  }
  if (updated) {
    const updatedText = formatTrackerTimestamp(tracker.updatedAt);
    updated.textContent = updatedText ? `Last updated ${updatedText}` : 'Waiting for live workshop updates.';
  }

  if (card) {
    card.dataset.tone = tracker.currentStage?.tone || 'info';
    card.dataset.stageKey = tracker.currentStage?.key || 'unknown';
  }
  document.title = `${tracker.currentStage?.label || 'Order Tracker'} | ${tracker.orderNumber || 'AIRTAC'}`;

  renderTrackerTips(tracker.tips);
  renderTrackerTrackingLinks(tracker.trackingLinks);
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
  installTrackerAudioUnlock();
  installTrackerReggieInteraction();
  scheduleTrackerWakeUp();
  loadTracker();

  if (trackerPollId) {
    clearInterval(trackerPollId);
  }

  trackerPollId = setInterval(loadTracker, TRACKER_POLL_MS);
});
