// The process's document-store VIEWER DATA object (`listViewerUsage`, `emptyViewerData`), on the
// same least-privilege pool as the viewer store but as a separate object, so nothing holding the
// block-token store can reach a user's rows across apps. Imported only by the account-settings
// service (`doc-store-viewer-usage.service.ts`); pinned by
// `__tests__/doc-store-viewer-data.ledger.test.ts`.
import { appdataDb } from '~/server/db/appdataDb';
import { logToAxiom } from '~/server/logging/client';
import type { DocStoreViewerData } from '~/server/services/apps/doc-store';
import { createDocStoreViewerData } from '~/server/services/apps/doc-store';

let instance: DocStoreViewerData | undefined;

export function getDocStoreViewerData(): DocStoreViewerData {
  return (instance ??= createDocStoreViewerData({
    db: appdataDb,
    onRefused: (role) => {
      logToAxiom(
        {
          type: 'error',
          event: 'doc_store_role_refused',
          message:
            'document store viewer data disabled: APPDATA_DATABASE_URL connects as a role that bypasses row-level security',
          role: role.name,
          superuser: role.superuser,
          bypassRls: role.bypassRls,
        },
        'app-blocks'
      ).catch(() => undefined);
    },
  }));
}
