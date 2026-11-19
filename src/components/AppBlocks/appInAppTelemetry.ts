/**
 * App Blocks IN-APP telemetry, from the two block hosts (PageBlockHost, IframeHost):
 *
 *   - `App_Error` — a submit the viewer saw fail AFTER the app loaded. The render beacon grades
 *     only the launch, so before this an app whose every submit failed read as healthy.
 *   - `App_Session` — one row per host session, sent on unmount or `pagehide`: visible time,
 *     submits, and bridge messages the block sent the host. The first engagement measure apps have.
 *
 * Both ride the shared `/api/track/batch` transport. A session is flushed with `sendBeacon`
 * (`flushTrackEvents(true)`) the moment it ends, so it survives the navigation that ended it
 * regardless of which `pagehide` listener the browser runs first.
 *
 * Nothing here carries app or user content: the reason is derived from the error by a closed
 * classifier, the numbers are clamped integers, and the app id is shape-checked.
 *
 * FIRE-AND-FORGET: every export is total. Telemetry must never change what the host replies.
 */
import { useCallback, useEffect, useRef } from 'react';
import { enqueueTrackEvent, flushTrackEvents } from '~/components/TrackView/trackEventBuffer';
import {
  APP_SESSION_MAX_COUNT,
  APP_SESSION_MAX_DURATION_MS,
  APP_TELEMETRY_APP_BLOCK_ID_RE,
  appSubmitFailureFromError,
  appSubmitFailureFromResult,
  clampTelemetryInt,
  type AppErrorStage,
  type AppSessionHost,
  type AppSubmitFailureReason,
} from '~/shared/constants/app-telemetry.constants';

function isTrackableAppId(appBlockId: string): boolean {
  return APP_TELEMETRY_APP_BLOCK_ID_RE.test(appBlockId);
}

/** Queue one `App_Error`. Total. */
export function reportAppError(
  appBlockId: string,
  stage: AppErrorStage,
  reason: AppSubmitFailureReason
): void {
  if (!isTrackableAppId(appBlockId)) return;
  try {
    enqueueTrackEvent({
      kind: 'action',
      data: { type: 'App_Error', details: { appBlockId, reason, stage } },
    });
  } catch {
    /* instrument-only */
  }
}

/** A submit that THREW: always an error the viewer sees. */
export function reportAppSubmitError(appBlockId: string, stage: AppErrorStage, err: unknown): void {
  reportAppError(appBlockId, stage, appSubmitFailureFromError(err));
}

/**
 * A submit that RESOLVED: an error only when the server returned a failed snapshot (the per-call
 * budget and workflow-ceiling refusals are returned, not thrown).
 */
export function reportAppSubmitResult(
  appBlockId: string,
  stage: AppErrorStage,
  result: unknown
): void {
  const reason = appSubmitFailureFromResult(result);
  if (reason) reportAppError(appBlockId, stage, reason);
}

export type AppSessionDetails = {
  appBlockId: string;
  host: AppSessionHost;
  durationMs: number;
  submits: number;
  messagesToHost: number;
};

export type AppSessionTracker = {
  setVisible(visible: boolean): void;
  countSubmit(): void;
  countMessage(): void;
  /**
   * End the session and return its row, or `null` when it already ended or recorded nothing
   * (no visible time and no messages — e.g. a mount torn down before it was ever shown).
   */
  end(): AppSessionDetails | null;
};

/**
 * Pure session accounting. `durationMs` is VISIBLE time only: time the document was hidden is not
 * a session, and counting it would make an abandoned background tab the most engaged viewer.
 */
export function createAppSessionTracker(opts: {
  appBlockId: string;
  host: AppSessionHost;
  visible: boolean;
  now?: () => number;
}): AppSessionTracker {
  const now = opts.now ?? (() => Date.now());
  let visibleSince: number | null = opts.visible ? now() : null;
  let accumulated = 0;
  let submits = 0;
  let messages = 0;
  let ended = false;

  const closeInterval = () => {
    if (visibleSince === null) return;
    accumulated += Math.max(0, now() - visibleSince);
    visibleSince = null;
  };

  return {
    setVisible(visible) {
      if (ended) return;
      if (visible) {
        if (visibleSince === null) visibleSince = now();
      } else {
        closeInterval();
      }
    },
    countSubmit() {
      if (!ended) submits += 1;
    },
    countMessage() {
      if (!ended) messages += 1;
    },
    end() {
      if (ended) return null;
      closeInterval();
      ended = true;
      const durationMs = clampTelemetryInt(accumulated, APP_SESSION_MAX_DURATION_MS);
      const messagesToHost = clampTelemetryInt(messages, APP_SESSION_MAX_COUNT);
      if (durationMs === 0 && messagesToHost === 0) return null;
      return {
        appBlockId: opts.appBlockId,
        host: opts.host,
        durationMs,
        submits: clampTelemetryInt(submits, APP_SESSION_MAX_COUNT),
        messagesToHost,
      };
    },
  };
}

/** Queue one `App_Session` and send it now, by beacon. Total. */
export function sendAppSession(details: AppSessionDetails): void {
  if (!isTrackableAppId(details.appBlockId)) return;
  try {
    enqueueTrackEvent({ kind: 'action', data: { type: 'App_Session', details } });
    flushTrackEvents(true);
  } catch {
    /* instrument-only */
  }
}

function documentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * One `App_Session` per host session: from mount (or a back/forward-cache restore) to unmount or
 * `pagehide`. Returns stable counters for the host to call. `enabled: false` (a moderator review
 * mount, whose app id is synthetic) records nothing.
 */
export function useAppSessionTelemetry(opts: {
  appBlockId: string;
  host: AppSessionHost;
  enabled: boolean;
}): { countSubmit: () => void; countMessage: () => void } {
  const { appBlockId, host, enabled } = opts;
  const trackerRef = useRef<AppSessionTracker | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const start = () => {
      trackerRef.current = createAppSessionTracker({
        appBlockId,
        host,
        visible: documentVisible(),
      });
    };
    const finish = () => {
      const tracker = trackerRef.current;
      trackerRef.current = null;
      const details = tracker?.end();
      if (details) sendAppSession(details);
    };
    const onVisibility = () => trackerRef.current?.setVisible(documentVisible());
    // A page restored from the back/forward cache is a new visit; its previous session already
    // ended on the `pagehide` that froze it.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && !trackerRef.current) start();
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', finish);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', finish);
      window.removeEventListener('pageshow', onPageShow);
      finish();
    };
  }, [appBlockId, host, enabled]);

  const countSubmit = useCallback(() => trackerRef.current?.countSubmit(), []);
  const countMessage = useCallback(() => trackerRef.current?.countMessage(), []);
  return { countSubmit, countMessage };
}
