// The process's document-store RATER operations (content levels), on the same least-privilege pool
// as the viewer store but as a separate object, so nothing holding the block-token store can write
// a rating. Imported only by `doc-rater.service.ts` and `doc-rater-subject.ts`.
import { appdataDb } from '~/server/db/appdataDb';
import { logToAxiom } from '~/server/logging/client';
import type { DocStoreRater } from '~/server/services/apps/doc-store';
import { createDocStoreRater } from '~/server/services/apps/doc-store';

let instance: DocStoreRater | undefined;

export function getDocStoreRater(): DocStoreRater {
  return (instance ??= createDocStoreRater({
    db: appdataDb,
    onRefused: (role) => {
      logToAxiom(
        {
          type: 'error',
          event: 'doc_store_role_refused',
          message:
            'document store rater disabled: APPDATA_DATABASE_URL connects as a role that bypasses row-level security',
          role: role.name,
          superuser: role.superuser,
          bypassRls: role.bypassRls,
        },
        'app-blocks'
      );
    },
  }));
}
