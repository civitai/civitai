import { GetServerSidePropsContext, GetServerSidePropsResult } from 'next';
import { createProxySSGHelpers } from '@trpc/react-query/ssg';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { appRouter } from '~/server/routers';
import superjson from 'superjson';
import { Session } from 'next-auth';
import { parseBrowsingMode } from '~/server/createContext';

export const getServerProxySSGHelpers = async (
  ctx: GetServerSidePropsContext,
  session: Session | null
) => {
  const ssg = createProxySSGHelpers({
    router: appRouter,
    ctx: {
      user: session?.user,
      acceptableOrigin: true,
      browsingMode: parseBrowsingMode(ctx.req.cookies, session),
    },
    transformer: superjson,
  });
  return ssg;
};

export function createServerSideProps<P>({
  resolver,
  useSSG,
  prefetch = 'once',
}: CreateServerSidePropsProps<P>): (
  context: GetServerSidePropsContext
) => Promise<GetServerSidePropsResult<P>> {
  return async (context) => {
    const isClient = context.req.url?.startsWith('/_next/data') ?? false;
    const session = await getServerAuthSession(context);

    const ssg =
      useSSG && (prefetch === 'always' || !isClient)
        ? await getServerProxySSGHelpers(context, session)
        : undefined;
    const result = await resolver({
      ctx: context,
      isClient,
      ssg,
      session,
    });

    if (typeof result === 'object') {
      if ('redirect' in result) return { redirect: result.redirect };
      if ('notFound' in result) return { notFound: result.notFound };
    }

    return {
      props: {
        ...(typeof result === 'object' ? result.props : {}),
        ...(ssg ? { trpcState: ssg.dehydrate() } : {}),
      } as P,
    };
  };
}

type CreateServerSidePropsProps<P> = {
  useSSG?: boolean;
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
};
