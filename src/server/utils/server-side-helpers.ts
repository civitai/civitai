import { createServerSideHelpers } from '@trpc/react-query/server';
import type {
  GetServerSidePropsContext,
  GetServerSidePropsResult,
  NextApiRequest,
  Redirect,
} from 'next';
import type { Session } from '~/types/session';
import { jsonSafeSession } from '~/server/utils/session-props';
import { Tracker } from '~/server/clickhouse/client';
import { unionTransformer } from '~/shared/utils/trpc-union-transformer';
import {
  runWithSerializeCtxAlways,
  ssrDehydrateSerializePath,
} from '~/server/logging/trpc-serialize-log';

import { appRouter } from '~/server/routers';
import { isAdGatedContent } from '~/shared/utils/ad-gating';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { getRequestCredential } from '~/server/auth/request-credential';
import { requestCarriesQueryToken } from '~/server/utils/request-query-token';
import { isFullScopeSession } from '~/server/utils/require-full-scope-session';

export const getServerProxySSGHelpers = async (
  // A page's gSSP context, or an API route's request/response (`/api/page-data/*`).
  ctx: { req: GetServerSidePropsContext['req']; res: GetServerSidePropsContext['res'] },
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
      ...getRequestCredential(ctx.req),
    },
    // Phase 2 of the superjson → devalue migration: SSR runs server-side, so its
    // dehydrate WRITE goes through the env-gated server writer (`unionTransformer`
    // = `buildTransformer()` = `serverWriteSerialize`). It flips to devalue only
    // when THIS pool's Deployment sets `TRPC_WRITE_DEVALUE=true`; otherwise it
    // writes superjson exactly as in Phase 1. The client that hydrates decodes
    // either format through the union READ. SSR HTML and the JS chunks it
    // references are the same content-hashed deploy, so dehydrate/hydrate is
    // inherently version-matched. See src/shared/utils/trpc-union-transformer.ts.
    //
    // Deliberately NOT the per-request client check the /api/trpc route uses
    // (src/server/trpc/response-write-format.ts): a page navigation carries no
    // `x-client` headers, and the only reader of this state is the same-deploy
    // bundle (a stale tab's `/_next/data` fetch is a buildId mismatch, which Next
    // turns into a full reload), so the client check would only switch SSR to
    // superjson without protecting anyone.
    transformer: unionTransformer,
  });
  return ssg;
};

type SsgHelpers = Awaited<ReturnType<typeof getServerProxySSGHelpers>>;

/**
 * `adsGated` from a resolver's declared rating. `.red` is exempt from the rating check — it serves
 * direct ads, no GAM auction, no policy center.
 */
export function resolveAdsGated(
  result: { gating?: AdGatingDeclaration; suppressAds?: boolean },
  features: FeatureAccess
) {
  return (
    !!result.suppressAds ||
    (!!result.gating && !features.canViewNsfw && isAdGatedContent(result.gating))
  );
}

/**
 * The `trpcState` a page hands the client.
 *
 * Success-only: an errored prefetch would put a TRPCError instance in the dehydrated state, and
 * the devalue write (TRPC_WRITE_DEVALUE) throws on non-POJOs — turning one failed prefetch into a
 * page-wide SSR 500. Dropping errored queries lets the client refetch instead.
 *
 * Seed the serialize-attribution ctx (kill-switch-independent — this is the once-per-render SSR
 * path, not the hot tRPC batch path) with the route so a devalue-write fallback during dehydrate
 * attributes to it (`ssr:dehydrate:<route>`) instead of `unknown`.
 */
