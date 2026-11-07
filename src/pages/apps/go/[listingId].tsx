import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * `/apps/go/<listingId>` — the OFF-SITE VISIT redirect behind every store "Visit" link.
 *
 * Never renders: `getServerSideProps` either 302s to the listing's STORED external URL or 404s.
 * The decision, the recording and the open-redirect argument all live in
 * `~/server/services/blocks/app-listing-visit.service` — read its header before changing this.
 *
 * Gating, in order, each failing to the same 404:
 *   1. `resolveAppsPageAccess` — the same store page gate the listing detail page applies;
 *   2. the listing must pass the detail read's own visibility gate for this viewer (store scope,
 *      audience floor, host, browsing level), be OFF-SITE and carry an https destination.
 *
 * 302 (not 301/308): the destination can change when the listing is edited, and a cached
 * permanent redirect would keep sending visitors to the old address without counting them.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx, session, features }) => {
    const access = resolveAppsPageAccess({ features });
    if ('notFound' in access) return { notFound: true };

    const { resolveAppListingVisit } = await import(
      '~/server/services/blocks/app-listing-visit.service'
    );
    const visit = await resolveAppListingVisit({
      listingId: ctx.params?.listingId,
      query: ctx.query,
      session,
      features,
      ctx: { req: ctx.req, res: ctx.res },
    });
    if (!visit) return { notFound: true };
    // `visit.recorded` is deliberately NOT awaited: recording never sits in front of the hop.
    return { redirect: { destination: visit.destination, statusCode: 302 } };
  },
});

export default function AppListingVisitRedirect() {
  // Unreachable: every request is redirected or 404'd server-side.
  return null;
}
