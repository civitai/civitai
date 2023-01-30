import { GetServerSidePropsContext, GetServerSidePropsResult, Redirect } from 'next';
import { createProxySSGHelpers } from '@trpc/react-query/ssg';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { appRouter } from '~/server/routers';
import superjson from 'superjson';
import { Session } from 'next-auth';

export const getServerProxySSGHelpers = async (
  ctx: GetServerSidePropsContext,
  session?: Session | null
) => {
  const ssg = createProxySSGHelpers({
    router: appRouter,
    ctx: { user: session?.user, acceptableOrigin: true },
    transformer: superjson,
  });
  return ssg;
};

export function createServerSideProps<P>({ resolver, useSSG }: CreateServerSidePropsProps<P>) {
  return async (context: GetServerSidePropsContext) => {
    const isClient = context.req.url?.startsWith('/_next/data') ?? false;
    const session = await getServerAuthSession(context);

    const ssg = useSSG && !isClient ? await getServerProxySSGHelpers(context, session) : undefined;
    const result = (await resolver({
      ctx: context,
      isClient,
      ssg,
      session,
    })) as GetPropsFnResult<P> | undefined;

    let props: GetPropsFnResult<P>['props'] | undefined;
    if (result) {
      if (result.redirect) return { redirect: result.redirect };
      if (result.notFound) return { notFound: result.notFound };

      props = result.props;
    }

    return {
      props: {
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