export function dehydrateSsgState(ssg: SsgHelpers, url: string | undefined) {
  return runWithSerializeCtxAlways({ path: ssrDehydrateSerializePath(url), type: 'ssr' }, () =>
    ssg.dehydrate({
      shouldDehydrateQuery: (query) => query.state.status === 'success',
    })
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
    // A client-side navigation fetches its props from `/_next/data/<build>/<locale>/<path>.json`, but
    // Next rewrites a locale-prefixed data URL to the page path before this runs, so on a real
    // navigation `req.url` reads `/models/4201` and this prefix test is false. Next marks those
    // requests with `x-nextjs-data: 1` instead: it strips that header from incoming requests and
    // sets it only on data routes, so a browser cannot forge it onto a page request. The header is
    // honoured below, behind `clientNavSkipsPrefetch`. The session lookup keeps the URL test: it
    // runs before the flag can be read, since reading it needs the session's user.
    const isClientByUrl = context.req.url?.startsWith('/_next/data') ?? false;
    // `_app` seeds `req.session` from its own request, which carries this request's headers but not
    // its URL. With an Authorization header the seed holds that token's user but not its
    // credential, so it resolves here, which records the credential on `req.context`.
    const presentsHeader = !!context.req.headers.authorization;
    const session =
      (presentsHeader ? null : ((context.req as any)['session'] as Session | null)) ??
      (useSession || requireModerator || !isClientByUrl || presentsHeader
        ? await getServerAuthSession(context)
        : null);

    // Page-level moderator gate. Anon with no token → login; any other refusal →
    // home (login can't change the outcome and would loop back here). Runs on SSR AND client-nav
    // data fetches.
    if (
      requireModerator &&
      (!session?.user?.isModerator || !isFullScopeSession(context.req as NextApiRequest))
    ) {
      return {
        redirect: {
          destination:
            session?.user ||
            presentsHeader ||
            requestCarriesQueryToken(context.req as NextApiRequest)
              ? '/'
              : `/login?returnUrl=${encodeURIComponent(context.resolvedUrl)}`,
          permanent: false,
        },
      };
    }

    const features = await getFeatureFlagsAsync({ user: session?.user, req: context.req });
    const isClient =
      isClientByUrl ||
      (!!features.clientNavSkipsPrefetch && context.req.headers['x-nextjs-data'] === '1');

    const ssg =
      useSSG && (prefetch === 'always' || !isClient)
        ? await getServerProxySSGHelpers(context, session, features)
        : undefined;

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

    const adsGated = resolveAdsGated(result, features);

    return {
      props: {
        ...(props ?? {}),
        adsGated,
        ...(ssg ? { trpcState: dehydrateSsgState(ssg, context.resolvedUrl) } : {}),
        session: jsonSafeSession(session),
      } as NonNullable<P>,
    };
  };
}

/**
 * Content rating declared by pages that render `<Gated>`. Consumed here — it never reaches
 * Next.js — and becomes the `adsGated` prop `_app` hands to `AdsProvider`.
 *
 * Rating only, no owner/mod/crawler exemptions: the verdict must be identical for every
 * request to a URL, since one auction is enough to put it in GAM's policy violation center.
 */
export type AdGatingDeclaration = { contentNsfwLevel: number; nsfw?: boolean };

type GetPropsFnResult<P> = {
  props: P | Promise<P>;
  redirect: Redirect;
  notFound: true;
  gating: AdGatingDeclaration;
  suppressAds: boolean;
};

type CreateServerSidePropsProps<P> = {
  useSSG?: boolean;
  useSession?: boolean;
  /** `'once'` (default) skips `ssg` on a client navigation, so anything the resolver decides from an
   *  `ssg` fetch — `gating`, `suppressAds`, a notFound or redirect — is skipped too. Use `'always'`
   *  when a decision depends on it. */
  prefetch?: 'always' | 'once';
  /** Gate the page to moderators on a browser session or a full-scope personal API key sent in the
   *  Authorization header. Redirects everyone else before the resolver runs. */
  requireModerator?: boolean;
  resolver?: (context: CustomGetServerSidePropsContext) => Promise<
    | (GetServerSidePropsResult<P> & {
        gating?: AdGatingDeclaration;
        /** Suppress ads for a reason unrelated to content rating — e.g. an unpublished model,
         *  visible only to its owner and moderators, so there is no audience to monetize. */
        suppressAds?: boolean;
      })
    | void
  >;
};

type CustomGetServerSidePropsContext = {
  ctx: GetServerSidePropsContext;
  isClient: boolean;
  ssg?: AsyncReturnType<typeof getServerProxySSGHelpers>;
  session?: Session | null;
  features?: FeatureAccess;
  // browsingLevel: number;
};
