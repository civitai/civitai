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
 * A middleware bound to a module-scope constant and passed as `.use(thatConstant)` reads as
 * NEITHER here and fails.
 *
 * Out of reach:
 *   - A handler that hands `input` whole to something that reads the token off it.
 *   - A procedure added by object spread, or in another router file.
 *   - A procedure whose token-taking input the sibling's ledger does not list. The run-time
 *     half of this check, over the real router's input schemas, is in
 *     `blocks.router.bridgeViewerMiddleware.test.ts`, which also drives the middleware's steps.
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

function mechanisms(auth: Map<string, BridgeProcAuth>): Record<string, Mechanism | 'both'> {
  return Object.fromEntries([...auth].map(([name, a]) => [name, mechanismOf(a)] as const));
}

/** `getMyViewer`'s middleware link, exactly as the router spells it. A stale target fails loudly. */
const GET_MY_VIEWER_USE =
  /\n {4}\.use\(\n {6}authorizeBlockBridgeViewer\(\{[\s\S]*?\n {6}\}\)\n {4}\)/;

/** The first lines of `getMyViewer`'s handler, where the controls splice their mutations in. */
const HANDLER_OPENING =
  '\n    .mutation(async ({ ctx }) => {\n      const { claims, userId } = ctx.blockViewer;';

/** Rewrites `getMyViewer` only: the edit is applied to the text from its declaration on. */
function mutateGetMyViewer(text: string, target: string | RegExp, replacement: string): string {
  const start = text.indexOf('\n  getMyViewer: publicProcedure');
  expect(start, 'getMyViewer is no longer declared the way this control expects').toBeGreaterThan(
    -1
  );
  const tail = text.slice(start);
  const mutated = tail.replace(target, replacement);
  expect(mutated, 'the control changed nothing').not.toEqual(tail);
  return text.slice(0, start) + mutated;
}

const real = read(ROUTER);
const derived = bridgeProcAuth(real);
const realMechanisms = mechanisms(derived);
// A function, so a router that no longer matches fails the controls and not the whole file.
const withoutMiddleware = () => mutateGetMyViewer(real, GET_MY_VIEWER_USE, '');

const getMyViewerIn = (text: string) => bridgeProcAuth(text).get('getMyViewer');

