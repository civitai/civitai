import { createServerSideHelpers } from '@trpc/react-query/server';
import type { GetServerSidePropsContext, GetServerSidePropsResult, Redirect } from 'next';
import type { Session } from '~/types/session';
import superjson from 'superjson';
import { Tracker } from '~/server/clickhouse/client';

import { appRouter } from '~/server/routers';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const getServerProxySSGHelpers = async (
  ctx: GetServerSidePropsContext,
  session: Session | null,
  features: FeatureAccess
) => {
  const domain = getRequestDomainColor(ctx.req) ?? 'blue';
  const ssg = createServerSideHelpers({
    router: appRouter,
    ctx: {
      user: session?.user,
      acceptableOrigin: true,
      features,
      track: new Tracker(),
      ip: null as any,
      res: ctx.res as any,
      cache: null as any,
      req: ctx.req as any,
      domain,
      signal: new AbortController().signal,
      tokenScope: TokenScope.Full,
      apiKeyId: undefined,
      subject: undefined,
    },
    transformer: superjson,
  });
  return ssg;
};

type SSGHelpers = Awaited<ReturnType<typeof getServerProxySSGHelpers>>;

/**
 * SSR-prefetch the universal app-shell tRPC queries so they hydrate from the
 * dehydrated `trpcState` in the page HTML instead of each firing a
 * client→CF→origin round-trip on mount (~188ms network floor per query).
 *
 * WHY THE WIN LANDS (hydration mechanics): the shared QueryClient runs with
 * `defaultOptions.queries.staleTime: Infinity` (`src/utils/trpc.ts`), and these
 * queries carry no lower per-call `staleTime`, so once React Query hydrates the
 * dehydrated entry it is never stale → NO background refetch on mount. The
 * client `useQuery(undefined)` key (path + the RAW input in the key array,
 * `[path, { input, type }]` — not a superjson string) matches the input-less
 * `.prefetch()` here exactly, so hydration hits. (The `authedCacheBypassLink`
 * mutates the WIRE input, not the react-query key, so keys still match.)
 *
 * SCOPE — only queries NOT already SSR-seeded via `initialData` in
 * `_app.getInitialProps` are prefetched here. `user.getFeatureFlags`,
 * `user.getSettings`, `user.getFollowingUsers`, `system.getLiveNow`, and
 * `chat.getUserSettings` are already seeded there; re-prefetching them would be
 * a duplicate backend call for no gain.
 *
 * All targets are input-less protected reads (session-gated on the client), so
 * they are prefetched ONLY for authenticated sessions. `buzz.getUserMultipliers`
 * additionally requires the `buzz` feature flag (its `buzzProcedure` throws
 * without it), so it is gated on `features.buzz`.
 *
 * ROBUSTNESS — best-effort via `Promise.allSettled`: a failing shell query
 * degrades to the normal client fetch, it MUST NEVER reject out of SSR and 500
 * the page.
 *
 * DEADLINE — the whole batch is `await`ed on the SSR critical path, so it is
 * bounded by `APP_SHELL_PREFETCH_TIMEOUT_MS`: on timeout we resolve (never throw)
 * and the un-prefetched queries fall back to their normal client fetch — same
 * graceful-degradation contract as a failed prefetch. Without this a slow
 * postgres/redis would add directly to TTFB on every authed full-SSR render.
 */
// Tight cap: these are input-less in-process reads that return in single-digit
// ms on the happy path, so 300ms costs nothing normally but stops a backend
// slowdown from becoming a fleet-wide authed-SSR TTFB regression.
const APP_SHELL_PREFETCH_TIMEOUT_MS = 300;

