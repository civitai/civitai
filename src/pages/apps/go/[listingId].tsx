import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * `/apps/go/<listingId>` — the OFF-SITE VISIT redirect behind every store "Visit" link.
 *
 * Normally never renders: `getServerSideProps` either 302s to the listing's STORED external URL
 * or 404s. The decision, the recording and the open-redirect argument all live in
 * `~/server/services/blocks/app-listing-visit.service` — read its header before changing this.
 *
 * 302 (not 301/308): the destination can change when the listing is edited, and a cached
 * permanent redirect would keep sending visitors to the old address without counting them.
 */
type Props = { rateLimited?: boolean };

export const getServerSideProps = createServerSideProps<Props>({
  useSession: true,
  resolver: async ({ ctx, session, features }) => {
    const access = resolveAppsPageAccess({ features });
    if ('notFound' in access) return { notFound: true };

    const { checkAppVisitRateLimit } = await import('~/server/utils/app-visit-rate-limit');
    const limit = await checkAppVisitRateLimit({
      req: ctx.req as never,
      userId: session?.user?.id ?? null,
    });
    if (!limit.allowed) {
      ctx.res.statusCode = 429;
      ctx.res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      return { props: { rateLimited: true } };
    }

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

export default function AppListingVisitRedirect({ rateLimited }: Props) {
  // Reached only when rate-limited; every other request is redirected or 404'd server-side.
  return rateLimited ? (
    <p style={{ padding: 16 }}>Too many requests — try again in a minute.</p>
  ) : null;
}
