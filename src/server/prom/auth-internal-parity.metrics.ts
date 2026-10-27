import client from 'prom-client';
import { probeInternalParity } from '@civitai/auth';
import {
  instrumentationRegistry,
  PROM_PREFIX,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';
import { cachedRead } from '~/server/prom/cached-read';

const PARITY_METRIC = PROM_PREFIX + 'auth_internal_parity';
const PARITY_PROBE_INTERVAL_MS = 10 * 60_000;

/**
 * 1 when the hub accepts this app's service credential, 0 when it refuses it. The probe runs in the background
 * at most every ten minutes, so a scrape never waits on the hub; until the first answer the series is absent.
 */
export function createInternalParityGauge(
  probe: () => Promise<0 | 1>,
  registry: client.Registry,
  now: () => number = Date.now
) {
  const parity = cachedRead(probe, PARITY_PROBE_INTERVAL_MS, now);
  return {
    refresh: parity.refresh,
    gauge: new client.Gauge({
      name: PARITY_METRIC,
      help: "1 when the auth hub accepts this app's service credential, 0 when it does not.",
      labelNames: ['app'],
      registers: [registry],
      collect() {
        const value = parity.current();
        this.reset();
        if (value !== null) this.set({ app: 'main' }, value);
      },
    }),
  };
}

registerInstrumentationMetric(
  PARITY_METRIC,
  () => createInternalParityGauge(probeInternalParity, instrumentationRegistry).gauge
);
