import { describe, expect, it } from 'vitest';
import { BLOCK_TOKEN_QUERY_PROCEDURES } from '~/shared/constants/block-token-transport.constants';
import {
  ROUTER,
  VIEWER_MIDDLEWARE,
  bridgeProcAuth,
  guardCallsInMiddleware,
  read,
  siblingInputLedger,
  type BridgeProcAuth,
} from './block-bridge-router-ast.harness';

/**
 * Every bridge procedure in `blocks.router.ts` authorizes its block token by exactly ONE of two
 * mechanisms, and which one is written down:
 *
 *   `middleware` — `.use(authorizeBlockBridgeViewer({ … }))` in its builder chain.
 *   `inline`     — its handler calls `authorizeBlockBridgeToken`, directly or through a
 *                  router-local preamble helper.
 *
 * Neither is the defect `no-unguarded-block-bridge-token.test.ts` exists for. Both is a second
 * defect: the token would be authorized twice and the rate limit charged where the middleware
 * says, then again wherever the handler says.
 *
 * Out of reach: a middleware bound to a module-scope constant and passed as `.use(thatConstant)`
 * reads as NEITHER here and fails. Whether the middleware's steps are right is not a question
 * for this file; `blocks.router.bridgeViewerMiddleware.test.ts` drives them.
 */

type Mechanism = 'middleware' | 'inline';

/** Moving a procedure between mechanisms is a change to this table. */
const AUTH_MECHANISM_LEDGER: Readonly<Record<string, Mechanism>> = Object.freeze({
  cancelAppWorkflow: 'inline',
  cancelWorkflow: 'inline',
  consentQuoteGrant: 'inline',
  consentTrainingQuote: 'inline',
  createPostFromApp: 'inline',
  estimateWorkflow: 'inline',
  estimateWorkflowBatch: 'inline',
  getImagesByIds: 'inline',
  getMyBuzzAccounts: 'inline',
  getMyBuzzBalance: 'inline',
  getMyBuzzTransactions: 'inline',
  getMyDailyCompensation: 'inline',
  getMyViewer: 'middleware',
  listMyWorkflows: 'inline',
  persistAppUploadImage: 'inline',
  pollWorkflow: 'inline',
  prepareTrainingDataset: 'inline',
  previewPostFromApp: 'inline',
  previewQuoteGrant: 'inline',
  previewTrainingQuote: 'inline',
  publishGenerationOutputs: 'inline',
  queryAppWorkflows: 'inline',
  submitWorkflow: 'inline',
  updateUserSettings: 'inline',
});

function mechanismOf(auth: BridgeProcAuth): Mechanism | 'both' {
  if (auth.middlewareUses > 0 && auth.inline) return 'both';
  return auth.middlewareUses > 0 ? 'middleware' : 'inline';
}

function mechanisms(text: string): Record<string, Mechanism | 'both'> {
  return Object.fromEntries(
    [...bridgeProcAuth(text)].map(([name, auth]) => [name, mechanismOf(auth)] as const).sort()
  );
}

/** `getMyViewer`'s middleware link, exactly as the router spells it. A stale target fails loudly. */
const GET_MY_VIEWER_USE =
  /\n {4}\.use\(\n {6}authorizeBlockBridgeViewer\(\{[\s\S]*?\n {6}\}\)\n {4}\)/;

/** The first lines of `getMyViewer`'s handler, where the controls splice their mutations in. */
const HANDLER_OPENING =
  '\n    .mutation(async ({ ctx }) => {\n      const { claims, userId } = ctx.blockViewer;';

function withoutGetMyViewerMiddleware(text: string): string {
  const start = text.indexOf('\n  getMyViewer: publicProcedure');
  expect(start, 'getMyViewer is no longer declared the way this control expects').toBeGreaterThan(
    -1
  );
  const tail = text.slice(start);
  const mutated = tail.replace(GET_MY_VIEWER_USE, '');
  expect(mutated, 'the control removed nothing').not.toEqual(tail);
  return text.slice(0, start) + mutated;
}

const real = read(ROUTER);
const derived = bridgeProcAuth(real);

