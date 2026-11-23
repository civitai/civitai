// THE REPORT MODERATION API: `POST /api/v1/blocks/moderation/reports`
// (`src/pages/api/v1/blocks/moderation/reports.ts`), the replacement for the document store's
// `report` mark (`docs/app-storage-generic-core.md`, "The report moderation API").
//
//   POST { collection, key, from? }  →  200 { "reported": true }
//
// The answer is the same whether or not this viewer had already reported the document, and it
// never carries a count. Refusals use the storage envelope (`doc-store-api.ts`: `sendError`), with
// their metrics labelled `storage_report`.
//
// What a report is, and what it is checked against, is the `report` mark's, unchanged:
// - IDENTITY: (app, namespace) from the verified block token; `collection` must be a declared
//   SHARED collection (`collection_not_declared`; `invalid_request` for a private one), and `key`
//   a visible document in it (`404 not_found`).
// - AUTH: the block token with `apps:storage` (the page's required scope, consent-exempt), a
//   signed-in viewer (`401 sign_in_required`), and the shared-write trust gate (`assertTrusted`).
//   No publish scope on the app's own documents.
// - IMPORTS: `from` naming another app runs the report in that SOURCE app, through an import the
//   caller's manifest declares, as an authoring op: a `readwrite` import and the viewer's
//   `apps:storage:publish` grant in the source (`assertImportTallyPublishScope`); a read-only
//   import is refused (`write_policy`). As on the storage route, such a call is first charged to
//   the consumer's read bucket, and `from` naming the token's own app is an own call.
// - RATE LIMIT: the `report` bucket (`DOC_STORE_REPORT_RATE_LIMIT_MAX` per viewer per app per
//   day) under the SAME key the `report` mark spends, so the two paths share one daily budget and
//   a repeat report spends a token as a repeat mark does.
// - STORAGE: one `doc_mark` row named `report` per (document, viewer), the row the mark
//   writes, and NO `doc_tally` row (`DocStore.report`). The moderator queue reads those rows;
//   dismissal (`reports_dismissed_at`) applies to them unchanged.
// - No withdrawal (there is no DELETE), and no permission hook ever sees a report.
//
// FLAG: `app-blocks-storage-report-api`, evaluated per REQUESTING app (entityId = the block
// token's app block id, no context). Off — the default, and when Flipt is unreachable — the path
// answers as an unknown route (`404 not_found`), whatever the method.
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import type { BlockScopedNextApiRequest } from '~/server/middleware/block-scope.middleware';
import {
  blockClaimsAppLabel,
  recordAppStorageRequest,
  type DocStoreEndpoint,
} from '~/server/metrics/app-block-runtime.metrics';
import type { DocStore } from '~/server/services/apps/doc-store';
import {
  assertImportTallyPublishScope,
  assertTrusted,
  charge,
  collectionOf,
  envelope,
  otherAppSource,
  parseBody,
  requireViewer,
  sendEnvelope,
  sendError,
  STORAGE_ERROR_STATUS,
} from '~/server/services/apps/doc-store-api';
import { resolveImportAccess, resolveStorageAccess } from '~/server/services/apps/doc-store-access';
import { getDocStore } from '~/server/services/apps/doc-store.instance';
import { DocStoreError } from '~/server/services/apps/doc-store.types';

/** The metrics label of every response this route sends. */
export const REPORT_ENDPOINT: DocStoreEndpoint = 'storage_report';

const reportBody = z.strictObject({
  collection: z.string(),
  key: z.string(),
  from: z.string().optional(),
});

/** What the route answers for every report it accepts: never a count. */
export const REPORTED = { reported: true } as const;

const noSuchRoute = () => new DocStoreError('not_found', 'no such route');

/** The JSON body as Next parsed it (an object), or as text when the content type was not JSON. */
function bodyOf(req: NextApiRequest): unknown {
  const raw: unknown = req.body;
  if (typeof raw !== 'string') return raw;
  if (raw === '') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new DocStoreError('invalid_request', 'request body is not valid JSON');
  }
}

export type ReportApiDeps = {
  /** The store (default: the process store, `getDocStore`). */
  store?: () => DocStore;
};

export function createReportHandler(deps: ReportApiDeps = {}) {
  const getStore = deps.store ?? getDocStore;
  return async function reportHandler(req: NextApiRequest, res: NextApiResponse) {
    try {
      const claims = (req as BlockScopedNextApiRequest).blockClaims;
      if (!claims) throw new DocStoreError('unauthenticated', 'a block token is required');
      // Off for this app, the path is not a route at all, before any other answer (a 405
      // included).
      const served =
        !!claims.appBlockId &&
        (await isFlipt(FLIPT_FEATURE_FLAGS.APP_BLOCKS_STORAGE_REPORT_API, claims.appBlockId));
      if (!served) throw noSuchRoute();
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        sendEnvelope(
          req,
          res,
          STORAGE_ERROR_STATUS.method_not_allowed,
          envelope('method_not_allowed', 'method not allowed'),
          REPORT_ENDPOINT
        );
        return;
      }
      const stray = Object.keys(req.query)[0];
      if (stray !== undefined) {
        throw new DocStoreError('invalid_request', `unknown query parameter ${stray}`);
      }
      const input = parseBody(reportBody, bodyOf(req));

      const own = await resolveStorageAccess(claims, {
        consentUnavailable: (req as BlockScopedNextApiRequest).blockConsentUnavailable === true,
      });
      recordAppStorageRequest({
        app: blockClaimsAppLabel(claims),
        op: 'report',
        via: 'direct',
        viewer: own.ctx.viewerUid === null ? 'signed_out' : 'signed_in',
        tokenKind: own.tokenKind,
      });
      const from = otherAppSource(input.from ?? null, own);
      if (from !== null) await charge('read', own, req);
      const access =
        from === null
          ? own
          : await resolveImportAccess(own, { from, collection: input.collection, op: 'author' });

      const coll = collectionOf(access, input.collection);
      const uid = requireViewer(access);
      // Before any budget: only a shared document can be reported.
      if (coll.config.visibility !== 'shared') {
        throw new DocStoreError('invalid_request', 'reports exist on shared collections only');
      }
      assertImportTallyPublishScope(access, true);
      // The bucket first: a refused request costs no subject lookup.
      await charge('report', access, req);
      await assertTrusted(uid);
      await getStore().report(access.ctx, coll, input.key);
      res.status(200).json(REPORTED);
    } catch (err) {
      sendError(req, res, err, REPORT_ENDPOINT);
    }
  };
}
