import { router, publicProcedure, protectedProcedure } from './trpc';

// The service's tRPC router. P0 is deliberately minimal:
//   - health: public, no-auth — a tRPC-level liveness echo (distinct from the raw /health HTTP route the
//     k8s probes hit, which must not depend on tRPC).
//   - ping:   protected — proves the @civitai/auth verifier path end-to-end by returning the verified
//             { userId } off the request context.
//
// The moved orchestrator.* generate/whatIf/status/workflow-CRUD procedures land here in P1/P2. Keeping the
// router NAMED `orchestrator` (mounted at /api/trpc) preserves the client-side `trpc.orchestrator.*` shape
// so the eventual same-origin path-prefix cutover (P2) needs no client changes.
export const appRouter = router({
  orchestrator: router({
    /** Public liveness echo. No auth. */
    health: publicProcedure.query(() => ({ status: 'ok' as const, service: 'orchestrator-api' })),

    /** Protected identity echo — returns the verified userId. Proves the auth verifier is wired. */
    ping: protectedProcedure.query(({ ctx }) => ({ userId: ctx.userId })),
  }),
});

export type AppRouter = typeof appRouter;
