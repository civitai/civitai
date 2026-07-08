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
import { ChallengeSource, ChallengeStatus } from '~/shared/utils/prisma/enums';

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

/**
 * Best-effort settle of a batch of SSR prefetch tasks bounded by a deadline.
 *
 * `allSettled` never rejects and keeps handling each task even after the race
 * resolves on timeout, so a late rejection can't surface as an unhandled
 * rejection. We race it against a RESOLVING deadline (not a rejecting one) so a
 * slow backend can't drag SSR past the cap — on timeout we resolve (never throw)
 * and the un-prefetched queries fall back to their normal client fetch, the same
 * graceful-degradation contract as a failed prefetch. This is the single shared
 * safety primitive behind every SSR prefetch batch (app-shell + generator).
 */
async function settlePrefetchWithDeadline(
  tasks: Promise<unknown>[],
  timeoutMs: number
): Promise<void> {
  if (!tasks.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.allSettled(tasks), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

  await settlePrefetchWithDeadline(tasks, APP_SHELL_PREFETCH_TIMEOUT_MS);
}

/**
 * SSR-prefetch the generator page's (`/generate`) static-at-load init queries so
 * they hydrate from the dehydrated `trpcState` instead of each firing a
 * client→CF→origin round-trip on mount (~188ms network floor per query). These
 * are fired by the generation sidebar (`GenerationTabs`), which is force-open on
 * `/generate` (`GenerationSidebar`: `isGeneratePage ⇒ opened`), so unlike the
 * universal shell queries they only fire on this page — hence a page-scoped
 * prefetch in the generator GSSP resolver rather than the shared shell path.
 *
 * WHY THE WIN LANDS (hydration mechanics): the shared QueryClient runs with
 * `defaultOptions.queries.staleTime: Infinity` (`src/utils/trpc.ts`) and none of
 * these call-sites override `staleTime` lower, so once React Query hydrates the
 * dehydrated entry it is never stale → NO background refetch on mount. Each
 * prefetch input is reproduced to EXACTLY match the client `useQuery` key.
 *
 * TARGETS (verified against the current call-sites):
 *  - `user.userRewardDetails` — input-less protected read (`useDailyBoostReward`
 *    in `generation_v2/GenerationLayout`, `useQuery(undefined)`); session-gated.
 *  - `generationPreset.getOwn` — input-less protected read (`PresetHeaderButton`,
 *    `useQuery(undefined)`), rendered only when `features.generationPresets` is on
 *    (`GenerationTabs`), so gated on that flag.
 *  - `challenge.getInfinite` — `publicProcedure` `useQuery` with the STATIC input
 *    below (`useGetActiveChallenges` → `ChallengeIndicator`), rendered only when
 *    `features.challengePlatform` is on, so gated on that flag. The input must be
 *    the exact object the client passes or the react-query key won't match and
 *    the round-trip isn't saved.
 *
 * EXCLUDED — `orchestrator.whatIfFromGraph`: its input depends on client-side
 * generation-graph state (selected resources / params) that does not exist
 * server-side, so prefetching it would compute a wrong/irrelevant cost estimate.
 * It stays client-side. Also excluded: the `Challenge/` `useInfiniteQuery` variant
 * of `challenge.getInfinite` (different key + `browsingLevel` client state) — it
 * is NOT the generator call-site.
 *
 * ROBUSTNESS + DEADLINE — best-effort via `settlePrefetchWithDeadline`: a failing
 * or slow query degrades to the normal client fetch and can NEVER reject out of
 * SSR or drag it past `GENERATOR_PREFETCH_TIMEOUT_MS`. The generator is a money
 * path — the flag-OFF path adds ZERO cost and the flag-ON path is pure best-effort
 * hydration that can neither block, slow, nor error the page render.
 */
// The static input the generator's active-challenges widget (`useGetActiveChallenges`,
// `src/components/Challenges/challenge.utils.ts`) passes to `challenge.getInfinite`.
// Reproduced verbatim so the SSR prefetch key matches the client `useQuery` key.
// Not `as const`: the client passes a plain object literal (mutable arrays), and
// `.prefetch()` requires the same mutable-array input type. Runtime values are
// identical either way — the react-query key match is by value, not TS type.
const GENERATOR_ACTIVE_CHALLENGES_INPUT = {
  status: [ChallengeStatus.Active],
  source: [ChallengeSource.System],
  excludeEventChallenges: true,
  limit: 2,
};

const GENERATOR_PREFETCH_TIMEOUT_MS = 300;

export async function prefetchGeneratorQueries(
  ssg: SSGHelpers,
  session: Session | null,
  features: FeatureAccess
): Promise<void> {
  // All targets are session-scoped (the page redirects anon users anyway).
  if (!session?.user) return;

  const tasks: Promise<unknown>[] = [];

  // Input-less protected read, fires for every authed generator load.
  tasks.push(ssg.user.userRewardDetails.prefetch());
  // Input-less protected read; the trigger renders only under this flag.
  if (features.generationPresets) tasks.push(ssg.generationPreset.getOwn.prefetch());
  // publicProcedure with a static input; the widget renders only under this flag.
  if (features.challengePlatform)
    tasks.push(ssg.challenge.getInfinite.prefetch({ ...GENERATOR_ACTIVE_CHALLENGES_INPUT }));

  await settlePrefetchWithDeadline(tasks, GENERATOR_PREFETCH_TIMEOUT_MS);
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
