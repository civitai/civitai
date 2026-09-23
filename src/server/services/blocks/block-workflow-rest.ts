import type { NextApiRequest, NextApiResponse } from 'next';

import { Tracker } from '~/server/clickhouse/client';
import type { Context } from '~/server/createContext';
import type { blocksRouter } from '~/server/routers/blocks.router';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { resolveClientIpOrNull } from '~/server/utils/client-ip';
import { getRequestDomainColor } from '~/server/utils/server-domain';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The delegation seam for `/api/v1/blocks/workflows/*` — the REST twins of the
 * four workflow procedures on the postMessage bridge (`blocks.submitWorkflow`,
 * `estimateWorkflow`, `pollWorkflow`, `cancelWorkflow`).
 *
 * 🔴 IT DELEGATES TO THE PROCEDURE ITSELF, NOT TO A COPY OF ITS BODY, and that is
 * the entire security argument for this surface. `blocks.submitWorkflow` is ~1100
 * lines of money path: the per-call `buzzBudget` gate, the per-user daily Buzz
 * reservation, the viewer's own per-app consent budget, the per-app aggregate
 * spend + velocity cap (G8), the dev-tunnel session backstop, the gen-idempotency
 * claim, the maturity clamp derived from the token's server-minted ceiling, the
 * registered-step denylist, `getOrchestratorToken`, the `app-block:<appId>`
 * workflow tag, the author-fee quote/charge/reversal and the spend-attribution
 * row. A REST twin that re-spelled ANY of that would be a second copy of one
 * security decision, wrong at some of the sites, and wrong silently — the shape
 * `assertBlockWorkflowTaggedForApp`'s own docblock records as having been five
 * open-coded copies. There is exactly one spelling and both transports run it.
 *
 * WHY A tRPC CALLER RATHER THAN AN EXTRACTED FUNCTION, since the shared-storage
 * REST pair (#5054 / #5055) set the other precedent. There the six procedure
 * BODIES moved out into exported bearer-token-taking functions, which was right:
 * they are short, they take no `ctx`, and the move was reviewable line by line.
 * These four are not that. `submitWorkflow` alone is longer than the whole
 * `apps-shared` write surface, it is the highest-blast-radius resolver in the
 * repo, and it reads `ctx`. Moving it would put a 2,000-line diff on a money path
 * whose review budget is better spent elsewhere — and, worse, an extracted
 * function SKIPS `publicProcedure`'s middleware chain, which the bridge call
 * really does run through. Calling the procedure keeps both transports on the
 * same chain instead of introducing a divergence in the name of avoiding one.
 *
 * 🔴 THE CALLER IS BUILT OVER `blocksRouter`, NOT `appRouter`. `publicApiContext2`
 * is the established in-repo way to reach tRPC from a REST route and would have
 * worked, but it pulls the entire application router (~870 procedures, `lazy`) in
 * behind one import. This narrows the graph to the one router whose procedures we
 * call, which is also what keeps the import-time cost off the route modules that
 * `scoped-endpoints-cors-wiring.test.ts` evaluates.
 *
 * KNOWN, STATED DIVERGENCES from the page-host bridge call, neither of which
 * reaches any control above:
 *   1. `ctx.user` is `undefined` here (the caller is a block JWT, not a session),
 *      exactly as it is for every `/api/v1/*` route built on `publicApiContext2`.
 *      The four procedures never read `ctx.user` — every viewer binding is
 *      `parseSubjectUserId(claims.sub)` off the VERIFIED token, which is the
 *      property that makes this safe rather than a coincidence.
 *   2. Because `ctx.user` is undefined, `applyDomainFeature` writes a
 *      `browsingLevel` onto the raw input. None of the four input schemas has
 *      that field (zod strips it) and none of the four resolvers reads it — the
 *      maturity ceiling comes from `resolveBlockMaturity(claims)`, i.e. the
 *      token's server-minted claim, never a request field or the request domain.
 */

/**
 * The raw Bearer block JWT. `withBlockScope` has ALREADY verified this exact
 * string (signature + kid, iss/aud/exp, max-age, claim shape, per-instance
 * revocation, the app's approved status and the `ai:write:budgeted` scope) before
 * the handler runs; re-reading the header hands the SAME string to the procedure,
 * which verifies it again on its own terms.
 *
 * 🔴 THE SECOND VERIFICATION IS THE POINT, NOT WASTE. `authorizeBlockBridgeToken`
 * is the procedure's own fail-closed gate, and it must keep running here for the
 * same reason it runs for the bridge: the route is an adapter, and an adapter that
 * disarmed a gate because "the middleware already did it" is how a control ends up
 * depending on its caller. Cost is one ES256 verify, one Redis revocation read and
 * one replica `appBlock` lookup — the price of the two transports being one path.
 */
export function blockWorkflowBearer(req: NextApiRequest): string {
  const auth = req.headers.authorization ?? '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice('bearer '.length).trim() : '';
}

/**
 * Memoized caller factory. Built on FIRST USE from a dynamic import so that
 * importing a workflow route module does not drag `blocks.router.ts` (and its
 * transitive service graph) into module-eval — which both keeps the route's cold
 * start honest and keeps `scoped-endpoints-cors-wiring.test.ts`, which imports
 * every scoped route purely to capture its options literal, from having to mock
 * the router's entire dependency set.
 */
// 🔴 TYPED, not `(ctx: unknown) => unknown`. Everything is assignable to `unknown`,
// so the previous signature checked the context literal below against
// NOTHING — unlike `publicApiContext2`, which hands its literal to a correctly-typed
// `createCaller` and fails to build when `Context` gains a required field. This file
// asserts it "mirrors publicApiContext2 field for field"; that claim needs a guard,
// and the type IS the guard. `Context` is type-only here, so naming it does not undo
// the dynamic import below.
let callerFactory: ((ctx: Context) => BlocksCaller) | null = null;

async function getCallerFactory() {
  if (!callerFactory) {
    const [{ createCallerFactory }, { blocksRouter }] = await Promise.all([
      import('~/server/trpc'),
      import('~/server/routers/blocks.router'),
    ]);
    callerFactory = createCallerFactory(blocksRouter);
  }
  return callerFactory;
}

// Type-only (erased at runtime), so naming the router here does NOT undo the
// dynamic import above.
type BlocksCaller = ReturnType<typeof blocksRouter.createCaller>;

/**
 * A `blocksRouter` caller bound to this request. The context mirrors
 * `publicApiContext2` field for field — deliberately, so the one server-to-server
 * tRPC context shape in this repo stays one shape.
 */
export async function blockWorkflowCaller(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<BlocksCaller> {
  const factory = await getCallerFactory();
  const domain = getRequestDomainColor(req) ?? 'blue';
  return factory({
    user: undefined,
    acceptableOrigin: true,
    features: getFeatureFlagsLazy({ req }),
    track: new Tracker(req, res),
    ip: resolveClientIpOrNull(req) ?? '',
    cache: {
      browserTTL: 3 * 60,
      edgeTTL: 3 * 60,
      staleWhileRevalidate: 60,
      canCache: true,
      skip: false,
    },
    res,
    req,
    domain,
    // Non-client-facing context — an always-open signal, matching publicApiContext2.
    signal: new AbortController().signal,
    tokenScope: TokenScope.Full,
    apiKeyId: undefined,
    subject: undefined,
    // No `as BlocksCaller` here: with `callerFactory` typed, the literal above is
    // checked against `Context` and the return type follows. Re-adding a cast would
    // silently restore the hole this removed.
  });
}
