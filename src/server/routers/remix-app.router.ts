import * as z from 'zod';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import {
  listRemixApps,
  quoteRemixApps,
  quoteTeamRemix,
  runRemixApp,
  type RemixAppCaller,
} from '~/server/services/remix-app.service';
import {
  advanceRemixRun,
  postRemixResult,
  REMIX_RUN_ID,
  startRemixRun,
} from '~/server/services/remix-app-run.service';
import { POST_CREATE_RATE_LIMIT_KEY, postRateLimits } from '~/server/schema/post.schema';
import type { Context } from '~/server/createContext';
import { rateLimit } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import {
  guardedProcedure,
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  router,
} from '~/server/trpc';
import {
  listRemixAppsForAdmin,
  orderRemixApps,
  saveRemixApp,
  setRemixAppEnabled,
  deleteRemixApp,
  submitUserRemixApp,
  reviewUserRemixApp,
  clearRemixMinorThemed,
  clearRemixRunnerHold,
  validateUserRemixApp,
} from '~/server/services/remix-app-registry.service';
import {
  remixAppInputSchema,
  remixAppSlugSchema,
  remixAppSubmitSchema,
  REMIX_REJECT_REASONS,
  REMIX_REVIEW_STATES,
  USER_REMIX_SLUG,
} from '~/shared/remix-apps/row.schema';
import { TRPCError } from '@trpc/server';
import { assertNotImpersonating } from '~/server/auth/refuse-while-impersonating';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { SessionUser } from '~/types/session';
import { REMIX_RUN_LIMITS } from '~/shared/remix-apps/replay';

const remixAppProcedure = protectedProcedure.use(isFlagProtected('remixApps'));
const remixAppAdminProcedure = moderatorProcedure.use(isFlagProtected('remixApps'));
const userCodeReviewProcedure = remixAppAdminProcedure.use(isFlagProtected('remixAppsUserCode'));
// Guarded: a submit publishes code and listing text, so muted or unverified accounts may not.
const remixAppBuilderProcedure = guardedProcedure
  .use(isFlagProtected('remixApps'))
  .use(isFlagProtected('remixAppsUserCode'))
  .use(isFlagProtected('remixAppBuilder'));

/** A user app's author check compares the session's user id, which an impersonation replaces. */
function assertUserAppNotImpersonating(slug: string, ctx: { impersonatedBy?: number | null }) {
  if (USER_REMIX_SLUG.test(slug)) assertNotImpersonating(ctx);
}

/** A user app's row is only acted on with its flag, like its review. */
function assertUserCodeAccess(slug: string, features: { remixAppsUserCode?: boolean }) {
  if (USER_REMIX_SLUG.test(slug) && !features.remixAppsUserCode)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'User remix apps are not enabled for you' });
}

const imageId = z.number().int().positive();

/** Each submit rewrites the shared registry cache. */
const submitRateLimit = rateLimit({ limit: 20, period: CacheTTL.hour });
/** Each uncached quote is an orchestrator what-if. */
const quoteRateLimit = rateLimit({ limit: 30, period: CacheTTL.xs });
/** Called on every image view; it only reaches a what-if for an image the viewer can team-remix. */
const teamQuoteRateLimit = rateLimit({ limit: 120, period: CacheTTL.xs });
/** run, start and advance each price the next workflow with a what-if before they submit it. */
const runStepRateLimit = rateLimit({ limit: 30, period: CacheTTL.xs });

const nonce = z.string().min(8).max(64);
const quote = z.number().int().nonnegative();
const gallery = z
  .object({
    hostImageId: imageId,
    method: z.enum(['free', 'team', 'paid']),
    expectedPrice: z.number().int().min(0).optional(),
  })
  // The gallery service reads a missing price as consent to the owner's current one.
  .superRefine((input, ctx) => {
    if (input.method === 'paid' && input.expectedPrice == null)
      ctx.addIssue({
        code: 'custom',
        path: ['expectedPrice'],
        message: 'A paid submission has to carry the price it was shown',
      });
  });

