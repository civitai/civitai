import { createServerSideHelpers } from '@trpc/react-query/server';
import { GetServerSidePropsContext, GetServerSidePropsResult, Redirect } from 'next';
import { Session } from 'next-auth';
import superjson from 'superjson';
import { Tracker } from '~/server/clickhouse/client';

import { appRouter } from '~/server/routers';
import { FeatureAccess, getFeatureFlags } from '~/server/services/feature-flags.service';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import {
  browsingLevelOr,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { parseCookies } from '~/shared/utils';

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
    showNsfw: showNsfw ?? session.user.showNsfw ?? false,
    browsingLevel: browsingLevelOr([browsingLevel, session.user.browsingLevel]),
  };
}

export const getServerProxySSGHelpers = async (
  ctx: GetServerSidePropsContext,
  session: Session | null,
  browsingLevel: number,
  showNsfw: boolean
) => {
  const ssg = createServerSideHelpers({
    router: appRouter,
    ctx: {
      user: session?.user,
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
    const { browsingLevel, showNsfw } = parseBrowsingMode(context.req.cookies, session);

    const ssg =
      useSSG && (prefetch === 'always' || !isClient)
        ? await getServerProxySSGHelpers(context, session, browsingLevel, showNsfw)
        : undefined;

    const result = (await resolver({
      ctx: context,
      isClient,
      ssg,
      session,
      features: flags,
      browsingLevel,
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
  browsingLevel: number;
};
