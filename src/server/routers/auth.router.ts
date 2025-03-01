import { router, publicProcedure, protectedProcedure } from '~/server/trpc';
import { getProviders } from 'next-auth/react';

export const authRouter = router({
  getUser: publicProcedure.query(({ ctx }) => ctx.user),
  getSecretMessage: protectedProcedure.query(
    () => 'You are logged in and can see this secret message!'
  ),
  getProviders: publicProcedure.query(() =>
    getProviders().then((data) =>
      data ? Object.values(data).filter((x) => x.type === 'oauth') : []
    )
  ),
});
