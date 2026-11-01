import { createServerSideHelpers } from '@trpc/react-query/server';
import type { CombinedDataTransformer } from '@trpc/server';
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
import type { ShellRouteName } from '~/server/shell/shell-mode';
import { shellRouteByName } from '~/server/shell/shell-mode';
import {
  applyShellBounceHeaders,
  applyShellPrivateHeaders,
  syncShellRouteCookie,
} from '~/server/shell/shell-response';
import { isCanonicalShellPath, shellBounceLocation } from '~/server/shell/shell-canonical';
import { SHELL_RENDERED_REQ_KEY, SHELL_REQ_KEY } from '~/shared/constants/shell.constants';
import { isFliptSync } from '~/server/flipt/client';

/**
 * The page-props key the patched `withTRPC` (patches/@trpc__next@11.17.0.patch) reads the
 * pre-serialisation dehydrated state from on the server render. A symbol key, so JSON — the
 * page's `__NEXT_DATA__` and `/_next/data` responses — never carries it.
 */
export const SSR_DEHYDRATED_STATE = Symbol.for('civitai.trpc.ssrDehydratedState');
const SSR_SKIP_TRPCSTATE_REPARSE_FLAG = 'ssr-skip-trpcstate-reparse';

/** One request's slot for the value its helpers' dehydrate handed the transformer. */
export type DehydratedStateCapture = { state?: unknown };

function capturingTransformer(
  base: CombinedDataTransformer,
  capture: DehydratedStateCapture
): CombinedDataTransformer {
  return {
    input: base.input,
    output: {
      deserialize: base.output.deserialize,
      serialize: (value) => {
        capture.state = value;
        return base.output.serialize(value);
      },
    },
  };
}

/**
 * Hand the server render the state `trpcState` was serialised from, so it does not parse what this
 * request just wrote. Only a devalue `trpcState` (a string): devalue.stringify accepted the whole
 * value, so the browser's parse rebuilds the same structure. A superjson write (the fallback for a
 * value devalue rejects) can pass class instances through, so the server keeps parsing it.
 */
function attachSsrDehydratedState(pageProps: unknown, capture: DehydratedStateCapture | undefined) {
  const props = pageProps as Record<PropertyKey, unknown>;
  if (!capture || capture.state === undefined || typeof props.trpcState !== 'string') return;
  props[SSR_DEHYDRATED_STATE] = capture.state;
}

export const getServerProxySSGHelpers = async (
  // A page's gSSP context, or an API route's request/response (`/api/page-data/*`).
  ctx: { req: GetServerSidePropsContext['req']; res: GetServerSidePropsContext['res'] },
  session: Session | null,
  features: FeatureAccess,
  capture?: DehydratedStateCapture
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
    transformer: capture ? capturingTransformer(unionTransformer, capture) : unionTransformer,
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
  shell,
}: CreateServerSidePropsProps<P>) {
  return async function (
    context: GetServerSidePropsContext
  ): Promise<GetServerSidePropsResult<NonNullable<P>>> {
    // A static shell render (`_app` decided it and marked the request): nothing per viewer is read
    // or returned — no session, no flags, no prefetch. Ads stay gated until the page data's verdict.
    const shellReq = context.req as {
      [SHELL_REQ_KEY]?: string;
      [SHELL_RENDERED_REQ_KEY]?: string;
    };
    if (shell && shellReq[SHELL_REQ_KEY] === shell) {
      shellReq[SHELL_RENDERED_REQ_KEY] = shell;
      applyShellPrivateHeaders(context.res);
      return { props: { adsGated: true } as unknown as NonNullable<P> };
    }
    // 🔴 The route's canonical path (`~/server/shell/shell-canonical`) is never rendered: whatever
    // reached it without the shell — refused, no valid original URL, a data request — is sent back
    // to the URL it came from with `?civ-shell=0`, before this reads a session or prefetches. `_app`
    // ran its full path first; the bounce headers drop any cookie or edge header it left.
    if (shell && isCanonicalShellPath(shell, context.resolvedUrl)) {
      applyShellBounceHeaders(context.res);
      return {
        redirect: { destination: shellBounceLocation(shell, context.req), permanent: false },
      };
    }

    const isClient = context.req.url?.startsWith('/_next/data') ?? false;
    // `_app` seeds `req.session` from its own request, which carries this request's headers but not
    // its URL. With an Authorization header the seed holds that token's user but not its
    // credential, so it resolves here, which records the credential on `req.context`.
    const presentsHeader = !!context.req.headers.authorization;
    const session =
      (presentsHeader ? null : ((context.req as any)['session'] as Session | null)) ??
      (useSession || requireModerator || !isClient || presentsHeader
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
    // This response is private, so it is where the viewer's shell rollout is read: the route cookie
    // follows the flag, and only a request carrying it is ever considered for the shell.
    if (shell) {
      const enabled = !!session?.user && !!features[shellRouteByName(shell).flag];
      syncShellRouteCookie(context.req, context.res, shell, enabled);
    }

    // Only a full page load renders on the server; a `/_next/data` response is JSON alone.
    const capture: DehydratedStateCapture | undefined =
      useSSG && !isClient && isFliptSync(SSR_SKIP_TRPCSTATE_REPARSE_FLAG) === true ? {} : undefined;
    const ssg =
      useSSG && (prefetch === 'always' || !isClient)
        ? await getServerProxySSGHelpers(context, session, features, capture)
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

    const pageProps = {
      ...(props ?? {}),
      adsGated,
      ...(ssg ? { trpcState: dehydrateSsgState(ssg, context.resolvedUrl) } : {}),
      session: jsonSafeSession(session),
    } as NonNullable<P>;
    attachSsrDehydratedState(pageProps, capture);
    return { props: pageProps };
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
  prefetch?: 'always' | 'once';
  /** Gate the page to moderators on a browser session or a full-scope personal API key sent in the
   *  Authorization header. Redirects everyone else before the resolver runs. */
  requireModerator?: boolean;
  /** The page has a static shell (`~/server/shell/shell-mode`): answer a request `_app` marked for
   *  it with the shell's props and headers, and keep the route's cookie in step with its flag on
   *  every other response. */
  shell?: ShellRouteName;
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
