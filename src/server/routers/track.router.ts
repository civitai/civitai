import {
  trackActionSchema,
  trackSearchSchema,
  trackShareSchema,
  addViewSchema,
  blockRenderSchema,
  blockRenderTrackerPayload,
} from '~/server/schema/track.schema';
import { isPrivateRunImpression } from '~/server/services/blocks/private-run-impression.service';
import { publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const trackRouter = router({
  addView: publicProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(addViewSchema)
    .mutation(({ input, ctx }) => ctx.track.view(input)),
  // App Blocks Analytics Phase 2 — block render/impression. publicProcedure so
  // ANON viewers (the whole point of this event) can emit. `isAnon` is derived
  // SERVER-SIDE from the session here (`!ctx.user`) and is NOT part of the input
  // schema — a client cannot override it.
  //
  // The browser hosts (PageBlockHost / IframeHost) emit this via the lightweight
  // /api/track/block-render BEACON, not this procedure — the event fires per
  // model-page-with-a-block view + per /apps/run load, so at GA it must skip the
  // full tRPC middleware chain (mirrors the #2680 addView -> /api/track/view
  // move, which likewise left its tRPC procedure intact). This procedure is kept
  // for any bearer/API-key (non-cookie) caller, consistent with `addView`.
  blockRender: publicProcedure
    .input(blockRenderSchema)
    // `status`/`errorClass`/`secondary`/`timings` are consumed only by the
    // /api/track/block-render beacon (prom render counter + launch histograms);
    // this legacy tRPC path keeps the CH insert byte-identical by stripping them
    // before dispatch.
    //
    // 🔴 THIS IS A SECOND *CLICKHOUSE* WRITER, NOT A SECOND METRICS WRITER — the
    // asymmetry a designer trips on. This procedure increments no prom counter
    // and observes no histogram; only the REST beacon does. So the half-fix
    // hazard runs the OTHER way: a prom-only field stripped in block-render.ts
    // but not here falls through into the ClickHouse insert, and TypeScript will
    // NOT catch it — `ctx.track.blockRender({ ...renderData, isAnon })` spreads,
    // and spread properties are exempt from excess-property checking.
    //
    // `blockRenderTrackerPayload` is the shared ALLOWLIST that makes this
    // impossible to get wrong in one place and not the other.
    //
    // 🔴 BOTH WRITERS EXCLUDE PRIVATE RUNS, THROUGH THE SAME PREDICATE — and the
    // two-writer symmetry above is exactly why it is called out here as well as in the
    // beacon route. A private run of a delisted app mounts the host and so would land a
    // `blockRenders` row, surfacing in the owner's impressions and unique viewers; the
    // `block_scope_invocations` `source` marker cannot be reused, because neither of
    // these writers ever sees a block token, so the closure is a predicate over the
    // SESSION (`isPrivateRunImpression`) applied at the insert on BOTH sides. Gating
    // only the beacon would leave this procedure — reachable by a bearer/API-key caller
    // — able to reintroduce the leak, the same failure shape the allowlist above exists
    // to prevent. `block-render-writer.call-site-ledger.test.ts` fails if a writer is
    // added, removed, or stops calling it. Canonical note, why suppression rather than a
    // new ClickHouse column, the over-filtering bound and the acceptance step:
    // `src/server/services/blocks/app-views.service.ts`.
    //
    // 🔴 `secondary` additionally SUPPRESSES the insert, matching the beacon route
    // exactly. `blockRenders` counts IMPRESSIONS (one row per host mount) and its
    // rows carry no status, so a follow-up beacon for an already-reported mount
    // would write an undedupable duplicate. Both writers must agree on this or a
    // bearer/API-key caller could reintroduce the double-count the beacon route
    // prevents.
    .mutation(async ({ input, ctx }) => {
      if (input.secondary) return;
      // Same gate, same polarity as the beacon route. Derived from `ctx.user` — the
      // server-resolved session — never from `input`, which this caller chooses.
      if (await isPrivateRunImpression({ appBlockId: input.appBlockId, viewer: ctx.user })) return;
      return ctx.track.blockRender({ ...blockRenderTrackerPayload(input), isAnon: !ctx.user });
    }),
  trackShare: publicProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(trackShareSchema)
    .mutation(({ input, ctx }) => ctx.track.share(input)),
  addAction: publicProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(trackActionSchema)
    .mutation(({ input, ctx }) => ctx.track.action(input)),
  trackSearch: publicProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(trackSearchSchema)
    .mutation(({ input, ctx }) => ctx.track.search(input)),
});
