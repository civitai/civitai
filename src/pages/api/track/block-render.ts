import { isDev } from '~/env/other';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { Tracker } from '~/server/clickhouse/client';
import {
  ensureRegisterAppBlockRuntimeMetrics,
  normalizeErrorClass,
  normalizeSlotId,
  observeAppBlockLaunch,
} from '~/server/metrics/app-block-runtime.metrics';
import { logToAxiom } from '~/server/logging/client';
import { boundAppBlockIdLabel } from '~/server/services/blocks/known-app-blocks.service';
import { blockRenderSchema, blockRenderTrackerPayload } from '~/server/schema/track.schema';
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

    // `status`/`errorClass`/`secondary`/`timings` drive prom ONLY — none is
    // forwarded to the ClickHouse insert (the `blockRenders` table is
    // provisioned out-of-repo by the tracker service; adding columns is out of
    // scope here). `blockRenderTrackerPayload` is the shared ALLOWLIST that
    // builds the CH payload, so it stays byte-identical to the pre-change insert
    // and the OTHER writer (`track.blockRender`) cannot drift from this one.
    //
    // 🔴 `secondary` ALSO GATES THE CH INSERT ENTIRELY (see below). Every beacon
    // increments the prom counter, but only a mount's FIRST beacon writes a
    // `blockRenders` row — that table counts IMPRESSIONS, one per host mount.
    const { status, errorClass, secondary, timings } = result.data;

    // Per-app render/impression outcome (additive + dark). `result` ∈ ok|error.
    // ALL labels are BOUNDED even though the beacon body is client-supplied and
    // this route is public/ungated: `slot_id` clamps to the enumerated slot set,
    // `result` is enumerated, `error_class` clamps to the known failure set
    // ('none' on ok, else known-or-'other'), and `app_block_id` is clamped to the
    // approved-app set (unknown → 'other') via a TTL-cached in-memory lookup — no
    // per-request DB hit — so a scripted client can't blow up prom-client's heap
    // with unbounded distinct labels. Emitted AFTER the same-origin + schema
    // gates so only well-formed beacons count. Fire-and-forget: never let a
    // metrics failure break the beacon.
    try {
      const appBlockIdLabel = await boundAppBlockIdLabel(result.data.appBlockId);

      // ── UNKNOWN-APP DETECTION (observe, NEVER gate) ───────────────────────
      // `other` means the id is not in the TTL-cached approved-app set. This
      // endpoint is unauthenticated and `appBlockId` comes from the request
      // body, so an unknown id is worth seeing — see the trust caveat on
      // `app-views.service.ts`. Surfacing it costs nothing: the lookup already
      // ran for the prom label.
      //
      // 🔴 It stays a LOG, not a gate, for two independent reasons.
      // (1) `other` is ALSO the honest value for a genuinely new app inside
      //     the cache's <=5-minute TTL window — and for EVERY app if
      //     `loadKnownAppBlockIds` fails, because it fails to an empty set and
      //     caches that, so a brief DB blip would make every id look unknown.
      // (2) `blockRenders` is a fire-and-forget beacon with no status column,
      //     so a wrongly-rejected beacon makes App loads UNDER-report silently
      //     and permanently — strictly worse than over-reporting, because
      //     nothing surfaces the loss.
      // Read a rise here as a prompt to investigate, not as a count of attacks.
      if (appBlockIdLabel === 'other') {
        logToAxiom(
          {
            name: 'block-render-unknown-app',
            type: 'warning',
            message: 'block-render beacon for an id outside the approved-app set',
            slotId: result.data.slotId,
            status,
          },
          'clickhouse'
        ).catch(() => undefined);
      }

      const { rendersTotal } = ensureRegisterAppBlockRuntimeMetrics();
      rendersTotal.inc({
        app_block_id: appBlockIdLabel,
        slot_id: normalizeSlotId(result.data.slotId),
        result: status,
        error_class: normalizeErrorClass(status, errorClass),
      });

      // ── LAUNCH LATENCY ────────────────────────────────────────────────────
      // Reuses the `appBlockIdLabel` already resolved above (TTL-cached, no
      // extra DB read) and rides inside the SAME try/catch, so a launch-metric
      // failure can never affect the beacon response.
      //
      // 🔴 GATED ON `ok` AND `!secondary`, and both halves are load-bearing:
      //   - a launch-FAILURE beacon never saw BLOCK_READY, so its `total` is
      //     meaningless — and worse, a fast failure would be recorded as a FAST
      //     LAUNCH, biasing the distribution in the reassuring direction;
      //   - a `secondary` beacon is a mid-session credential-loss teardown,
      //     reported minutes after a launch that already succeeded.
      // The client also only attaches `timings` on the success path; this is the
      // server-side half of the same rule, because the body is client-supplied.
      if (status === 'ok' && !secondary) observeAppBlockLaunch(appBlockIdLabel, timings);
    } catch {
      // swallow — observability must not affect the response
    }

    // 🔴 SECONDARY (follow-up) BEACON → prom only, NO ClickHouse row. Return here,
    // AFTER the counter above and BEFORE the insert below.
    //
    // `blockRenders` is an IMPRESSION table and its rows carry no status, so one
    // mount must produce at most one row. A host now emits a SECOND beacon when an
    // outcome it already reported later changes (a page that rendered fine and
    // then lost its credential mid-session). Inserting for that would write a row
    // BYTE-IDENTICAL to the first — undedupable after the fact — silently
    // inflating `civitai_app_blocks_impressions_24h`, `renders_by_app_24h`, the
    // digest CronJob and the author-analytics tab for precisely the sessions that
    // suffered a revocation. An observability fix must not corrupt an analytics
    // series.
    //
    // 🔴 The gate is the FLAG, not `status === 'error'`. A LAUNCH failure is a
    // mount's only beacon and MUST still write its row — it is a real attempted
    // render. Only a follow-up to an already-reported mount is suppressed.
    //
    // Returning early also skips the session resolve, which the insert was the
    // only reason to pay for.
    if (secondary) return res.status(200).end();

    // Resolve the session ONCE here so we can derive isAnon, then hand it to the
    // Tracker (3rd ctor arg) so it isn't re-resolved. `isAnon` is SERVER-derived
    // (`!session?.user`) — never from the client body.
    const session = await getServerAuthSession({ req, res });
    const tracker = new Tracker(req, res, session);
    // Fire-and-forget: blockRender() dispatches the ClickHouse insert without
    // awaiting the network round-trip (same as the tRPC resolver did).
    void tracker.blockRender({
      ...blockRenderTrackerPayload(result.data),
      isAnon: !session?.user,
    });

    return res.status(200).end();
  },
  ['POST']
);
