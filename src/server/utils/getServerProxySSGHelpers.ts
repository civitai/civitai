import { GetServerSidePropsContext } from 'next';
import { createProxySSGHelpers } from '@trpc/react-query/ssg';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { appRouter } from '~/server/routers';
import superjson from 'superjson';

export const getServerProxySSGHelpers = async (ctx: GetServerSidePropsContext) => {
  const session = await getServerAuthSession(ctx);
  const ssg = createProxySSGHelpers({
    router: appRouter,
    ctx: { user: session?.user },
    transformer: superjson,
  });
  return ssg;
};
