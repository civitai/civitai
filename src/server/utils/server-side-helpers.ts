import { createServerSideHelpers } from '@trpc/react-query/server';
import { GetServerSidePropsContext, GetServerSidePropsResult, Redirect } from 'next';
import { Session } from 'next-auth';
import superjson from 'superjson';
import { Tracker } from '~/server/clickhouse/client';

import { appRouter } from '~/server/routers';
import { FeatureAccess, getFeatureFlags } from '~/server/services/feature-flags.service';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { parseCookies } from '~/shared/utils';
import { extendedSessionUser } from '~/utils/session-helpers';

export function parseBrowsingMode(
  cookies: Partial<{ [key: string]: string }>,
  session: Session | null
) {
  if (!session?.user) {
    return {
      browsingLevel: publicBrowsingLevelsFlag,
      showNsfw: false,
    };
  }

  const { browsingLevel, showNsfw } = parseCookies(cookies);
  return {
    browsingLevel: browsingLevel ?? session.user.browsingLevel,
    showNsfw: showNsfw ?? session.user.showNsfw,
  };
}

export const getServerProxySSGHelpers = async (
  ctx: GetServerSidePropsContext,
  session: Session | null
) => {
  const { browsingLevel, showNsfw } = parseBrowsingMode(ctx.req.cookies, session);

  const ssg = createServerSideHelpers({
    router: appRouter,
    ctx: {
      user: session?.user ? extendedSessionUser(session.user) : undefined,
      acceptableOrigin: true,
      browsingLevel,
      showNsfw,
      track: new Tracker(),
      ip: null as any,
      res: null as any,
      cache: null as any,
      req: null as any,
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
  return async (context: GetServerSidePropsContext) => {
    const isClient = context.req.url?.startsWith('/_next/data') ?? false;
    const session =
      (context.req as any)['session'] ?? (useSession ? await getServerAuthSession(context) : null);
    const flags = (context.req as any)['flags'] ?? getFeatureFlags({ user: session?.user });

    const ssg =
      useSSG && (prefetch === 'always' || !isClient)
        ? await getServerProxySSGHelpers(context, session)
        : undefined;
    const result = (await resolver({
      ctx: context,
      isClient,
      ssg,
      session,
      features: flags,
    })) as GetPropsFnResult<P> | undefined;

    let props: GetPropsFnResult<P>['props'] | undefined;
    if (result) {
      if (result.redirect) return { redirect: result.redirect };
      if (result.notFound) return { notFound: result.notFound };

      props = result.props;
    }

    return {
      props: {
        session,
        flags,
        ...(props ?? {}),
        ...(ssg ? { trpcState: ssg.dehydrate() } : {}),
      },
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
};
