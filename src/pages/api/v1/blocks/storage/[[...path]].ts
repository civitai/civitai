import { withAxiom } from '@civitai/next-axiom';
import { withBlockScope } from '~/server/middleware/block-scope.middleware';
import {
  createStorageHandler,
  storageEndpointLabel,
  storageRefusalBody,
} from '~/server/services/apps/doc-store-api';

/**
 * `/api/v1/blocks/storage/…` — the App Blocks document store. Every path, the reserved
 * segments, the error envelope and the gates are documented in
 * `src/server/services/apps/doc-store-api.ts`; this file only wires the route.
 *
 * `apps:storage` is required for every operation and is consent-exempt; the consent-gated
 * `apps:storage:publish` is checked in the handler, only for document writes into shared
 * collections that viewers author. Inert until `APPDATA_DATABASE_URL` is configured: the
 * store answers every data operation `503 storage_disabled`.
 */

// Next's body parser is OFF: the handler reads the body itself, capped at the store's own
// document limit plus the request wrapper (`STORAGE_BODY_LIMIT_BYTES`), so a malformed or
// oversized body is answered in the storage envelope, with the CORS headers already set.
export const config = { api: { bodyParser: false } };

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque origin
// (`Origin: null`); the Bearer block-JWT (no cookies) remains the sole authz gate — see
// WithBlockScopeOpts.allowOpaqueOrigin. extraCorsMethods: documents are written with PUT and
// deleted with DELETE, which the preflight must allow.
export default withBlockScope(withAxiom(createStorageHandler()), {
  endpoint: storageEndpointLabel,
  requiredScope: 'apps:storage',
  allowOpaqueOrigin: true,
  extraCorsMethods: ['PUT', 'DELETE'],
  // The middleware's own refusals in this route's envelope, so every response has one shape.
  formatRefusal: storageRefusalBody,
});
