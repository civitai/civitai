// The process's document store, wired to its least-privilege pool. Callers (the
// storage routes) use `getDocStore()`; tests build their own with `createDocStore`.
import { appdataDb } from '~/server/db/appdataDb';
import { logToAxiom } from '~/server/logging/client';
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
