import type { GetServerSidePropsContext } from 'next';
import type { NextApiRequest, NextApiResponse } from 'next';

import { Tracker } from '~/server/clickhouse/client';
import type { Session } from '~/types/session';

/**
 * App store PLAY recording — one `App_Open` row per on-site app launch.
 *
 * 🔴 WHY THIS IS A SERVER-SIDE EMIT AND NOT A BEACON. The count it feeds is printed on a
 * PUBLIC store card next to the review count, so it has to be one a script cannot cheaply
 * manufacture. `App_Open` is therefore deliberately absent from `trackActionSchema` — the
 * schema `/api/track/batch` accepts from a browser — following `BuzzLimit_Set` and the
 * announcement mute pair. The only writer is this function, called from the
 * `/apps/run/<slug>` SSR resolver, i.e. from a request the server itself served after the
 * flag gate and the approved-app resolution both passed.
 *
 * 🔴 THAT CLOSES THE POST CHANNEL, NOT THE WHOLE PROBLEM — AND THE DIFFERENCE IS STAGE 2'S
 * TO CLOSE, NOT THIS FILE'S. The write is still triggered by a plain, unauthenticated
 * `GET /apps/run/<slug>`, and:
 *   - the route is an optional catch-all, so `/apps/run/<slug>/1`, `/2`, … are distinct
 *     URLs that each record a play for the same app — no CDN cache, no URL-level dedup;
 *   - there is no per-route rate limit, and `robots.txt` does not disallow `/apps/run/*`,
 *     so a crawler or a chat-client link unfurler records a play per fetch (the page's
 *     `deIndex` only takes effect AFTER the fetch that reads it);
 *   - nothing dedups at write time.
 * Today this is contained because both `appBlocks` and `appBlocksPages` are moderator-only,
 * so the reachable population is tiny. It stops being contained the moment those flags
 * widen — which is the plan.
 * 🔴 **SO STAGE 2 MUST DEDUPE AT READ TIME; the counter is not honest without it.** Actor
 * metadata is kept below precisely so it can (collapse per `userId`, falling back to `ip`,
 * over a window). If you are writing the rollup and this paragraph is still here, that
 * obligation is still open.
 *
 * 🔴 RECOMPUTABILITY HAS ONE HOLE, NAMED RATHER THAN LEFT TO BE DISCOVERED. These rows are
 * an event stream so `open_count` can always be recomputed — that is why this arc does not
 * use a `+1` counter. But the recompute joins `details.appBlockId` to
 * `AppListing.appBlockId`, and that relation is `onDelete: SetNull`: deleting an `AppBlock`
 * nulls the listing's `app_block_id` and every historical row for it becomes permanently
 * unjoinable. Rarer trigger, same unrepairable-drift outcome the `+1` counter was rejected
 * for. If that becomes a real case, carry the listing id in `details` as well.
 *
 * 🔴 WHAT THIS DOES **NOT** COVER, stated here because the gap is invisible from the
 * store card: OFF-SITE listings. Their CTA is a plain `target="_blank"` anchor to a third
 * party, so no on-platform request follows the click and there is nothing trustworthy to
 * record. An off-site listing's play count is therefore structurally 0, not "0 so far" —
 * do not read the two as the same number, and do not "fix" it with a client beacon, which
 * would put a spoofable count beside a trusted one under one label.
 *
 * 🔴 FIRE-AND-FORGET, AND IT MUST STAY THAT WAY. This sits on the app-LAUNCH critical
 * path, which the run route's own resolver comment already protects (its two listing
 * reads run concurrently rather than serially for exactly this reason). Awaiting a
 * ClickHouse insert here would put the tracker's latency — and its failures — in front of
 * every app launch. So: never awaited by the caller, and every error is swallowed.
 */

/** The subset of the SSR context this needs. Narrow on purpose — it is called from one place. */
export type AppOpenRequestContext = Pick<GetServerSidePropsContext, 'req' | 'res'>;

/**
 * Record one play of an on-site app.
 *
 * `appBlockId` rather than the listing id: the run route already has it in scope, so this
 * adds NO query to the launch path, and `AppListing.appBlockId` is `@unique` so the rollup
 * can join it back to exactly one listing. It is also a pure id — `details` never carries
 * author-supplied text.
 *
 * Returns a promise so tests can await it; production callers must not.
 */
export async function recordAppListingOpen({
  appBlockId,
  session,
  ctx,
}: {
  appBlockId: string;
  session: Session | null;
  ctx: AppOpenRequestContext;
}): Promise<void> {
  try {
    // Passing the already-resolved session skips the Tracker's own
    // `getServerAuthSession` round trip — the resolver has it in hand, and an ANONYMOUS
    // launch would otherwise re-run a full JWE decrypt (see the Tracker constructor note).
    const tracker = new Tracker(
      ctx.req as unknown as NextApiRequest,
      ctx.res as unknown as NextApiResponse,
      session
    );
    // Actor metadata is KEPT (no `skipActorMeta`): a launch is an interaction, not a
    // private judgement, and `userId`/`ip` are what let the rollup collapse a refresh loop
    // into one play at read time instead of trusting the raw row count.
    await tracker.action({ type: 'App_Open', details: { appBlockId } });
  } catch {
    // Swallowed deliberately — see the fire-and-forget note above. A play that goes
    // unrecorded is a slightly low number; a throw here is a failed app launch.
  }
}