export async function prefetchAppShellQueries(
  ssg: SSGHelpers,
  session: Session | null,
  features: FeatureAccess
): Promise<void> {
  const tasks: Promise<unknown>[] = [];

  if (session?.user) {
    // Input-less, protected, static-at-load; `staleTime: Infinity` on the client
    // so the hydrated value sticks (round-trip truly saved).
    tasks.push(ssg.user.checkNotifications.prefetch());
    tasks.push(ssg.user.getBookmarkCollections.prefetch());
    // buzzProcedure = protected + `isFlagProtected('buzz')`: throws unless the
    // `buzz` flag is on, so only prefetch when it is (allSettled would swallow
    // the throw anyway, but skipping avoids a guaranteed-failed backend call).
    if (features.buzz) tasks.push(ssg.buzz.getUserMultipliers.prefetch());
  }

  if (!tasks.length) return;

  // `allSettled` never rejects and keeps handling each task even after the race
  // resolves on timeout, so a late rejection can't surface as an unhandled
  // rejection. We race it against a resolving deadline (not a rejecting one) so
  // a slow backend can't drag SSR past the cap.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, APP_SHELL_PREFETCH_TIMEOUT_MS);
  });
  try {
    await Promise.race([Promise.allSettled(tasks), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createServerSideProps<P>({
  resolver,
  useSSG,
  useSession = false,
  prefetch = 'once',
  requireModerator = false,
}: CreateServerSidePropsProps<P>) {
  return async function (
    context: GetServerSidePropsContext
  ): Promise<GetServerSidePropsResult<NonNullable<P>>> {
    const isClient = context.req.url?.startsWith('/_next/data') ?? false;
    const session =
      ((context.req as any)['session'] as Session | null) ??
      (useSession || requireModerator || !isClient ? await getServerAuthSession(context) : null);

    // Page-level moderator gate (replaces the edge route-guard — the thin hub civ-token can't resolve the full
    // user in the edge runtime). Anon → login; authed-non-moderator → home (login can't grant the permission
    // and would loop back here). Runs on SSR AND client-nav data fetches.
    if (requireModerator && !session?.user?.isModerator) {
      return {
        redirect: {
          destination: session?.user
            ? '/'
            : `/login?returnUrl=${encodeURIComponent(context.resolvedUrl)}`,
          permanent: false,
        },
      };
    }

    const features = await getFeatureFlagsAsync({ user: session?.user, req: context.req });

    const ssg =
      useSSG && (prefetch === 'always' || !isClient)
        ? await getServerProxySSGHelpers(context, session, features)
        : undefined;

    // Flag-gated SSR-prefetch of the universal app-shell queries into the shared
    // `ssg` cache so they ride down in `trpcState` (dehydrated below) and hydrate
    // instead of round-tripping on mount. Runs only when the `ssg` helper exists
    // (i.e. full SSR, or `prefetch: 'always'` — never a bare client-nav
    // `/_next/data` fetch) and the `ssrPrefetchShell` flag is on for this user.
    // Best-effort: never throws (see `prefetchAppShellQueries`).
    if (ssg && features.ssrPrefetchShell) {
      await prefetchAppShellQueries(ssg, session, features);
    }

    const result = ((await resolver?.({
      ctx: context,
      isClient,
      ssg,
      session,
      features,
    })) ?? { props: {} }) as GetPropsFnResult<NonNullable<P>>;

    if (result.redirect) return { redirect: result.redirect };
    if (result.notFound) return { notFound: result.notFound };

    // const props =  await result.props;
    const props =
      typeof result.props === 'object' && 'then' in result.props
        ? await result.props
        : result.props;

    return {
      props: {
        ...(props ?? {}),
        ...(ssg ? { trpcState: ssg.dehydrate() } : {}),
        session,
      } as NonNullable<P>,
    };
  };
}

type GetPropsFnResult<P> = {
  props: P | Promise<P>;
  redirect: Redirect;
  notFound: true;
};

type CreateServerSidePropsProps<P> = {
  useSSG?: boolean;
  useSession?: boolean;
  prefetch?: 'always' | 'once';
  /** Gate the page to moderators (replaces the edge `/moderator` route-guard). Resolves the session and
   *  redirects non-moderators before the resolver runs. */
  requireModerator?: boolean;
  resolver?: (
    context: CustomGetServerSidePropsContext
  ) => Promise<GetServerSidePropsResult<P> | void>;
};

type CustomGetServerSidePropsContext = {
  ctx: GetServerSidePropsContext;
  isClient: boolean;
  ssg?: AsyncReturnType<typeof getServerProxySSGHelpers>;
  session?: Session | null;
  features?: FeatureAccess;
  // browsingLevel: number;
};
