// The process's document-store MAINTENANCE (`purgeReview`, `listReviewAppIds`, `wipeAccount`),
// on the same least-privilege pool as the viewer store but as a separate object, so nothing
// holding the block-token store can reach it. Imported only by the publish-request decision
// path (`publish-request.service.ts`), the sweep job (`jobs/sweep-review-storage.ts`) and the
// account wipe (`user.service.ts` `removeAllContent`); pinned by
// `__tests__/doc-store-maintenance.ledger.test.ts`.
import { appdataDb } from '~/server/db/appdataDb';
import { logToAxiom } from '~/server/logging/client';
import type { DocStoreMaintenance } from '~/server/services/apps/doc-store';
import { createDocStoreMaintenance } from '~/server/services/apps/doc-store';

let instance: DocStoreMaintenance | undefined;

export function getDocStoreMaintenance(): DocStoreMaintenance {
  return (instance ??= createDocStoreMaintenance({
    db: appdataDb,
    onRefused: (role) => {
      logToAxiom(
        {
          type: 'error',
          event: 'doc_store_role_refused',
          message:
            'document store maintenance disabled: APPDATA_DATABASE_URL connects as a role that bypasses row-level security',
          role: role.name,
          superuser: role.superuser,
          bypassRls: role.bypassRls,
        },
        'app-blocks'
      ).catch(() => undefined);
    },
  }));
}
