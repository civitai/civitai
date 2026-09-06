import type { GetServerSidePropsContext } from 'next';
import type { NextApiRequest, NextApiResponse } from 'next';

import { Tracker } from '~/server/clickhouse/client';
import type { Session } from '~/types/session';

/**
 * App store PLAY recording — one `App_Open` row per on-site app launch.
 *
 * 🔴 WHY THIS IS A SERVER-SIDE EMIT AND NOT A BEACON, WHICH IS THE WHOLE POINT OF THE
 * NUMBER. The count it feeds is printed on a PUBLIC store card next to the review count,
 * so it has to be one a script cannot manufacture. `App_Open` is therefore deliberately
 * absent from `trackActionSchema` — the schema `/api/track/batch` accepts from a browser —
 * following `BuzzLimit_Set` and the announcement mute pair. The only writer is this
 * function, called from the `/apps/run/<slug>` SSR resolver, i.e. from a request the
 * server itself served after the flag gate and the approved-app resolution both passed.
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
