import { GetServerSidePropsContext } from 'next';
import { createProxySSGHelpers } from '@trpc/react-query/ssg';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { appRouter } from '~/server/routers';
import superjson from 'superjson';
import { parseBrowsingMode } from '~/server/createContext';

export const getServerProxySSGHelpers = async (ctx: GetServerSidePropsContext) => {
  const session = await getServerAuthSession(ctx);
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
