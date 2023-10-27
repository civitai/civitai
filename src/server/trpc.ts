import { initTRPC, TRPCError } from '@trpc/server';
import { SessionUser } from 'next-auth';
import superjson from 'superjson';
import { FeatureAccess, getFeatureFlags } from '~/server/services/feature-flags.service';
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
const isAcceptableOrigin = t.middleware(({ ctx: { user, acceptableOrigin }, next }) => {
  if (!acceptableOrigin)
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message:
        'Please use the public API instead: https://github.com/civitai/civitai/wiki/REST-API-Reference',
    });
  return next({ ctx: { user, acceptableOrigin } });
});

export const publicProcedure = t.procedure.use(isAcceptableOrigin);

/**
 * Reusable middleware to ensure
 * users are logged in
 */
const isAuthed = t.middleware(({ ctx: { user, acceptableOrigin }, next }) => {
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (user.bannedAt)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You cannot perform this action because your account has been banned',
    });
  return next({ ctx: { user, acceptableOrigin } });
});

const isMuted = middleware(async ({ ctx, next }) => {
  const { user } = ctx;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (user.muted)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You cannot perform this action because your account has been muted',
    });

  return next({
    ctx: {
      ...ctx,
      user,
    },
  });
});

const isMod = t.middleware(({ ctx: { user, acceptableOrigin }, next }) => {
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (!user.isModerator)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission to perform this action',
    });
  return next({ ctx: { user, acceptableOrigin } });
});

export const isFlagProtected = (flag: keyof FeatureAccess) =>
  middleware(({ ctx, next }) => {
    const features = getFeatureFlags({ user: ctx.user });
    if (!features[flag]) throw new TRPCError({ code: 'FORBIDDEN' });

    return next({ ctx: { user: ctx.user as SessionUser } });
  });

/**
 * Protected procedure
 **/
export const protectedProcedure = publicProcedure.use(isAuthed);

/**
 * Protected procedure
 **/
export const moderatorProcedure = protectedProcedure.use(isMod);

/**
 * Guarded procedure to prevent users from making actions
 * based on muted/banned properties
 */
export const guardedProcedure = protectedProcedure.use(isMuted);
