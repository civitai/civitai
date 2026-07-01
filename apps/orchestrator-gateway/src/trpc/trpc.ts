import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from './context';
import { authOutcomesTotal } from '../lib/server/metrics';

// tRPC init for the service. superjson is deliberately NOT wired here in P0 (no transformer) — the moved
// procedures that need it come in P1/P2 with their schemas. Keep the router shape close to the monolith so
// the client SDK / typing barely changes at cutover.
const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Protected procedure: requires a verified user. The context already did local token verification; this
 * middleware just gates on the resolved userId and narrows ctx.userId to non-null for the resolver.
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (ctx.userId === null) {
    authOutcomesTotal.inc({ result: ctx.claims ? 'error' : 'unauthenticated' });
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required.' });
  }
  authOutcomesTotal.inc({ result: 'verified' });
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});
