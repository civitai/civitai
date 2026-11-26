import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { createCachedFlagGate, readFliptSwitch } from '~/server/utils/otel-withspan-gate';

// Which ClickHouse the image MetricService reads (`getImageMetricService` in image.service): the
// dedicated entity-metrics one, or the shared one. See IMAGE_METRICS_DEDICATED_CLICKHOUSE in
// ~/server/flipt/client for what the flag does.

const readDedicatedFlag = readFliptSwitch(
  () => FLIPT_FEATURE_FLAGS.IMAGE_METRICS_DEDICATED_CLICKHOUSE
);

let dedicatedGate = createCachedFlagGate(readDedicatedFlag);

/**
 * True only when the dedicated client exists AND `image-metrics-dedicated-clickhouse` is on. The
 * flag is read at most once per 5s per process; unknown or a throw reads as OFF. Without the client
 * the flag is not read at all, so turning it on in an environment that lacks the env is a no-op.
 */
export function readsDedicatedImageMetricsClickhouse(dedicatedConfigured: boolean): boolean {
  return dedicatedConfigured && dedicatedGate();
}

/** Tests only: forget the cached flag read. */
export function resetImageMetricsClickhouseGateForTests() {
  dedicatedGate = createCachedFlagGate(readDedicatedFlag);
}
