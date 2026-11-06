import { TRPCError } from '@trpc/server';
import type { NextApiHandler } from 'next';

import { ensureFliptInitialized, isFliptSync } from '~/server/flipt/client';
import { recordLegacyStoreRefusal, type LegacyStore } from '~/server/prom/legacy-store.metrics';

export type { LegacyStore } from '~/server/prom/legacy-store.metrics';

/**
 * ON = the legacy per-viewer app storage (`app_<slug>.kv`) and shared storage
 * (`app_<slug>.shared_kv` + votes/counters/reports) refuse every app call: REST answers 410,
 * the bridge procedures answer PRECONDITION_FAILED. Moderator tooling, account wipe,
 * provisioning and the server-side item-key lookup are not gated.
 *
 * Before LEGACY_STORES_FAIL_CLOSED_AT only an explicit ON removes the stores. From then on
 * they are removed unless the flag is explicitly OFF (the no-deploy rollback): a missing key,
 * an uninitialised client or an evaluation error all mean removed. Evaluated globally (no
 * entity, no context): set the boolean and add no rules — a segment matches nothing and a
 * percentage is 0 or 100.
 */
export const APP_BLOCKS_LEGACY_STORES_REMOVED_FLAG = 'app-blocks-legacy-stores-removed';

/** The announced removal date: https://developer.civitai.com/apps/guide/storage#moving-from-the-legacy-stores */
export const LEGACY_STORES_FAIL_CLOSED_AT = Date.parse('2026-11-10T00:00:00Z');

export const LEGACY_STORE_REMOVED_CODE = 'legacy_store_removed';
export const LEGACY_STORE_MIGRATION_GUIDE_URL =
  'https://developer.civitai.com/apps/guide/storage#moving-from-the-legacy-stores';

const STORE_NAME: Record<LegacyStore, string> = {
  app: 'legacy app storage (useAppStorage)',
  shared: 'legacy shared storage (useSharedStorage)',
};

export function legacyStoreRemovedMessage(store: LegacyStore): string {
  return `${LEGACY_STORE_REMOVED_CODE}: the ${STORE_NAME[store]} has been removed. Move this app to the document store: ${LEGACY_STORE_MIGRATION_GUIDE_URL}`;
}

export function legacyStoreRemovedBody(store: LegacyStore) {
  return {
    error: LEGACY_STORE_REMOVED_CODE,
    message: legacyStoreRemovedMessage(store),
    docs: LEGACY_STORE_MIGRATION_GUIDE_URL,
  };
}

export async function areLegacyStoresRemoved(): Promise<boolean> {
  // `isFlipt` answers false for an explicit OFF and for a missing key or no client alike;
  // `isFliptSync` answers null for the last two, which is the distinction the cutoff needs.
  let answer = isFliptSync(APP_BLOCKS_LEGACY_STORES_REMOVED_FLAG);
  if (answer === null) {
    await ensureFliptInitialized();
    answer = isFliptSync(APP_BLOCKS_LEGACY_STORES_REMOVED_FLAG);
  }
  if (Date.now() < LEGACY_STORES_FAIL_CLOSED_AT) return answer === true;
  return answer !== false;
}

/** Bridge (tRPC) refusal. The stable code leads the message, which the hosts forward to the block. */
export async function assertLegacyStoreAvailable(store: LegacyStore): Promise<void> {
  if (!(await areLegacyStoresRemoved())) return;
  recordLegacyStoreRefusal(store, 'bridge');
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: legacyStoreRemovedMessage(store),
  });
}

/**
 * REST refusal. Wrap the handler INSIDE `withBlockScope` so the CORS headers it sets still
 * reach the block, which then can read the 410 body.
 */
export function withLegacyStoreGate(store: LegacyStore, handler: NextApiHandler): NextApiHandler {
  return async function legacyStoreGate(req, res) {
    if (await areLegacyStoresRemoved()) {
      recordLegacyStoreRefusal(store, 'rest');
      res.status(410).json(legacyStoreRemovedBody(store));
      return;
    }
    return handler(req, res);
  };
}
