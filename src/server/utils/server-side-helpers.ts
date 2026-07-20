import { createServerSideHelpers } from '@trpc/react-query/server';
import type { GetServerSidePropsContext, GetServerSidePropsResult, Redirect } from 'next';
import type { Session } from '~/types/session';
import { Tracker } from '~/server/clickhouse/client';
import { unionTransformer } from '~/shared/utils/trpc-union-transformer';
import {
  runWithSerializeCtxAlways,
  ssrDehydrateSerializePath,
} from '~/server/logging/trpc-serialize-log';

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
    // Phase 2 of the superjson → devalue migration: SSR runs server-side, so its
    // dehydrate WRITE goes through the env-gated server writer (`unionTransformer`
    // = `buildTransformer()` = `serverWriteSerialize`). It flips to devalue only
    // when THIS pool's Deployment sets `TRPC_WRITE_DEVALUE=true`; otherwise it
    // writes superjson exactly as in Phase 1. The client that hydrates decodes
    // either format through the union READ. SSR HTML and the JS chunks it
    // references are the same content-hashed deploy, so dehydrate/hydrate is
    // inherently version-matched. See src/shared/utils/trpc-union-transformer.ts.
    transformer: unionTransformer,
  });
  return ssg;
};

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
        // Success-only: an errored prefetch would put a TRPCError instance in the
        // dehydrated state, and the devalue write (TRPC_WRITE_DEVALUE) throws on
        // non-POJOs — turning one failed prefetch into a page-wide SSR 500. Dropping
        // errored queries lets the client refetch instead.
        //
        // Seed the serialize-attribution ctx (kill-switch-independent — this is the
        // once-per-render SSR path, not the hot tRPC batch path) with the page
        // route so a devalue-write fallback during dehydrate attributes to the
        // page (`ssr:dehydrate:<route>`) instead of `unknown`.
        ...(ssg
          ? {
              trpcState: runWithSerializeCtxAlways(
                { path: ssrDehydrateSerializePath(context.resolvedUrl), type: 'ssr' },
                () =>
                  ssg.dehydrate({
                    shouldDehydrateQuery: (query) => query.state.status === 'success',
                  })
              ),
            }
          : {}),
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
