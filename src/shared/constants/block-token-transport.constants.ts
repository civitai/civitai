/**
 * tRPC QUERY procedures whose input carries a block token (`blockToken`, a bearer JWT).
 *
 * The single source of truth for both ends of the wire, so it stays dependency-free and safe to
 * pull into the client bundle:
 *   - the browser link (`src/utils/trpc.ts`) sends these as POST and never batches them, so the
 *     token rides in the request body instead of the URL;
 *   - the server (`src/server/trpc/edge-cache-headers.ts`) answers them `Cache-Control: no-store`
 *     whatever the session or method, so no shared cache may store a token-bearing response;
 *   - `src/server/prom/block-token-transport.metrics.ts` counts the GETs that still arrive.
 *
 * WHY THEY ARE QUERIES AND NOT MUTATIONS. A tRPC query defaults to GET with the input in
 * `?input=`. Flipping these to mutations would move the token too, but it would also break every
 * already-published SDK dev host, which calls them as queries over GET. So the transport changes
 * on our side only, and GET keeps working: refusing it is a later step, gated on the GET counter
 * going flat.
 *
 * KEEP THIS COMPLETE. `src/shared/constants/__tests__/block-token-transport.constants.test.ts`
 * loads the real `appRouter` (every lazy sub-router included), finds every query whose zod input
 * has a `blockToken` key, and fails in both directions if this set drifts from it.
 */
export const BLOCK_TOKEN_QUERY_PROCEDURES: ReadonlySet<string> = new Set([
  'apps.shared.get',
  'apps.shared.getCount',
  'apps.shared.getCounts',
  'apps.shared.list',
  'apps.storage.get',
  'apps.storage.getQuota',
  'apps.storage.list',
  'blocks.listMyWorkflows',
]);

/** Whether a tRPC procedure path is a query that carries a block token in its input. */
export function isBlockTokenQueryPath(path: string | undefined | null): boolean {
  return path != null && BLOCK_TOKEN_QUERY_PROCEDURES.has(path);
}
