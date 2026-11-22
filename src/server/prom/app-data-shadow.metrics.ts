import client from 'prom-client';
import { instrumentationRegistry, registerInstrumentationMetric } from '@civitai/telemetry/client';

// The App Storage shadow read's counters (`app-data-shadow.service.ts`): a sampled list the site's
// document store answered, also asked of the shared app-data service (apps/app-data-go), registry
// only. Every label is from a fixed set: no app, collection, key, user or value. Which app a
// mismatch was for is in the structured log, not here. Registered on `instrumentationRegistry`,
// which `/api/metrics` merges into the scrape.

export const APP_DATA_SHADOW_OUTCOMES = [
  // Both answers were read and compared (`app_data_shadow_compared_total` says how).
  'compared',
  // Not asked: a list app-data-go cannot answer the same way. Not the app's own collection (an
  // import), not a private collection, not the published namespace (dev, review), not an app or hub
  // token, an anonymous viewer, or a list with filters, a sort, a mark, a key prefix or a cursor.
  'unsupported_input',
  // Not asked: the REST answer has a next page, so it is not the whole collection.
  'incomplete',
  // Not asked: this process already has the maximum number of shadow reads in flight. Counted
  // before the flag is read, so it can count a list of an app the flag is off for.
  'saturated',
  // app-data-go answered, and the registry could not answer the read
  // (`app_data_shadow_registry_misses_total` says why).
  'registry_miss',
  // app-data-go did not answer within the shadow timeout.
  'timeout',
  // app-data-go answered a non-2xx status, or the call failed.
  'error',
  // app-data-go answered 2xx with a body that is not a registry-only answer.
  'bad_response',
] as const;
export type AppDataShadowOutcome = (typeof APP_DATA_SHADOW_OUTCOMES)[number];

/**
 * app-data-go's fallback reasons (its `metrics.FallbackReasons`), the `reason` a registry-only
 * answer carries. Anything else is counted as `other`, so a reason added there cannot grow this
 * label without a change here.
 */
export const APP_DATA_REGISTRY_MISS_REASONS = [
  'registry_off',
  'token_not_exchangeable',
  'empty',
  'capacity',
  'token_capacity',
  'not_live',
  'stalled',
  'cooling_down',
  'invalid_token',
  'exchange_refused',
  'not_private',
  'too_large',
  'ended',
  'failed',
  'closed',
  'block_spent',
  'block_cache_full',
  'other',
] as const;
export type AppDataRegistryMissReason = (typeof APP_DATA_REGISTRY_MISS_REASONS)[number];

export function registryMissReason(raw: unknown): AppDataRegistryMissReason {
  return typeof raw === 'string' &&
    (APP_DATA_REGISTRY_MISS_REASONS as readonly string[]).includes(raw)
    ? (raw as AppDataRegistryMissReason)
    : 'other';
}

function counter(name: string, help: string, labelNames: string[]) {
  return registerInstrumentationMetric(
    name,
    () => new client.Counter({ name, help, labelNames, registers: [instrumentationRegistry] })
  );
}

const shadowRequests = counter(
  'app_data_shadow_requests_total',
  'Sampled App Storage lists of apps the app-data-registry-shadow flag is on for, by what the ' +
    'shadow read did.',
  ['outcome']
);
const registryMisses = counter(
  'app_data_shadow_registry_misses_total',
  "Shadow reads app-data-go answered without the registry's answer, by app-data-go's reason.",
  ['reason']
);
const compared = counter(
  'app_data_shadow_compared_total',
  'Shadow reads whose REST and registry answers were compared, by result (match, mismatch).',
  ['result']
);
const comparedRecords = counter(
  'app_data_shadow_compared_records_total',
  'Records compared (on either side): the denominator of the record mismatch rate.',
  []
);
const mismatchedRecords = counter(
  'app_data_shadow_mismatched_records_total',
  'Records on one side only, by side (rest_only: the REST answer holds it and the registry does ' +
    'not; registry_only: the reverse). A record is matched by its data, not its key.',
  ['side']
);

export function recordAppDataShadow(outcome: AppDataShadowOutcome) {
  shadowRequests.inc({ outcome });
}

export function recordAppDataRegistryMiss(reason: AppDataRegistryMissReason) {
  registryMisses.inc({ reason });
}

export type AppDataComparison = {
  restCount: number;
  registryCount: number;
  restOnly: number;
  registryOnly: number;
};

export function recordAppDataComparison(c: AppDataComparison) {
  const mismatch = c.restOnly > 0 || c.registryOnly > 0;
  compared.inc({ result: mismatch ? 'mismatch' : 'match' });
  const records = c.restCount + c.registryOnly;
  if (records > 0) comparedRecords.inc(records);
  if (c.restOnly > 0) mismatchedRecords.inc({ side: 'rest_only' }, c.restOnly);
  if (c.registryOnly > 0) mismatchedRecords.inc({ side: 'registry_only' }, c.registryOnly);
}
