import { initTRPC, TRPCError } from '@trpc/server';
import { SessionUser } from 'next-auth';
import superjson from 'superjson';
import { FeatureAccess, getFeatureFlags } from '~/server/services/feature-flags.service';
import type { Context } from './createContext';
import { Flags } from '~/shared/utils';
import { OnboardingSteps } from '~/server/common/enums';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import semver from 'semver';
import { NextApiRequest } from 'next';

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

async function needsUpdate(req?: NextApiRequest) {
  const type = req?.headers['x-client'] as string;
  const version = req?.headers['x-client-version'] as string;
  const date = req?.headers['x-client-date'] as string;

  if (type !== 'web') return false;
  const client = await redis.hGetAll(REDIS_KEYS.CLIENT);
  if (client.version) {
    if (!version || version === 'unknown') return true;
    return semver.lt(version, client.version);
  }
  if (client.date) {
    if (!date) return true;
    return new Date(Number(date)) < new Date(client.date);
  }
  return false;
}

export const enforceClientVersion = t.middleware(async ({ next, ctx }) => {
  // if (await needsUpdate(ctx.req)) {
  //   throw new TRPCError({
  //     code: 'PRECONDITION_FAILED',
  //     message: 'Update required',
  //     cause: 'Please refresh your browser to get the latest version of the app',
  //   });
  // }
  const result = await next();
  if (await needsUpdate(ctx.req)) {
    ctx.res?.setHeader('x-update-required', 'true');
    ctx.cache.edgeTTL = 0;
  }
  return result;
});

export const publicProcedure = t.procedure.use(isAcceptableOrigin).use(enforceClientVersion);

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
      message: 'You cannot perform this action because your account has been restricted',
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

const isOnboarded = t.middleware(({ ctx, next }) => {
  const { user } = ctx;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (!Flags.hasFlag(user.onboarding, OnboardingSteps.TOS)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You must accept our terms of service before performing this action',
    });
  }
  return next({ ctx: { ...ctx, user } });
});

/**
 * Protected procedure
 **/
export const protectedProcedure = publicProcedure.use(isAuthed);

/**
 * Moderator procedure
 **/
export const moderatorProcedure = protectedProcedure.use(isMod);

/**
 * Guarded procedure to prevent users from making actions
 * based on muted/banned properties
 */
export const guardedProcedure = protectedProcedure.use(isMuted);

/**
 * Verified procedure to prevent users from making actions
 * if they haven't completed the onboarding process
 */
export const verifiedProcedure = protectedProcedure.use(isOnboarded);
