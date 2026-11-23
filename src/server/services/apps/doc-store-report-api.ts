// THE REPORT MODERATION API: `POST /api/v1/blocks/moderation/reports {collection, key, from?}` →
// `200 {"reported": true}`, never a count (docs/app-storage-generic-core.md, "The report moderation
// API"). Its gates are the `report` mark's (`assertReportGate` in `doc-store-api.ts`): the two paths
// spend ONE daily report budget under the same key. No permission hook ever sees a report and there
// is no withdrawal. FLAG `app-blocks-storage-report-api` (per requesting app, default off): off, the
// path answers `404 not_found` for every method.
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
  assertReportGate,
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
import { gateHook } from '~/server/services/apps/doc-store-hook';
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
      requireViewer(access);
      // Before any budget: only a shared document can be reported.
      if (coll.config.visibility !== 'shared') {
        throw new DocStoreError('invalid_request', 'reports exist on shared collections only');
      }
      await assertReportGate(access, req, true);
      // PROBE (mutant, reverted in the next commit): a permission-hook gate at the handler layer.
      await gateHook({
        access,
        coll,
        store: getStore(),
        op: 'mark',
        key: input.key,
        tally: { name: 'vote' },
      });
      await getStore().report(access.ctx, coll, input.key);
      res.status(200).json(REPORTED);
    } catch (err) {
      sendError(req, res, err, REPORT_ENDPOINT);
    }
  };
}
