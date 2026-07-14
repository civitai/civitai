import { isDev } from '~/env/other';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { Tracker } from '~/server/clickhouse/client';
import {
  ensureRegisterAppBlockRuntimeMetrics,
  normalizeSlotId,
} from '~/server/metrics/app-block-runtime.metrics';
import { blockRenderSchema } from '~/server/schema/track.schema';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

// App Blocks Analytics Phase 2 — block render/impression beacon.
//
// Lightweight beacon endpoint for the block render/impression event, mirroring
// the sibling /api/track/view beacon (#2680). This event fires once per host
// mount at BLOCK_READY for EVERY model-page-with-a-block view and every
// /apps/run page load — so at GA it's a high-volume, fire-and-forget telemetry
// write that must NOT pay the full non-batched tRPC middleware chain
// (recordProcedureDuration -> isAcceptableOrigin -> enforceClientVersion[sysRedis]
// -> applyDomainFeature[Flipt] -> enforceTokenScope) + superjson encode per call.
// This route runs none of that — it resolves the session once, derives `isAnon`
// SERVER-SIDE, and fires the identical `blockRenders` ClickHouse insert.
//
// EVENT GRANULARITY: this emits ONE row PER HOST MOUNT. A tab-switch or
// model-navigation remount re-fires it, so the same viewer can produce multiple
// rows for the "same" block view. Consumers computing "unique views" MUST dedup
// in-query (e.g. by viewer/session over a window), not treat each row as unique.
//
// SECURITY: the client supplies ONLY the three identifiers in blockRenderSchema
// (appBlockId/blockInstanceId/slotId); the non-strict object STRIPS any
// client-smuggled `isAnon`/`userId`. `isAnon` is derived here from the resolved
// session (`!session?.user`) and `userId` is stamped by the Tracker from the
// actor — neither is ever taken from the request body.
export default PublicEndpoint(
  async (req, res) => {
    if (isDev) return res.status(200).end();

    // Same-origin guard (mirrors /api/internal/pulse). Origin preferred, referer
    // fallback for clients that suppress Origin.
    const source = req.headers.origin ?? req.headers.referer;
    const sourceHost = source
      ? (() => {
          try {
            return new URL(source).host;
          } catch {
            return undefined;
          }
        })()
      : undefined;
    if (!sourceHost || sourceHost !== req.headers.host)
      return res.status(400).send('invalid request');

    // Next's body parser deserializes an `application/json` body into an object
    // (the client beacon sends that Content-Type), but a Content-Type-less
    // (text/plain) client leaves it a raw string. Handle BOTH — JSON.parse(<object>)
    // would throw and 400 every real browser beacon (see the #2680 view.ts fix).
    let parsed: unknown;
    try {
      parsed = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).send('invalid body');
    }

    // Strips any client-sent isAnon/userId (non-strict object) and bounds the
    // identifier lengths.
    const result = blockRenderSchema.safeParse(parsed);
    if (!result.success) return res.status(400).send('invalid input');

    // `status`/`errorClass` drive the prom render counter ONLY — they are NOT
    // forwarded to the ClickHouse insert (the `blockRenders` table is provisioned
    // out-of-repo by the tracker service; adding columns is out of scope here).
    // Strip them so the CH payload stays byte-identical to the pre-change insert.
    const { status, errorClass: _errorClass, ...renderData } = result.data;

    // Per-app render/impression outcome (additive + dark). `result` ∈ ok|error.
    // `slot_id` is clamped to the enumerated slot set (unknown → 'other');
    // `app_block_id` is client-supplied here (same trust level as the CH insert)
    // — see the cardinality-budget note in app-block-runtime.metrics. Emitted
    // AFTER the same-origin + schema gates so only well-formed beacons count.
    // Fire-and-forget: never let a metrics failure break the beacon.
    try {
      const { rendersTotal } = ensureRegisterAppBlockRuntimeMetrics();
      rendersTotal.inc({
        app_block_id: renderData.appBlockId,
        slot_id: normalizeSlotId(renderData.slotId),
        result: status,
      });
    } catch {
      // swallow — observability must not affect the response
    }

    // Resolve the session ONCE here so we can derive isAnon, then hand it to the
    // Tracker (3rd ctor arg) so it isn't re-resolved. `isAnon` is SERVER-derived
    // (`!session?.user`) — never from the client body.
    const session = await getServerAuthSession({ req, res });
    const tracker = new Tracker(req, res, session);
    // Fire-and-forget: blockRender() dispatches the ClickHouse insert without
    // awaiting the network round-trip (same as the tRPC resolver did).
    void tracker.blockRender({ ...renderData, isAnon: !session?.user });

    return res.status(200).end();
  },
  ['POST']
);
