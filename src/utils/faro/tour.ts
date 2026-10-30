import { faro } from '@grafana/faro-web-sdk';
import type { TourKey } from '~/components/Tours/tours';

/**
 * Telemetry for the guided tours (`src/components/Tours`).
 *
 * WHY EVENTS AND NOT SPANS: browser-trace sampling only covers ~10% of sessions (see
 * FaroProvider's SAMPLING doc); a tour funnel is a counting problem a 10%-sampled span
 * can't answer. Where a span would have given duration, `waitMs` carries it.
 *
 * WHY NO PER-EMIT SAMPLING, unlike `feedDrop`: these fire per tour START, not per feed
 * render, and a tour starts at most once per user per key. `sampleRate: '1'` rides along
 * anyway so a LogQL query that scales by it works across every Faro event this repo emits.
 *
 * WHERE TO WATCH IT — Faro `pushEvent` lands in Loki as `kind=event` with `event_name=` +
 * `event_data_*`. Completion rate by tour and outcome:
 *
 *   sum by (event_data_key, event_data_reason) (
 *     count_over_time({service_name="civitai-dp-prod", source="faro-rum"}
 *       |= `kind=event` |= `tour_end` [$__auto])
 *   )
 *
 * Steps whose target was absent — a dead `data-tour` attribute, or one behind a runtime
 * condition this population never satisfies:
 *
 *   sum by (event_data_key, event_data_target) (
 *     count_over_time({service_name="civitai-dp-prod", source="faro-rum"}
 *       |= `kind=event` |= `tour_step` |= `resolved=false` [$__auto])
 *   )
 *
 * 🔴 A `tour_end` with `reason=finished` preceded by a run of `resolved=false` steps is a
 * BROKEN tour, not a completed one — a failed tour is still persisted as completed, by
 * design. Any completion-rate panel built on `tour_end` alone reports those as successes.
 */

export type TourEndReason = 'finished' | 'skipped' | 'closed';
export type TourTrigger = 'auto' | 'url' | 'help';

export const TOUR_START_EVENT = 'tour_start';
export const TOUR_STEP_EVENT = 'tour_step';
export const TOUR_END_EVENT = 'tour_end';

export interface TourStartSignal {
  key: TourKey;
  trigger: TourTrigger;
  /** Step count AFTER any `setSteps` filtering, so a conditionally-cut tour stays comparable. */
  stepCount: number;
}

export interface TourStepSignal {
  key: TourKey;
  index: number;
  /** The `data-tour` key, not the selector. */
  target: string;
  /** False when the target was absent or the step's hook rejected. */
  resolved: boolean;
  /** Present only when the step's hook ran (onNext/onPrev), not scoped to element waits. */
  waitMs?: number;
}

export interface TourEndSignal {
  key: TourKey;
  index: number;
  reason: TourEndReason;
}

export interface EmitTourDeps {
  /** Injectable for tests; defaults to the global Faro instance (absent → no-op). */
  pushEvent?: (name: string, attributes: Record<string, string>) => void;
}

function push(name: string, attributes: Record<string, string>, deps: EmitTourDeps): void {
  try {
    const pushEvent = deps.pushEvent ?? faro?.api?.pushEvent?.bind(faro.api);
    if (!pushEvent) return;
    pushEvent(name, { ...attributes, sampleRate: '1' });
  } catch {
    // A tour must survive its own telemetry.
  }
}

export function emitTourStart(signal: TourStartSignal, deps: EmitTourDeps = {}): void {
  push(
    TOUR_START_EVENT,
    { key: signal.key, trigger: signal.trigger, stepCount: String(signal.stepCount) },
    deps
  );
}

export function emitTourStep(signal: TourStepSignal, deps: EmitTourDeps = {}): void {
  push(
    TOUR_STEP_EVENT,
    {
      key: signal.key,
      index: String(signal.index),
      target: signal.target,
      resolved: String(signal.resolved),
      ...(signal.waitMs != null ? { waitMs: String(signal.waitMs) } : {}),
    },
    deps
  );
}

export function emitTourEnd(signal: TourEndSignal, deps: EmitTourDeps = {}): void {
  push(
    TOUR_END_EVENT,
    { key: signal.key, index: String(signal.index), reason: signal.reason },
    deps
  );
}
