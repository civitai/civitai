/**
 * Reports when two media elements are audible at once. Diagnostic only: image detail videos are
 * sometimes heard twice, and it has not been reproduced in a test browser. Remove it once the
 * cause is named.
 *
 * Elements are found through `play()` and the `play` event rather than the DOM, so one that left
 * the document while still playing is still seen.
 */

export type MediaOverlapElement = {
  connected: boolean;
  /** The media uuid from the CDN URL; not the image id, which the element does not carry. */
  media: string | null;
  tag: 'video' | 'audio';
  paused: boolean;
  muted: boolean;
  volume: number;
  currentTime: number;
  duration: number | null;
  readyState: number;
  controls: boolean;
  autoplay: boolean;
  inDialog: boolean;
  fullscreen: boolean;
};

export type MediaOverlapReport = {
  overlapMs: number;
  elements: MediaOverlapElement[];
  pathnames: string[];
  visibility: string;
  userAgent: string;
};

type Options = {
  report: (report: MediaOverlapReport) => void;
  overlapMs?: number;
  /** Per tab. */
  cooldownMs?: number;
  maxTracked?: number;
  sampleMs?: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mediaUuid(el: HTMLMediaElement) {
  const src = el.currentSrc || el.src;
  if (!src) return null;
  try {
    return new URL(src, location.href).pathname.split('/').find((part) => UUID.test(part)) ?? null;
  } catch {
    return null;
  }
}

function describe(el: HTMLMediaElement): MediaOverlapElement {
  const fullscreenElement = document.fullscreenElement;
  return {
    connected: el.isConnected,
    media: mediaUuid(el),
    tag: el instanceof HTMLVideoElement ? 'video' : 'audio',
    paused: el.paused,
    muted: el.muted,
    volume: el.volume,
    currentTime: Math.round(el.currentTime * 10) / 10,
    duration: Number.isFinite(el.duration) ? Math.round(el.duration * 10) / 10 : null,
    readyState: el.readyState,
    controls: el.controls,
    autoplay: el.autoplay,
    inDialog: !!el.closest('[role="dialog"]'),
    fullscreen: !!fullscreenElement && (fullscreenElement === el || fullscreenElement.contains(el)),
  };
}

const isAudible = (el: HTMLMediaElement) => !el.paused && !el.ended && !el.muted && el.volume > 0;

export function installMediaOverlapDetector({
  report,
  overlapMs = 750,
  cooldownMs = 5 * 60_000,
  maxTracked = 64,
  sampleMs = 100,
}: Options) {
  const tracked: WeakRef<HTMLMediaElement>[] = [];
  const pathnames: string[] = [];
  let overlapSince: number | null = null;
  let lastReportAt = -Infinity;
  let timer: ReturnType<typeof setInterval> | undefined;

  const notePath = () => {
    const path = location.pathname;
    if (pathnames[pathnames.length - 1] !== path) pathnames.push(path);
    if (pathnames.length > 5) pathnames.shift();
  };

  const live = () => {
    const elements: HTMLMediaElement[] = [];
    for (let i = tracked.length - 1; i >= 0; i--) {
      const el = tracked[i].deref();
      if (el) elements.push(el);
      else tracked.splice(i, 1);
    }
    return elements;
  };

  const sample = () => {
    notePath();
    const elements = live();
    const audible = elements.filter(isAudible);
    if (!elements.some((el) => !el.paused)) {
      clearInterval(timer);
      timer = undefined;
    }
    if (audible.length < 2) {
      overlapSince = null;
      return;
    }
    const now = performance.now();
    overlapSince ??= now;
    if (now - overlapSince < overlapMs || now - lastReportAt < cooldownMs) return;
    lastReportAt = now;
    // Within the route's limits, or the whole report is rejected.
    report({
      overlapMs: Math.min(Math.round(now - overlapSince), 3_600_000),
      elements: audible.slice(0, 16).map(describe),
      pathnames: [...pathnames],
      visibility: document.visibilityState,
      userAgent: navigator.userAgent.slice(0, 512),
    });
  };

  const track = (el: HTMLMediaElement) => {
    if (!tracked.some((ref) => ref.deref() === el)) {
      tracked.push(new WeakRef(el));
      if (tracked.length > maxTracked) {
        // A paused one goes first: the oldest may be the stray still playing. Not the one being
        // added, which is still paused until play() runs.
        const paused = tracked.findIndex(
          (ref, i) => i < tracked.length - 1 && (ref.deref()?.paused ?? true)
        );
        tracked.splice(paused === -1 ? 0 : paused, 1);
      }
    }
    notePath();
    timer ??= setInterval(sample, sampleMs);
  };

  const originalPlay = HTMLMediaElement.prototype.play;
  // Returns play()'s own result, rejection included: the detector must not change playback.
  const wrappedPlay = function (this: HTMLMediaElement) {
    try {
      track(this);
    } catch {
      // never at the cost of playback
    }
    return originalPlay.call(this);
  };
  HTMLMediaElement.prototype.play = wrappedPlay;
  // The `autoplay` attribute starts playback without a play() call; `play` doesn't bubble.
  const onPlay = (event: Event) => {
    if (event.target instanceof HTMLMediaElement) track(event.target);
  };
  document.addEventListener('play', onPlay, true);

  return () => {
    // Not over a wrapper someone installed after this one.
    if (HTMLMediaElement.prototype.play === wrappedPlay)
      HTMLMediaElement.prototype.play = originalPlay;
    document.removeEventListener('play', onPlay, true);
    clearInterval(timer);
  };
}
