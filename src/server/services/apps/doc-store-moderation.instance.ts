// The process's document-store MODERATOR operations, on the same least-privilege pool as the
// viewer store but as a separate object, so nothing holding the block-token store can reach
// them. Imported only by `doc-store-moderation.service.ts` (pinned by the ledger case in
// `routers/__tests__/apps-mod-doc-store.router.test.ts`).
import { appdataDb } from '~/server/db/appdataDb';
import { logToAxiom } from '~/server/logging/client';
import type { DocStoreModeration } from '~/server/services/apps/doc-store';
import { createDocStoreModeration } from '~/server/services/apps/doc-store';

let instance: DocStoreModeration | undefined;

export function getDocStoreModeration(): DocStoreModeration {
  return (instance ??= createDocStoreModeration({
    db: appdataDb,
    onRefused: (role) => {
      logToAxiom(
        {
          type: 'error',
          event: 'doc_store_role_refused',
          message:
            'document store moderation disabled: APPDATA_DATABASE_URL connects as a role that bypasses row-level security',
          role: role.name,
          superuser: role.superuser,
          bypassRls: role.bypassRls,
        },
        'app-blocks'
      ).catch(() => undefined);
    },
  }));
}
