import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getLoginLink } from '~/utils/login-helpers';

type ResolverInput = {
  features?: Partial<FeatureAccess> | null;
  session?: { user?: unknown } | null;
  ctx: { resolvedUrl: string };
};

const loginRedirect = (resolvedUrl: string) => ({
  redirect: { destination: getLoginLink({ returnUrl: resolvedUrl }), permanent: false },
});

/** The request list is an entry point, so it is dark with the flag. */
export function resolveServiceDealsListPage({ features, session, ctx }: ResolverInput) {
  if (!features?.creatorServices) return { notFound: true as const };
  if (!session?.user) return loginRedirect(ctx.resolvedUrl);
  return { props: {} };
}

/**
 * Deliberately NOT gated on `creatorServices`: a party must reach their deal's exits after the flag
 * goes off. Who may see a deal is the deal query's call (buyer, seller or moderator).
 */
export function resolveServiceDealPage({ session, ctx }: ResolverInput) {
  if (!session?.user) return loginRedirect(ctx.resolvedUrl);
  return { props: {} };
}
