import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getLoginLink } from '~/utils/login-helpers';

type ResolverInput = {
  features?: Partial<FeatureAccess> | null;
  session?: { user?: { id: number } } | null;
  ctx: { resolvedUrl: string };
};

const loginRedirect = (resolvedUrl: string) => ({
  redirect: { destination: getLoginLink({ returnUrl: resolvedUrl }), permanent: false },
});

/**
 * The request list. With `creatorServices` off it still serves anyone with an OPEN deal (showing
 * only open deals), so a party can always find their way back to a deal's exits; everyone else 404s.
 */
export async function resolveServiceDealsListPage(
  { features, session, ctx }: ResolverInput,
  hasOpenDeal: (userId: number) => Promise<boolean>
) {
  if (!session?.user) {
    if (!features?.creatorServices) return { notFound: true as const };
    return loginRedirect(ctx.resolvedUrl);
  }
  if (features?.creatorServices) return { props: { openOnly: false } };
  return (await hasOpenDeal(session.user.id))
    ? { props: { openOnly: true } }
    : { notFound: true as const };
}

/**
 * Deliberately NOT gated on `creatorServices`: a party must reach their deal's exits after the flag
 * goes off. Who may see a deal is the deal query's call (buyer, seller or moderator).
 */
export function resolveServiceDealPage({ session, ctx }: ResolverInput) {
  if (!session?.user) return loginRedirect(ctx.resolvedUrl);
  return { props: {} };
}
