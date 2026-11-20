// The process's document-store PRIVATE FEED (`createDocStorePrivateFeed`): one user's private
// documents of one collection, for the registry adapter's authorized private streams. The same
// least-privilege pool as the public feed, but a separate object, so nothing holding the public feed
// or the block-token routes' store can read by a caller-supplied user id. Built only by the registry
// adapter's process, and only while private streams are switched on (`private-feed.live.ts`).
import { appdataDb } from '~/server/db/appdataDb';
import { logToAxiom } from '~/server/logging/client';
import type { DocStorePrivateFeed } from '~/server/services/apps/doc-store';
import { createDocStorePrivateFeed } from '~/server/services/apps/doc-store';

let instance: DocStorePrivateFeed | undefined;

export function getDocStorePrivateFeed(): DocStorePrivateFeed {
  return (instance ??= createDocStorePrivateFeed({
    db: appdataDb,
    onRefused: (role) => {
      logToAxiom(
        {
          type: 'error',
          event: 'doc_store_role_refused',
          message:
            'document store private feed disabled: APPDATA_DATABASE_URL connects as a role that bypasses row-level security',
          role: role.name,
          superuser: role.superuser,
          bypassRls: role.bypassRls,
        },
        'app-blocks'
      );
    },
  }));
}
