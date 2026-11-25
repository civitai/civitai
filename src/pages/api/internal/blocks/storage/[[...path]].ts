import { internalStorageRoute } from '~/server/services/apps/doc-store-internal-route';

/**
 * `/api/internal/blocks/storage/…` — the document store's INTERNAL route, which app-data-go
 * forwards writes and `info` to (apps/app-data-go/WRITES-DESIGN.md). It is the public route's
 * chain (withBlockScope over withAxiom over the storage handler, the same options) behind a caller
 * signature that runs first, so the chain is built in `doc-store-internal-route.ts` and this file
 * only wires it. Dark: without `APP_DATA_WRITES_SIGNING_KEY` every path answers 404.
 */

// Next's body parser is OFF, as on the public route: the signature check reads the raw body
// itself, under the store's own limit, and hands the same bytes to the handler.
export const config = { api: { bodyParser: false } };

export default internalStorageRoute;
