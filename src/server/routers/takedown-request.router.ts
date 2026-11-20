import { TRPCError } from '@trpc/server';
import { caseIntakeInput } from '@civitai/moderation';
import { rateLimit } from '~/server/middleware.trpc';
import { publicProcedure, router } from '~/server/trpc';

async function service() {
  return import('~/server/services/takedown-requests.service');
}

const submitInput = caseIntakeInput.pick({
  processKey: true,
  submissionId: true,
  values: true,
  turnstileToken: true,
  isTest: true,
});

/**
 * The public takedown request forms (/requests). Anyone may file, signed in or not: a claimant needs no
 * account. The moderator app checks the Turnstile token and files the case.
 */
export const takedownRequestRouter = router({
  forms: publicProcedure.query(async () => {
    const svc = await service();
    if (!svc.takedownRequestsConfigured()) return [];
    return svc.getRequestForms();
  }),

  submit: publicProcedure
    .input(submitInput)
    .use(rateLimit({ limit: 10, period: 60 * 60 }))
    .mutation(async ({ ctx, input }) => {
      const svc = await service();
      if (!svc.takedownRequestsConfigured())
        throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'unavailable' });
      return svc.submitRequest({
        ...input,
        // Recorded on the case, never trusted for access.
        submitterUserId: ctx.user?.id,
        // Only a moderator files test cases.
        isTest: ctx.user?.isModerator ? input.isTest : undefined,
        ip: ctx.ip || 'unknown',
        userAgent: ctx.req.headers['user-agent']?.slice(0, 512),
      });
    }),
});
