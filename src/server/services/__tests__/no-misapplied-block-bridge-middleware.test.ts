import { describe, expect, it } from 'vitest';
import {
  GUARD,
  ROUTER,
  bridgeProcAuth,
  parse,
  reachable,
  read,
  routerProcedures,
  siblingInputLedger,
} from './block-bridge-router-ast.harness';

/**
 * A bridge procedure in `blocks.router.ts` authorizes its block token one of two ways:
 *
 *   middleware — `.use(authorizeBlockBridgeViewer({ … }))` in its builder chain.
 *   inline     — its handler calls `authorizeBlockBridgeToken`, directly or through a
 *                router-local preamble helper.
 *
 * This file pins the SHAPE of a middleware procedure, and that no procedure does both: the
 * token would be authorized twice and the rate limit charged twice.
 *
 * `covers every procedure that takes a block token` is what makes the shape checks apply to
 * the whole population. A middleware reached some other way — bound to a constant, or
 * returned by a wrapper — is read as neither mechanism and fails there, so it cannot skip
 * the shape checks.
 *
 * Out of reach:
 *   - A handler that hands `input` or `ctx` whole to something that reads the token or the
 *     session user off it, or that reads them through an alias (`const c = ctx; c.user`).
 *   - Whether the handler USES the viewer for identity. "Names `blockViewer`" is met by any
 *     identifier of that name; for `getMyViewer` the identity is pinned behaviourally, in
 *     `blocks.router.bridgeViewerMiddleware.test.ts`.
 *   - A procedure added by object spread, or in another router file.
 *   - Whether the middleware's steps are right; `blocks.router.bridgeViewerMiddleware.test.ts`
 *     and the block-token characterisation suites drive them.
 */

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
// A function, so a router that no longer matches fails the controls and not the whole file.
const withoutMiddleware = () => mutateGetMyViewer(real, GET_MY_VIEWER_USE, '');

const getMyViewerIn = (text: string) => bridgeProcAuth(text).get('getMyViewer');
const spliceIntoHandler = (text: string, before: string, after = '') =>
  mutateGetMyViewer(text, HANDLER_OPENING, `${before}${HANDLER_OPENING}${after}`);

