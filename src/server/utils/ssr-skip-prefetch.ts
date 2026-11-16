import type { GetServerSidePropsContext } from 'next';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { Session } from '~/types/session';
import { isNextDataRequest } from '~/server/utils/next-data-request';
import { parseVerifiedBotHeader, VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import { BOT_CACHE_REQ_KEY } from '~/shared/constants/bot-cache.constants';
import type { SsrPrefetchCohort } from '~/shared/constants/ssr-prefetch-cohort.constants';
import {
  SSR_PREFETCH_COHORT_REQ_KEY,
  SSR_PREFETCH_ROUTE_REQ_KEY,
} from '~/shared/constants/ssr-prefetch-cohort.constants';

type CohortRequest = GetServerSidePropsContext['req'] & {
  [SSR_PREFETCH_COHORT_REQ_KEY]?: SsrPrefetchCohort;
  [SSR_PREFETCH_ROUTE_REQ_KEY]?: string;
  [BOT_CACHE_REQ_KEY]?: string;
};

/**
 * The `ssrSignedInSkipPrefetch` arm a page request is in, or `null` when it is outside the trial
 * and must get the full server render. A page adopts the trial by calling this from its
 * `getServerSideProps` once its 404, access and redirect decisions are made — so a request that
 * ends in one of those is never counted — and, on `skip`, by issuing only the prefetches those
 * decisions needed and rendering its content as a loading shell until the client has mounted.
 *
 * Outside the trial:
 * - no signed-in user: anonymous visitors (and so crawlers) keep the full render, so SEO is unchanged;
 * - a `/_next/data` request: it renders no HTML, so there is no render CPU to save;
 * - a verified bot, or a request `_app` marked as a bot-cache candidate: their render may be served
 *   to others, and must not depend on a per-user rollout.
 *
 * Marks the request with the arm and `route` (the page's own pattern), so the getServerSideProps CPU
 * counter (`createServerSideProps`) and `_document`'s render-CPU counter can split the two arms.
 */
export function resolveSsrPrefetchCohort({
  ctx,
  session,
  features,
  route,
}: {
  ctx: Pick<GetServerSidePropsContext, 'req'>;
  /** The page pattern, e.g. `/models/[id]/[[...slug]]` — never the URL. */
  route: string;
  session?: Session | null;
  features?: FeatureAccess;
}): SsrPrefetchCohort | null {
  const req = ctx.req as CohortRequest;
  if (!session?.user) return null;
  if (isNextDataRequest(req as never)) return null;
  if (parseVerifiedBotHeader(req.headers[VERIFIED_BOT_HEADER])) return null;
  if (req[BOT_CACHE_REQ_KEY]) return null;
  const cohort: SsrPrefetchCohort = features?.ssrSignedInSkipPrefetch ? 'skip' : 'full';
  req[SSR_PREFETCH_COHORT_REQ_KEY] = cohort;
  req[SSR_PREFETCH_ROUTE_REQ_KEY] = route;
  return cohort;
}