const answer = z.union([
  z.string().max(REMIX_RUN_LIMITS.answerLength),
  z.number().int().nonnegative(),
]);

function callerOf(ctx: Context & { user: SessionUser }): Omit<RemixAppCaller, 'token'> {
  return {
    user: ctx.user,
    features: ctx.features,
    isGreenDomain: ctx.domain === 'green',
    isApiCaller: ctx.apiKeyId != null,
    track: ctx.track,
    impersonated: ctx.impersonatedBy != null,
  };
}

export async function getCaller(ctx: Context & { user: SessionUser }): Promise<RemixAppCaller> {
  return { ...callerOf(ctx), token: await getOrchestratorToken(ctx.user.id, ctx) };
}

/** Mod-only: the remix app rows, and a test run that spends only on a confirmed quote. */
const remixAppAdminRouter = router({
  list: remixAppAdminProcedure.query(async ({ ctx }) => {
    const rows = await listRemixAppsForAdmin();
    // By slug: a user row whose manifest no longer validates carries no `user`.
    return ctx.features.remixAppsUserCode
      ? rows
      : rows.filter((row) => !USER_REMIX_SLUG.test(row.slug));
  }),
  save: remixAppAdminProcedure
    .input(remixAppInputSchema)
    .mutation(({ input }) => saveRemixApp(input)),
  setEnabled: remixAppAdminProcedure
    .input(z.object({ slug: remixAppSlugSchema, enabled: z.boolean() }))
    .mutation(({ ctx, input }) => {
      assertUserCodeAccess(input.slug, ctx.features);
      assertUserAppNotImpersonating(input.slug, ctx);
      return setRemixAppEnabled({ ...input, moderatorId: ctx.user.id });
    }),
  delete: remixAppAdminProcedure
    .input(z.object({ slug: remixAppSlugSchema }))
    .mutation(({ ctx, input }) => {
      assertUserCodeAccess(input.slug, ctx.features);
      assertUserAppNotImpersonating(input.slug, ctx);
      return deleteRemixApp({ ...input, moderatorId: ctx.user.id });
    }),
  /** Approves or rejects the source whose hash the mod read. */
  review: userCodeReviewProcedure
    .input(
      z.object({
        slug: remixAppSlugSchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        seenReview: z.enum(REMIX_REVIEW_STATES),
        decision: z.enum(['approved', 'rejected']),
        mature: z.boolean().optional(),
        reason: z.enum(REMIX_REJECT_REASONS).optional(),
        note: z.string().trim().max(200).optional(),
      })
    )
    .mutation(({ ctx, input }) => {
      // The id is the decision's author, and a second-moderator rule compares it.
      assertNotImpersonating(ctx);
      return reviewUserRemixApp({ ...input, moderatorId: ctx.user.id });
    }),
  /** Runs a user app down every path in the sandbox, on a placeholder image: what review reads. */
  validate: userCodeReviewProcedure
    .use(runStepRateLimit)
    .input(z.object({ slug: remixAppSlugSchema }))
    .mutation(({ ctx, input }) => {
      assertNotImpersonating(ctx);
      return validateUserRemixApp(input.slug, ctx.user.id);
    }),
  /** Lifts a minor-themed mark; refused to the moderator who set it. */
  clearMinorThemed: userCodeReviewProcedure
    .input(z.object({ slug: remixAppSlugSchema }))
    .mutation(({ ctx, input }) => {
      assertNotImpersonating(ctx);
      return clearRemixMinorThemed({ slug: input.slug, moderatorId: ctx.user.id });
    }),
  /** Lifts a runner-trip hold off the app's author. */
  clearRunnerHold: userCodeReviewProcedure
    .input(z.object({ slug: remixAppSlugSchema }))
    .mutation(({ ctx, input }) => {
      assertNotImpersonating(ctx);
      return clearRemixRunnerHold({ slug: input.slug, moderatorId: ctx.user.id });
    }),
  order: remixAppAdminProcedure
    .input(z.object({ slugs: remixAppSlugSchema.array().max(100) }))
    .mutation(({ input }) => orderRemixApps(input.slugs)),
  /** `start` for any app, disabled included; with no `quote` it only prices the first step. */
  testStart: remixAppAdminProcedure
    .use(runStepRateLimit)
    .input(
      z.object({
        slug: remixAppSlugSchema,
        imageId,
        nonce,
        answers: answer.array().max(8).optional(),
        quote: quote.optional(),
      })
    )
    .mutation(async ({ ctx, input: { slug, imageId, nonce, answers, quote } }) => {
      assertUserAppNotImpersonating(slug, ctx);
      return startRemixRun({
        slug,
        imageId,
        nonce,
        answers,
        quote,
        caller: await getCaller(ctx),
        allowDisabled: true,
      });
    }),
});

