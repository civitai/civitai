import client from 'prom-client';
import { PROM_PREFIX } from '@civitai/telemetry/client';

export const LEGACY_STORES = ['app', 'shared'] as const;
export type LegacyStore = (typeof LEGACY_STORES)[number];

export const LEGACY_STORE_TRANSPORTS = ['rest', 'bridge'] as const;
export type LegacyStoreTransport = (typeof LEGACY_STORE_TRANSPORTS)[number];

// Pinned on globalThis so a second evaluation of this module (HMR, or the server build emitting
// it twice) reuses the instance instead of throwing prom-client's duplicate-registration error.
declare global {
  // eslint-disable-next-line no-var
  var __civitaiLegacyStoreRefusals: client.Counter<'store' | 'transport'> | undefined;
}

function createCounter() {
  const counter = new client.Counter({
    name: PROM_PREFIX + 'block_legacy_store_refusals_total',
    help:
      'App Block calls to the removed legacy stores (per-viewer app storage, shared storage) ' +
      'refused because app-blocks-legacy-stores-removed is on, by store (app|shared) and ' +
      'transport (rest|bridge). Zero while the flag is off.',
    labelNames: ['store', 'transport'],
  });
  // Seeded at 0 so "nothing was refused" and "the counter is not wired" are different series.
  for (const store of LEGACY_STORES) {
    for (const transport of LEGACY_STORE_TRANSPORTS) counter.labels({ store, transport });
  }
  return counter;
}

const refusals = (globalThis.__civitaiLegacyStoreRefusals ??= createCounter());

export function recordLegacyStoreRefusal(
  store: LegacyStore,
  transport: LegacyStoreTransport
): void {
  try {
    refusals.inc({ store, transport });
  } catch {
    /* telemetry must not change the response */
  }
}