describe('the bridge auth-mechanism scan can actually see what it claims to', () => {
  it('POSITIVE CONTROL — reads both mechanisms off the real router, a helper hop included', () => {
    expect(realMechanisms.getMyViewer).toBe('middleware');
    expect(realMechanisms.getMyBuzzBalance).toBe('inline');
    // Reaches the guard through `authorizeBlockBuzzRead` and never names it.
    expect(realMechanisms.getMyBuzzAccounts).toBe('inline');
  });

  it('a procedure that DROPS the middleware leaves the population — it has neither', () => {
    const mutated = bridgeProcAuth(withoutMiddleware());
    expect(mutated.has('getMyViewer')).toBe(false);
    expect([...mutated.keys()].sort()).not.toEqual(siblingInputLedger());
  });

  it('sees the middleware in other call shapes — type arguments, a cast, a computed access', () => {
    const auth = getMyViewerIn(
      mutateGetMyViewer(
        withoutMiddleware(),
        HANDLER_OPENING,
        `\n    ['use']((authorizeBlockBridgeViewer<never>(options as never)) as never)${HANDLER_OPENING}`
      )
    );
    expect(auth?.middlewareUses).toBe(1);
    expect(auth?.inputPrecedesUse).toBe(true);
  });

  it('NEGATIVE CONTROL — a commented-out or string-quoted `.use(…)` is not a use', () => {
    const mutated = mutateGetMyViewer(
      withoutMiddleware(),
      HANDLER_OPENING,
      "\n    // .use(authorizeBlockBridgeViewer({ scope: 'user:read:self' }))\n    .mutation(async ({ ctx }) => {\n      const note = '.use(authorizeBlockBridgeViewer({}))';\n      void note;\n      const { claims, userId } = ctx.blockViewer;"
    );
    expect(getMyViewerIn(mutated)).toBeUndefined();
  });

  it('NEGATIVE CONTROL — a `.use(…)` built inside the handler is not applied to the procedure', () => {
    const mutated = mutateGetMyViewer(
      withoutMiddleware(),
      HANDLER_OPENING,
      `${HANDLER_OPENING}\n      void publicProcedure.input(z.object({ blockToken: z.string() })).use(authorizeBlockBridgeViewer(options));`
    );
    expect(getMyViewerIn(mutated)).toBeUndefined();
  });

  it('a handler that ALSO calls the guard reads as both', () => {
    const mutated = mutateGetMyViewer(
      real,
      HANDLER_OPENING,
      '\n    .mutation(async ({ ctx, input }) => {\n      await authorizeBlockBridgeToken(input.blockToken);\n      const { claims, userId } = ctx.blockViewer;'
    );
    expect(mechanisms(bridgeProcAuth(mutated)).getMyViewer).toBe('both');
    expect(getMyViewerIn(mutated)?.blockTokenReads).toBe(1);
  });

  it('counts a token read spelled as a string key', () => {
    const mutated = mutateGetMyViewer(
      real,
      HANDLER_OPENING,
      "\n    .mutation(async ({ ctx, input }) => {\n      void input['blockToken'];\n      const { claims, userId } = ctx.blockViewer;"
    );
    expect(getMyViewerIn(mutated)?.blockTokenReads).toBe(1);
  });

  it('a `.use(…)` ahead of `.input(…)` is seen as out of order', () => {
    const mutated = mutateGetMyViewer(
      withoutMiddleware(),
      '\n  getMyViewer: publicProcedure',
      '\n  getMyViewer: publicProcedure\n    .use(authorizeBlockBridgeViewer(options))'
    );
    expect(getMyViewerIn(mutated)?.inputPrecedesUse).toBe(false);
  });

  it('a later `.use(…)` — one that could replace the viewer — is counted', () => {
    const mutated = mutateGetMyViewer(
      real,
      HANDLER_OPENING,
      `\n    .use(({ ctx, next }) => next({ ctx: { blockViewer: { ...ctx.blockViewer, userId: 0 } } }))${HANDLER_OPENING}`
    );
    expect(getMyViewerIn(mutated)?.usesAfterMiddleware).toBe(1);
  });

  it('a deferred refusal nobody reads is seen, and reading it clears it', () => {
    const deferring = mutateGetMyViewer(real, "onRefused: 'throw',", "onRefused: 'defer',");
    expect(getMyViewerIn(deferring)?.deferredRefusalUnread).toBe(true);

    const reading = mutateGetMyViewer(
      deferring,
      HANDLER_OPENING,
      `${HANDLER_OPENING}\n      if (ctx.blockViewer.rateLimitRefused) return null;`
    );
    expect(getMyViewerIn(reading)?.deferredRefusalUnread).toBe(false);
  });
});

describe('no bridge procedure without a ledgered auth mechanism', () => {
  it('ledgers EXACTLY how each procedure reaches the guard — both directions', () => {
    expect(realMechanisms).toEqual(AUTH_MECHANISM_LEDGER);
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

  it('a middleware procedure uses it once, last, after `.input()`, and leaves the token alone', () => {
    const users = [...derived].filter(([, auth]) => auth.middlewareUses > 0);
    expect(users.map(([name]) => name)).toContain('getMyViewer');
    for (const [name, auth] of users) {
      expect(auth, name).toEqual({
        middlewareUses: 1,
        inline: false,
        inputPrecedesUse: true,
        usesAfterMiddleware: 0,
        blockTokenReads: 0,
        deferredRefusalUnread: false,
      });
    }
  });

  it(`${VIEWER_MIDDLEWARE} calls the guard exactly once`, () => {
    expect(guardCallsInMiddleware(real)).toBe(1);
  });
});
