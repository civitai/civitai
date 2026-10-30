// The process's document store, wired to its least-privilege pool. Callers (the
// storage routes) use `getDocStore()`; tests build their own with `createDocStore`.
import { appdataDb } from '~/server/db/appdataDb';
import { logToAxiom } from '~/server/logging/client';
import { setDocStoreEnabled } from '~/server/metrics/app-block-runtime.metrics';
import type { DocStore } from '~/server/services/apps/doc-store';
import { createDocStore } from '~/server/services/apps/doc-store';

let instance: DocStore | undefined;

/**
 * One store per process, so the role check it runs on first use happens (and
 * is logged) once. With `APPDATA_DATABASE_URL` unset every call is
 * `storage_disabled`.
 */
export function getDocStore(): DocStore {
  return (instance ??= createDocStore({
    db: appdataDb,
    onRefused: (role) => {
      logToAxiom(
        {
          type: 'error',
          event: 'doc_store_role_refused',
          message:
            'document store disabled: APPDATA_DATABASE_URL connects as a role that bypasses row-level security',
          role: role.name,
          superuser: role.superuser,
          bypassRls: role.bypassRls,
        },
        'app-blocks'
      ).catch(() => undefined);
    },
  }));
}

/** How long a scrape waits for a cold store's role read before reporting it unconfirmed. */
export const DOC_STORE_ENABLED_PROBE_TIMEOUT_MS = 2000;

/**
 * Sets `civitai_app_block_doc_store_enabled` from the store's own predicate (`isUsable`): 1 once
 * the role is confirmed, 0 when unconfigured or refused — and 0 while the role cannot be read
 * (a failed or slow connection), retried on the next scrape. Called by /api/metrics on every
 * scrape, so the gauge has a value with no storage traffic. On a settled store this is a
 * cached read with no database round trip. Never throws.
 */
export async function refreshDocStoreEnabled(
  store: Pick<DocStore, 'isUsable'> = getDocStore(),
  timeoutMs = DOC_STORE_ENABLED_PROBE_TIMEOUT_MS
): Promise<void> {
  let usable = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    usable = await Promise.race([
      store.isUsable(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    usable = false;
  } finally {
    if (timer) clearTimeout(timer);
  }
  setDocStoreEnabled(usable);
}
