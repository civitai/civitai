import client from 'prom-client';
import {
  instrumentationRegistry,
  PROM_PREFIX,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';

/**
 * Counters of the resource-intent v1_tags arm: the served arm's fallbacks, the shadow computation's
 * outcomes, and the judge-capture writes. A prom-client leaf, imported only by the service.
 */

const M = PROM_PREFIX + 'resource_intent_';
export const RESOURCE_INTENT_V1_METRICS = {
  fallbacks: M + 'v1_fallbacks_total',
  shadow: M + 'v1_shadow_total',
  judgeCapture: M + 'judge_capture_writes_total',
} as const;

const fallbacks = registerInstrumentationMetric(
  RESOURCE_INTENT_V1_METRICS.fallbacks,
  () =>
    new client.Counter({
      name: RESOURCE_INTENT_V1_METRICS.fallbacks,
      help: 'Served v1_tags responses computed on this pod that fell back to the POOL_MERGE list, by kind and reason (a tag-index holder reason, no_tags, no_ecosystem, unknown_ecosystem or no_candidates). Cache hits are not counted.',
      labelNames: ['kind', 'reason'],
      registers: [instrumentationRegistry],
    })
);

const shadow = registerInstrumentationMetric(
  RESOURCE_INTENT_V1_METRICS.shadow,
  () =>
    new client.Counter({
      name: RESOURCE_INTENT_V1_METRICS.shadow,
      help: 'v1_tags shadow computations on this pod, by kind and outcome: ok, error (the shadow threw), skipped (too many already running on this pod), or the reason the arm would have fallen back.',
      labelNames: ['kind', 'outcome'],
      registers: [instrumentationRegistry],
    })
);

const judgeCapture = registerInstrumentationMetric(
  RESOURCE_INTENT_V1_METRICS.judgeCapture,
  () =>
    new client.Counter({
      name: RESOURCE_INTENT_V1_METRICS.judgeCapture,
      help: 'Judge-capture rows this pod handed to ClickHouse, by outcome: ok (accepted by the client; inserts are async, so a row the table refuses is still lost), error, or no_client.',
      labelNames: ['outcome'],
      registers: [instrumentationRegistry],
    })
);

export function recordV1Fallback(kind: string, reason: string) {
  fallbacks.inc({ kind, reason });
}

export function recordV1Shadow(kind: string, outcome: string) {
  shadow.inc({ kind, outcome });
}

export function recordJudgeCapture(outcome: 'ok' | 'error' | 'no_client') {
  judgeCapture.inc({ outcome });
}
