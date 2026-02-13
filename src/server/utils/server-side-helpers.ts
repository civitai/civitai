import { createServerSideHelpers } from '@trpc/react-query/server';
import type { GetServerSidePropsContext, GetServerSidePropsResult, Redirect } from 'next';
import type { Session } from 'next-auth';
import superjson from 'superjson';
import { Tracker } from '~/server/clickhouse/client';

import { appRouter } from '~/server/routers';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getRequestDomainColor } from '~/shared/constants/domain.constants';

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
      fingerprint: null as any,
      domain,
      // Now we can properly get domain from the request
    },
    transformer: superjson,
  });
  return ssg;
};

export function createServerSideProps<P>({
  resolver,
  useSSG,
  useSession = false,
  prefetch = 'once',
}: CreateServerSidePropsProps<P>) {
  return async function (
    context: GetServerSidePropsContext
  ): Promise<GetServerSidePropsResult<NonNullable<P>>> {
    const isClient = context.req.url?.startsWith('/_next/data') ?? false;
    const session =
      ((context.req as any)['session'] as Session | null) ??
      (useSession || !isClient ? await getServerAuthSession(context) : null);
    const features = await getFeatureFlagsAsync({ user: session?.user, req: context.req });

    const ssg =
      useSSG && (prefetch === 'always' || !isClient)
        ? await getServerProxySSGHelpers(context, session, features)
        : undefined;

    const result = ((await resolver({
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
  resolver: (
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