describe('the bridge auth-mechanism scan can actually see what it claims to', () => {
  it('POSITIVE CONTROL — reads both mechanisms off the real router, a helper hop included', () => {
    expect(mechanisms(real).getMyViewer).toBe('middleware');
    expect(mechanisms(real).getMyBuzzBalance).toBe('inline');
    // Reaches the guard through `authorizeBlockBuzzRead` and never names it.
    expect(mechanisms(real).getMyBuzzAccounts).toBe('inline');
  });

  it('a procedure that DROPS the middleware leaves the population — it has neither', () => {
    const mutated = mechanisms(withoutGetMyViewerMiddleware(real));
    expect(mutated.getMyViewer).toBeUndefined();
    expect(Object.keys(mutated).sort()).not.toEqual(siblingInputLedger());
  });

  it('sees the middleware in other call shapes — type arguments, a cast, a computed access', () => {
    const mutated = withoutGetMyViewerMiddleware(real).replace(
      HANDLER_OPENING,
      `\n    ['use']((authorizeBlockBridgeViewer<never>(options as never)) as never)${HANDLER_OPENING}`
    );
    expect(mutated).not.toEqual(withoutGetMyViewerMiddleware(real));
    const auth = bridgeProcAuth(mutated).get('getMyViewer');
    expect(auth?.middlewareUses).toBe(1);
    expect(auth?.inputPrecedesUse).toBe(true);
  });

  it('NEGATIVE CONTROL — a commented-out or string-quoted `.use(…)` is not a use', () => {
    const mutated = withoutGetMyViewerMiddleware(real).replace(
      HANDLER_OPENING,
      "\n    // .use(authorizeBlockBridgeViewer({ scope: 'user:read:self' }))\n    .mutation(async ({ ctx }) => {\n      const note = '.use(authorizeBlockBridgeViewer({}))';\n      void note;\n      const { claims, userId } = ctx.blockViewer;"
    );
    expect(mutated).not.toEqual(withoutGetMyViewerMiddleware(real));
    expect(bridgeProcAuth(mutated).has('getMyViewer')).toBe(false);
  });

  it('a handler that ALSO calls the guard reads as both', () => {
    const mutated = real.replace(
      HANDLER_OPENING,
      '\n    .mutation(async ({ ctx, input }) => {\n      await authorizeBlockBridgeToken(input.blockToken);\n      const { claims, userId } = ctx.blockViewer;'
    );
    expect(mutated).not.toEqual(real);
    expect(mechanisms(mutated).getMyViewer).toBe('both');
    expect(bridgeProcAuth(mutated).get('getMyViewer')?.blockTokenReads).toBe(1);
  });

  it('a `.use(…)` ahead of `.input(…)` is seen as out of order', () => {
    const mutated = withoutGetMyViewerMiddleware(real).replace(
      '\n  getMyViewer: publicProcedure',
      '\n  getMyViewer: publicProcedure\n    .use(authorizeBlockBridgeViewer(options))'
    );
    expect(bridgeProcAuth(mutated).get('getMyViewer')?.inputPrecedesUse).toBe(false);
  });
});

describe('no bridge procedure without a ledgered auth mechanism', () => {
  it('ledgers EXACTLY how each procedure reaches the guard — both directions', () => {
    expect(mechanisms(real)).toEqual(
      Object.fromEntries(Object.entries(AUTH_MECHANISM_LEDGER).sort())
    );
  });

  it('every procedure that TAKES a block token has one — none has neither', () => {
    expect([...derived.keys()].sort()).toEqual(siblingInputLedger());
  });

  it('covers every token-bearing QUERY this router serves', () => {
    const queries = [...BLOCK_TOKEN_QUERY_PROCEDURES]
      .filter((path) => path.startsWith('blocks.'))
      .map((path) => path.slice('blocks.'.length));
    expect(queries).toContain('listMyWorkflows');
    expect(queries.filter((name) => !derived.has(name))).toEqual([]);
  });

  it('a middleware procedure uses it once, after `.input()`, and never touches the token itself', () => {
    const users = [...derived].filter(([, auth]) => auth.middlewareUses > 0);
    expect(users.map(([name]) => name)).toContain('getMyViewer');
    for (const [name, auth] of users) {
      expect(auth, name).toEqual({
        middlewareUses: 1,
        inline: false,
        inputPrecedesUse: true,
        blockTokenReads: 0,
      });
    }
  });

  it(`${VIEWER_MIDDLEWARE} calls the guard exactly once`, () => {
    expect(guardCallsInMiddleware(real)).toBe(1);
  });
});
