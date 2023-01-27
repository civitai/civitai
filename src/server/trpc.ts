import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { env } from '~/env/server.mjs';
import type { Context } from './createContext';

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape }) {
    return shape;
  },
});

export const { router, middleware } = t;

/**
 * Unprotected procedure
 **/
const isFromApp = t.middleware(({ ctx, next }) => {
  if (!ctx.referrer?.startsWith(env.NEXTAUTH_URL)) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({ ctx: { user: ctx.user } });
});

export const publicProcedure = t.procedure.use(isFromApp);

/**
 * Reusable middleware to ensure
 * users are logged in
 */
const isAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({ ctx: { user: ctx.user } });
});

/**
 * Protected procedure
 **/
export const protectedProcedure = publicProcedure.use(isAuthed);
