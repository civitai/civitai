// The process's document-store SERVER LOOKUP (`findSharedByKey`): the same least-privilege pool as
// the viewer store, but a separate object, so the block-token routes' store carries no
// cross-collection read.
import { appdataDb } from '~/server/db/appdataDb';
import { logToAxiom } from '~/server/logging/client';
import type { DocStoreLookup } from '~/server/services/apps/doc-store';
import { createDocStoreLookup } from '~/server/services/apps/doc-store';

let instance: DocStoreLookup | undefined;

export function getDocStoreLookup(): DocStoreLookup {
  return (instance ??= createDocStoreLookup({
    db: appdataDb,
    onRefused: (role) => {
      logToAxiom(
        {
          type: 'error',
          event: 'doc_store_role_refused',
          message:
            'document store lookup disabled: APPDATA_DATABASE_URL connects as a role that bypasses row-level security',
          role: role.name,
          superuser: role.superuser,
          bypassRls: role.bypassRls,
        },
        'app-blocks'
      ).catch(() => undefined);
    },
  }));
}
