import { router, publicProcedure, protectedProcedure } from '~/server/trpc';

export const authRouter = router({
  getUser: publicProcedure.query(({ ctx }) => ctx.user),
  getSecretMessage: protectedProcedure.query(
    () => 'You are logged in and can see this secret message!'
  ),
});
