import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { caseIntakeInput } from '@civitai/moderation';
import { rateLimit } from '~/server/middleware.trpc';
import { isFlagProtected, publicProcedure, router } from '~/server/trpc';

async function service() {
  return import('~/server/services/takedown-requests.service');
}

// Values stay loose here and are checked in the service: a tRPC input refusal logs the whole input,
// which would put a claimant's contact details in the logs.
const submitInput = caseIntakeInput
  .pick({ processKey: true, submissionId: true, turnstileToken: true, isTest: true })
  .extend({ values: z.record(z.string(), z.unknown()) });

/**
 * The public takedown request forms (/requests). Anyone may file, signed in or not: a claimant needs no
 * account. The moderator app checks the Turnstile token and files the case.
 */
const takedownFormsProcedure = publicProcedure.use(isFlagProtected('takedownRequests'));

export const takedownRequestRouter = router({
  forms: takedownFormsProcedure.query(async () => {
    const svc = await service();
    if (!svc.takedownRequestsConfigured()) return [];
    return svc.getRequestForms();
  }),

  submit: takedownFormsProcedure
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