export const remixAppRouter = router({
  admin: remixAppAdminRouter,
  /** Creates or replaces the caller's own app, which waits for a mod's review out of menus. */
  submit: remixAppBuilderProcedure
    .use(submitRateLimit)
    .input(remixAppSubmitSchema)
    .mutation(({ ctx, input }) => {
      assertNotImpersonating(ctx);
      return submitUserRemixApp({
        ...input,
        authorId: ctx.user.id,
        isGreen: !!ctx.features.isGreen,
      });
    }),
  list: remixAppProcedure
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .query(({ ctx }) => listRemixApps(ctx)),
  quote: remixAppProcedure
    .use(quoteRateLimit)
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(z.object({ imageId, slug: remixAppSlugSchema.optional() }))
    .query(async ({ ctx, input }) => quoteRemixApps({ ...input, caller: await getCaller(ctx) })),
  teamQuote: remixAppProcedure
    .use(teamQuoteRateLimit)
    .meta({ requiredScope: TokenScope.AIServicesRead })
    .input(z.object({ imageId }))
    .query(({ ctx, input }) =>
      quoteTeamRemix({
        ...input,
        caller: callerOf(ctx),
        // Only for an eligible image: most image views never need a token.
        getToken: () => getOrchestratorToken(ctx.user.id, ctx),
      })
    ),
  run: guardedProcedure
    .use(isFlagProtected('remixApps'))
    .use(runStepRateLimit)
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(z.object({ slug: z.string().max(64), imageId, nonce, quote }))
    .mutation(async ({ ctx, input }) => runRemixApp({ ...input, caller: await getCaller(ctx) })),
  /** Without `quote`, a run whose next step is a workflow returns its price instead of submitting. */
  start: guardedProcedure
    .use(isFlagProtected('remixApps'))
    .use(runStepRateLimit)
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(
      z.object({
        slug: z.string().max(64),
        imageId,
        nonce,
        answers: answer.array().max(8).optional(),
        quote: quote.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => startRemixRun({ ...input, caller: await getCaller(ctx) })),
  advance: guardedProcedure
    .use(isFlagProtected('remixApps'))
    .use(runStepRateLimit)
    .meta({ requiredScope: TokenScope.AIServicesWrite })
    .input(
      z.object({
        runId: z.string().regex(REMIX_RUN_ID),
        answers: answer.array().max(8).optional(),
        quote: quote.optional(),
      })
    )
    .mutation(async ({ ctx, input }) =>
      advanceRemixRun({ ...input, caller: await getCaller(ctx) })
    ),
  /** Posts a finished run, published; `gallery` also submits it to the source's Remix gallery. */
  post: guardedProcedure
    .use(isFlagProtected('remixApps'))
    // `post.create`'s own limit, shared with it: this makes a post just as that does.
    .use(rateLimit(postRateLimits, undefined, { sharedKey: POST_CREATE_RATE_LIMIT_KEY }))
    .meta({ requiredScope: TokenScope.MediaWrite })
    .input(
      z.union([
        // A runtime run posts what the app returned, read by replaying the run.
        z.object({ runId: z.string().regex(REMIX_RUN_ID), gallery: gallery.optional() }),
        z.object({ workflowId: z.string().min(1).max(64), gallery: gallery.optional() }),
      ])
    )
    .mutation(async ({ ctx, input }) =>
      postRemixResult({
        ...input,
        caller: await getCaller(ctx),
        ctx,
      })
    ),
});
