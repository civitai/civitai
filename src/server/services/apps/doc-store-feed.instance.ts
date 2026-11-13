// The process's document-store REGISTRY FEED (`createDocStoreFeed`): the same least-privilege pool as
// the viewer store, but a separate object, so nothing holding the block-token routes' store can read
// a collection by seq range. Built only by the registry adapter's process.
import { appdataDb } from '~/server/db/appdataDb';
import { logToAxiom } from '~/server/logging/client';
import type { DocStoreFeed } from '~/server/services/apps/doc-store';
import { createDocStoreFeed } from '~/server/services/apps/doc-store';

let instance: DocStoreFeed | undefined;

export function getDocStoreFeed(): DocStoreFeed {
  return (instance ??= createDocStoreFeed({
    db: appdataDb,
    onRefused: (role) => {
      logToAxiom(
        {
          type: 'error',
          event: 'doc_store_role_refused',
          message:
            'document store feed disabled: APPDATA_DATABASE_URL connects as a role that bypasses row-level security',
          role: role.name,
          superuser: role.superuser,
          bypassRls: role.bypassRls,
        },
        'app-blocks'
      ).catch(() => undefined);
    },
  }));
}
