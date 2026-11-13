// App wiring for the replica → primary read fallback (packages/civitai-db/src/replica-fallback.ts).
// Its own module, not db-helpers.ts: pgDb.ts calls it while building the pools at import time, and
// db-helpers.ts imports the Prisma client module, so keeping this apart avoids a module-init cycle.
import {
  createReplicaFallback,
  createReplicaFallbackCounter,
  REPLICA_FALLBACK_COUNTER_NAME,
  type ReplicaFallback,
} from '@civitai/db/replica-fallback';
import { loadDbEnv, type DbConfig } from '@civitai/db/env';
import { instrumentationRegistry, registerInstrumentationMetric } from '@civitai/telemetry/client';

// The pools are process-global, so the counter lives in the cross-graph registry /api/metrics reads.
const replicaFallbackCounter = registerInstrumentationMetric(REPLICA_FALLBACK_COUNTER_NAME, () =>
  createReplicaFallbackCounter([instrumentationRegistry])
);

/**
 * The fallback for one read client, or `undefined` while `DATABASE_REPLICA_FALLBACK` is off (the
 * default) — callers then wire nothing at all.
 */
export function replicaFallbackFor(
  label: string,
  config: Pick<DbConfig, 'replicaFallback' | 'replicaFallbackMax'> = loadDbEnv()
): ReplicaFallback | undefined {
  if (!config.replicaFallback) return undefined;
  return createReplicaFallback({
    label,
    maxConcurrent: config.replicaFallbackMax,
    counter: replicaFallbackCounter,
  });
}
