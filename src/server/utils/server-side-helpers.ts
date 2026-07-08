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
import {
  ChallengeSource,
  ChallengeStatus,
  MediaType,
  MetricTimeframe,
} from '~/shared/utils/prisma/enums';
import { ImageSort } from '~/server/common/enums';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import type { ImageInclude } from '~/server/schema/image.schema';

export const getServerProxySSGHelpers = async (
  ctx: GetServerSidePropsContext,
  session: Session | null,
  features: FeatureAccess,
  // Optional real AbortController whose `.signal` becomes the SSG procedure ctx
  // signal. Threaded in so a prefetch can be cancelled on a deadline (see the
  // images-feed prefetch, which fires `abort()` on timeout to release the heavy
  // bulkhead slot early). When omitted, a fresh never-fired controller is used —
  // byte-compatible with the prior behavior for the shell/generator callers,
  // which never abort.
  abortController: AbortController = new AbortController()
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
      signal: abortController.signal,
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
 * safety primitive behind every SSR prefetch batch (app-shell + generator + images).
 *
 * `onDeadline` (optional): fired ONCE if — and only if — the deadline wins the
 * race (the tasks had not all settled in time). Omitted by the shell/generator
 * callers (their tasks are cheap in-process reads that need no cancellation), so
 * their behavior is unchanged. The images-feed caller passes it to `abort()` the
 * SSG signal on timeout, which cancels the in-flight heavy `image.getInfinite`
 * Meili query and releases its per-pod bulkhead slot early (the handler honors
 * `ctx.signal`; the `withBulkhead` middleware releases the slot in a `finally`
 * on handler settle) instead of holding the slot for the query's full duration.
 * `allSettled` still captures the resulting late rejection, so no unhandled
 * rejection escapes.
 */
async function settlePrefetchWithDeadline(
  tasks: Promise<unknown>[],
  timeoutMs: number,
  onDeadline?: () => void
): Promise<void> {
  if (!tasks.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([Promise.allSettled(tasks), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    // Fire the cancellation hook only when the deadline actually elapsed (tasks
    // still pending) — never when the tasks settled first.
    if (timedOut) onDeadline?.();
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

/**
 * SSR-prefetch the `/images` feed page's INITIAL `image.getInfinite` query so it
 * hydrates from the dehydrated `trpcState` instead of firing a client→CF→origin
 * round-trip on mount (~188ms network floor). Unlike the shell/generator
 * prefetches (cheap, input-less reads), this targets a `heavyProcedure`
 * (bulkhead-slotted) feed query — the page's first and most expensive fetch — so
 * a mismatched prefetch is not just wasted, it burns a scarce heavy slot. That
 * makes the EXACT react-query key match the whole game.
 *
 * 🔴 ANON-ONLY. The client's initial input (`ImagesInfinite` → `useQueryImages`)
 * is derived from three client-only sources: (1) the FiltersProvider store
 * (localStorage, NOT server-readable), (2) a 3-provider `browsingLevel` chain,
 * and (3) DB-resolved browsing-settings-addons. For an ANONYMOUS request all of
 * these collapse to deterministic, server-reproducible values:
 *   - `browsingLevel` → `publicBrowsingLevelsFlag` on EVERY domain: anon has no
 *     user, so `BrowsingLevelProvider`'s `domainForcedLevel` forces public, and
 *     the green-domain `capToPublic` intersection with the same flag is
 *     idempotent. (`useBrowsingLevelDebounced` returns it verbatim, non-zero.)
 *   - filters → the FiltersProvider `imageFilterSchema` defaults (empty anon
 *     localStorage parses to these): `{ period: Week, sort: MostReactions,
 *     types: [image], withMeta: false }`. `removeEmpty` keeps `withMeta: false`
 *     (not nil) and the non-empty `types` array, so both are in the key.
 *   - `excludedTagIds` / `disablePoi` / `disableMinor` → `resolveBrowsingSettingsAddons`
 *     run against the SAME addon data the client sees (its provider `initialData`
 *     comes from `getBrowsingSettingAddons()` in `_app.getInitialProps`), at
 *     `publicBrowsingLevelsFlag`, `isModerator: false`. At PG this yields
 *     `disablePoi: true`, `disableMinor: false`, and the real-person tag list —
 *     reproduced verbatim (array ORDER matters for the react-query hash).
 * `include: ['cosmetics']` is the constant `ImagesInfinite` passes. `limit`/`cursor`
 * are NOT in the client's raw infinite-query key (server zod defaults them for the
 * handler only), so they are omitted here — `prefetchInfinite` builds the same key.
 *
 * Authed requests are intentionally NOT prefetched: their localStorage filters +
 * saved browsing level can diverge from any server guess, and a mismatch on a
 * heavy query is pure cost. They fall through to the unchanged client fetch.
 *
 * WHY THE WIN LANDS: the shared QueryClient runs `staleTime: Infinity`
 * (`src/utils/trpc.ts`) and this call-site sets no lower `staleTime`, so once the
 * dehydrated infinite entry hydrates it is never stale → no refetch on mount.
 *
 * QUERY-PARAM GUARD — the reproduced input above is ONLY the client's key for
 * the BARE default feed. `/images?period=Month` / `?tags=…` / `?sort=…` / etc.
 * make the client's `useImageFilters('images')` merge those URL params into the
 * feed input → a DIFFERENT infinite-query key → a guaranteed key miss + a burned
 * heavy slot. So we skip the prefetch when the request carries ANY feed-affecting
 * query param (the `imagesQueryParamSchema` set). Unrecognized params (utm_*,
 * fbclid, …) are stripped by the client's zod parse and don't change the key, so
 * they do NOT block the prefetch — a default feed opened from a shared/referral
 * link (a high-value anon cohort) still hydrates.
 *
 * ROBUSTNESS + DEADLINE — best-effort via `settlePrefetchWithDeadline`: a failing
 * or >300ms-slow feed query degrades to the normal client fetch and can NEVER
 * reject out of SSR or drag it past the cap. On the deadline we `abort()` the SSG
 * signal (Fix, wired via the `abortController`), which cancels the in-flight heavy
 * `image.getInfinite` Meili query and releases its per-pod bulkhead slot early
 * rather than holding it for the full query duration. If the addon fetch fails we
 * skip the prefetch entirely (prefetching with the wrong `excludedTagIds` would
 * miss the key AND waste a heavy slot — worse than not prefetching).
 */
// Reproduces the FiltersProvider `imageFilterSchema` defaults (client storeFilters
// for a default anon) verbatim — the values `useImageFilters('images')` yields
// before merge. Kept as an explicit literal (the schema isn't exported) so the
// react-query key match is auditable against `src/providers/FiltersProvider.tsx`.
const IMAGES_FEED_DEFAULT_FILTERS = {
  period: MetricTimeframe.Week,
  sort: ImageSort.MostReactions,
  types: [MediaType.image],
  withMeta: false,
};

// The URL query params the images feed reads into its infinite-query input.
// MUST mirror `imagesQueryParamSchema` in `src/components/Image/image.utils.ts`
// (that module is client-heavy — mantine/trpc/react — so we enumerate the keys
// here rather than import it into this server module). If a key is added to that
// schema, add it here too; over-listing is safe (skipping is free), under-listing
// risks a wasted heavy prefetch on a non-default feed. `view`/`section` are
// UI-ish but still flow into the client's raw feed input, so they gate too.
const IMAGES_FEED_QUERY_PARAM_KEYS = new Set<string>([
  'baseModels', 'collectionId', 'collectionTagId', 'hideAutoResources',
  'hideManualResources', 'followed', 'fromPlatform', 'hidden', 'includeBaseModel',
  'limit', 'modelId', 'modelVersionId', 'notPublished', 'publishedOnly',
  'pendingReviewOnly', 'period', 'periodMode', 'postId', 'prioritizedUserIds',
  'reactions', 'scheduled', 'section', 'sort', 'tags', 'techniques', 'tools',
  'types', 'userId', 'username', 'view', 'withMeta', 'requiringMeta', 'remixOfId',
  'includePG13', 'poiOnly', 'minorOnly', 'disablePoi', 'disableMinor',
  'remixesOnly', 'nonRemixesOnly',
]);

/** True when the request URL carries any feed-affecting param (→ a non-default key). */
export function hasImagesFeedQueryParams(query: Record<string, unknown> | undefined): boolean {
  if (!query) return false;
  for (const key of Object.keys(query)) {
    if (IMAGES_FEED_QUERY_PARAM_KEYS.has(key)) return true;
  }
  return false;
}

const IMAGES_FEED_PREFETCH_TIMEOUT_MS = 300;

export async function prefetchImagesFeedQueries(
  ssg: SSGHelpers,
  session: Session | null,
  query: Record<string, unknown> | undefined,
  // Real controller backing the SSG `ctx.signal` (from `getServerProxySSGHelpers`
  // via `createServerSideProps`). Aborted on the deadline to release the heavy
  // bulkhead slot early. Optional so the helper is unit-testable in isolation.
  abortController?: AbortController
): Promise<void> {
  // ANON-ONLY: authed inputs are not server-reproducible (see doc above).
  if (session?.user) return;
  // Only the BARE default feed's key is reproducible — skip any filtered variant.
  if (hasImagesFeedQueryParams(query)) return;

  // Deterministic anon browsing level on every domain. This MIRRORS
  // `BrowsingLevelProvider`'s anon path (src/components/BrowsingLevel/…): with no
  // `currentUser`, `domainForcedLevel` forces `publicBrowsingLevelsFlag` on green
  // AND blue/red, and the green `capToPublic` intersection with the same flag is
  // idempotent — so it is domain-independent. 🔴 If that anon rule ever becomes
  // domain-dependent, this constant silently breaks the key match; re-derive it
  // from the request domain here at that point.
  const browsingLevel = publicBrowsingLevelsFlag;

  // Resolve the browsing-settings addons against the SAME data the client sees.
  // Lazy import so the server-only system-cache (redis) module isn't pulled at
  // top-level (keeps the module importable in isolation / other prefetch tests).
  // Best-effort: on any failure, skip the prefetch rather than fire it with a
  // wrong `excludedTagIds` that would miss the key and waste a heavy slot.
  let addons;
  try {
    const { getBrowsingSettingAddons } = await import('~/server/services/system-cache');
    const data = await getBrowsingSettingAddons();
    addons = resolveBrowsingSettingsAddons(data, browsingLevel, { isModerator: false });
  } catch {
    return;
  }

  // Reproduce EXACTLY the input `useQueryImages` builds for a default anon:
  //   { ...filters, browsingLevel, include: ['cosmetics'], excludedTagIds,
  //     disablePoi, disableMinor }
  // (anon: filters.excludedTagIds/disablePoi/disableMinor are unset, so they come
  //  solely from the resolved addons; isOwnImages is false so addon tags apply.)
  const input = {
    ...IMAGES_FEED_DEFAULT_FILTERS,
    browsingLevel,
    include: ['cosmetics'] as ImageInclude[],
    excludedTagIds: addons.excludedTagIds,
    disablePoi: addons.disablePoi,
    disableMinor: addons.disableMinor,
  };

  await settlePrefetchWithDeadline(
    [ssg.image.getInfinite.prefetchInfinite(input as any)],
    IMAGES_FEED_PREFETCH_TIMEOUT_MS,
    // On timeout, cancel the in-flight heavy query so its bulkhead slot frees now
    // instead of at the query's natural completion (the deadline already gave up
    // on hydrating it, so aborting loses nothing hydratable — pure slot savings).
    () => abortController?.abort()
  );
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

    // Real controller backing the SSG procedure `ctx.signal`, so a page prefetch
    // can cancel its in-flight query on a deadline (see the images-feed prefetch).
    // Created only when we build an SSG helper; exposed to the resolver below.
    const ssgAbortController = new AbortController();
    const ssg =
      useSSG && (prefetch === 'always' || !isClient)
        ? await getServerProxySSGHelpers(context, session, features, ssgAbortController)
        : undefined;

    // Flag-gated SSR-prefetch of the universal app-shell queries into the shared
    // `ssg` cache so they ride down in `trpcState` (dehydrated below) and hydrate
    // instead of round-tripping on mount. Runs only when the `ssg` helper exists
    // (i.e. full SSR, or `prefetch: 'always'` — never a bare client-nav
    // `/_next/data` fetch) and the `ssrPrefetchShell` flag is on for this user.
    //
    // Kicked off WITHOUT awaiting so it overlaps the resolver (which may itself
    // run a page-scoped prefetch, e.g. the generator's — DISJOINT keys, no race):
    // two best-effort 300ms-capped batches run CONCURRENTLY instead of serially,
    // so worst-case added TTFB is ~max(300, resolver) rather than shell+resolver.
    // We `await` it only right before `dehydrate()` (past the redirect/notFound
    // early-returns), so a redirect/notFound path never blocks on it. Best-effort:
    // `prefetchAppShellQueries` never rejects (allSettled + deadline), so an
    // abandoned promise on an early-return can't surface as an unhandled rejection.
    const shellPrefetch =
      ssg && features.ssrPrefetchShell
        ? prefetchAppShellQueries(ssg, session, features)
        : undefined;

    const result = ((await resolver?.({
      ctx: context,
      isClient,
      ssg,
      session,
      features,
      // Only meaningful when `ssg` exists; a page prefetch fires `.abort()` on its
      // deadline to release a heavy bulkhead slot early.
      ssgAbortController: ssg ? ssgAbortController : undefined,
    })) ?? { props: {} }) as GetPropsFnResult<NonNullable<P>>;

    if (result.redirect) return { redirect: result.redirect };
    if (result.notFound) return { notFound: result.notFound };

    // const props =  await result.props;
    const props =
      typeof result.props === 'object' && 'then' in result.props
        ? await result.props
        : result.props;

    // Ensure the in-flight shell prefetch has settled (or hit its 300ms deadline)
    // before we snapshot the cache — it overlapped the resolver, so this rarely
    // adds wall-time. Only on the render path (past the early-returns above).
    if (shellPrefetch) await shellPrefetch;

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
  /** Backs the SSG `ctx.signal`; a page prefetch aborts it on its deadline to free a heavy slot early. */
  ssgAbortController?: AbortController;
  // browsingLevel: number;
};