describe('the bridge auth-mechanism scan can actually see what it claims to', () => {
  it('POSITIVE CONTROL — reads both mechanisms off the real router, a helper hop included', () => {
    expect(derived.get('getMyViewer')).toMatchObject({ middlewareUses: 1, inline: false });
    expect(derived.get('cancelWorkflow')).toMatchObject({ middlewareUses: 0, inline: true });
    // Reaches the guard through `authorizeBlockPostRequest` and never names it: with no
    // helpers to follow, the walk does not find the guard.
    const previewPostFromApp = routerProcedures(parse(real)).get('previewPostFromApp');
    expect(reachable(previewPostFromApp as never, new Map()).has(GUARD)).toBe(false);
    expect(derived.get('previewPostFromApp')).toMatchObject({ middlewareUses: 0, inline: true });
  });

  it('a procedure that DROPS the middleware leaves the population — it has neither', () => {
    const mutated = bridgeProcAuth(withoutMiddleware());
    expect(mutated.has('getMyViewer')).toBe(false);
    expect([...mutated.keys()].sort()).not.toEqual(siblingInputLedger());
  });

  it('sees the middleware in other call shapes — type arguments, a cast, a computed access', () => {
    const auth = getMyViewerIn(
      spliceIntoHandler(
        withoutMiddleware(),
        "\n    ['use']((authorizeBlockBridgeViewer<never>(options as never)) as never)"
      )
    );
    expect(auth).toMatchObject({ middlewareUses: 1, inputPrecedesUse: true });
  });

  it('NEGATIVE CONTROL — a commented-out or string-quoted `.use(…)` is not a use', () => {
    const mutated = spliceIntoHandler(
      withoutMiddleware(),
      "\n    // .use(authorizeBlockBridgeViewer({ scope: 'user:read:self' }))",
      "\n      const note = '.use(authorizeBlockBridgeViewer({}))';\n      void note;"
    );
    expect(getMyViewerIn(mutated)).toBeUndefined();
  });

  it('NEGATIVE CONTROL — a `.use(…)` built inside the handler is not applied to the procedure', () => {
    const mutated = spliceIntoHandler(
      withoutMiddleware(),
      '',
      '\n      void publicProcedure.input(z.object({ blockToken: z.string() })).use(authorizeBlockBridgeViewer(options));'
    );
    expect(getMyViewerIn(mutated)).toBeUndefined();
  });

  it('a middleware returned by a wrapper is read as neither mechanism', () => {
    const mutated = mutateGetMyViewer(
      real,
      GET_MY_VIEWER_USE,
      '\n    .use(someWrapperReturningTheMiddleware())'
    );
    expect(getMyViewerIn(mutated)).toBeUndefined();
  });

  it('a handler that ALSO calls the guard reads as both, and as reading the token', () => {
    const mutated = mutateGetMyViewer(
      real,
      HANDLER_OPENING,
      '\n    .mutation(async ({ ctx, input }) => {\n      await authorizeBlockBridgeToken(input.blockToken);\n      const { claims, userId } = ctx.blockViewer;'
    );
    expect(getMyViewerIn(mutated)).toMatchObject({
      middlewareUses: 1,
      inline: true,
      blockTokenReads: 1,
    });
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

  it.each([
    [
      '.use',
      '\n    .use(({ ctx, next }) => next({ ctx: { blockViewer: { ...ctx.blockViewer } } }))',
    ],
    ['.concat', '\n    .concat(aBuilderThatReplacesBlockViewer)'],
  ])('a %s link after the middleware is counted', (_link, link) => {
    expect(getMyViewerIn(spliceIntoHandler(real, link))?.linksAfterMiddleware).toBe(1);
  });

  it.each([
    ['ctx.user', '\n      void ctx.user?.id;'],
    ["ctx['user']", "\n      void ctx['user'];"],
    ['const { user } = ctx', '\n      const { user } = ctx;\n      void user;'],
    ['(ctx as T).user', '\n      void (ctx as { user?: unknown }).user;'],
    ['ctx!.user', '\n      void ctx!.user;'],
    ['(ctx).user', '\n      void (ctx).user;'],
  ])('a handler reading the session user as `%s` is seen', (_shape, statement) => {
    const auth = getMyViewerIn(spliceIntoHandler(real, '', statement));
    expect(auth?.handlerReadsSessionUser).toBe(true);
  });

  it('a handler reading it off its whole argument, as `opts.ctx.user`, is seen', () => {
    const mutated = mutateGetMyViewer(
      real,
      HANDLER_OPENING,
      '\n    .mutation(async (opts) => {\n      void opts.ctx.user;\n      const { claims, userId } = opts.ctx.blockViewer;'
    );
    expect(getMyViewerIn(mutated)?.handlerReadsSessionUser).toBe(true);
  });

  it('a handler destructuring the session user out of its argument is seen', () => {
    const mutated = mutateGetMyViewer(
      real,
      HANDLER_OPENING,
      '\n    .mutation(async ({ ctx: { user, blockViewer } }) => {\n      const { claims, userId } = blockViewer;'
    );
    expect(getMyViewerIn(mutated)?.handlerReadsSessionUser).toBe(true);
  });

  it('NEGATIVE CONTROL — `dbWrite.user` is not the session user', () => {
    expect(real).toContain('await dbWrite.user.findUnique({\n        where: { id: userId },');
    expect(derived.get('getMyViewer')?.handlerReadsSessionUser).toBe(false);
  });

  it('a handler that never names the viewer is seen', () => {
    const mutated = mutateGetMyViewer(
      real,
      HANDLER_OPENING,
      '\n    .mutation(async ({ ctx }) => {\n      const { claims, userId } = somethingElse(ctx);'
    );
    expect(getMyViewerIn(mutated)?.handlerReadsViewer).toBe(false);
  });
});

describe('bridge procedures authorize by one mechanism, and the middleware in one shape', () => {
  it('covers every procedure that takes a block token — a middleware reached any other way is neither', () => {
    expect([...derived.keys()].sort()).toEqual(siblingInputLedger());
  });

  it('no procedure uses BOTH mechanisms', () => {
    const both = [...derived].filter(([, auth]) => auth.middlewareUses > 0 && auth.inline);
    expect(both.map(([name]) => name)).toEqual([]);
  });

  it('a middleware procedure uses it once, as the last link, after `.input()`; its handler reads the viewer it was given, not the token or the session user', () => {
    const users = [...derived].filter(([, auth]) => auth.middlewareUses > 0);
    expect(users.map(([name]) => name)).toContain('getMyViewer');
    for (const [name, auth] of users) {
      expect(auth, name).toEqual({
        middlewareUses: 1,
        inline: false,
        inputPrecedesUse: true,
        linksAfterMiddleware: 0,
        blockTokenReads: 0,
        handlerReadsViewer: true,
        handlerReadsSessionUser: false,
      });
    }
  });
});
