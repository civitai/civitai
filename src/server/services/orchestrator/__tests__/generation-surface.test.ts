import { describe, expect, it } from 'vitest';

import {
  generationSurfaceForRequest,
  REQUEST_RESOLVED_GENERATION_SURFACES,
  type GenerationSurfaceRequest,
} from '~/server/services/orchestrator/generation-surface';
import { isGenerationSurface } from '~/shared/data-graph/generation/model-substitution';

/**
 * The request→surface mapping behind the `api` / `onsite` split (#3665).
 *
 * WHAT THIS OWNS, AND WHAT IT DOES NOT. `generation-surface-wiring` pins, from
 * the AST, that `orchestrator.router`'s two procedures pass THIS resolver and
 * nothing else. It structurally cannot check which surface a given request
 * produces — that is a runtime property, and it is this file's whole job.
 *
 * 🔴 THE SEAM IS CHECKED BY THE PRODUCTION CALL, NOT HERE. `tsconfig.json`
 * EXCLUDES `src/[**]/__tests__/[**]`, so a type-level assertion written in this
 * file would be checked by nothing (vitest transpiles without typechecking) —
 * the same hole the wiring guard's arity check documents. The real guarantee
 * that the tRPC `Context` still satisfies `GenerationSurfaceRequest` is the
 * `generationSurfaceForRequest(ctx)` call in `orchestrator.router.ts`: that IS
 * production code, tsc reads it, and it stops compiling the day `ctx.subject`
 * changes shape. Do not "strengthen" this file with a type assertion and count
 * it as coverage.
 */
describe('generationSurfaceForRequest', () => {
  // Every shape `createContext` can actually produce. `subject` and `apiKeyId`
  // are assigned INDEPENDENTLY in `get-server-auth-session` (`result.apiKeyId ??
  // null`, `result.subject ?? null`), which is why the one-field-only rows are
  // real cases and not paranoia.
  // 🔴 EVERY ROW SPELLS BOTH KEYS, including the `undefined` ones. That is not
  // noise: `GenerationSurfaceRequest` deliberately REQUIRES both keys (an
  // all-optional version is a weak type, which is what let
  // `generationSurfaceForRequest({})` type-check and silently resolve
  // everything to `onsite`). A fixture written as `{ apiKeyId: 7 }` therefore
  // does not satisfy the type — and `tsconfig.json` EXCLUDES `__tests__`, so
  // nothing here would tell you. Spelling both keys keeps this table honest
  // against the real type, and keeps it green if the test tree is ever added to
  // the typecheck (which the guard's own docblock argues for).
  const CASES: Array<{ name: string; req: GenerationSurfaceRequest; expected: string }> = [
    {
      name: 'cookie session (both fields undefined — what createContext returns)',
      req: { subject: undefined, apiKeyId: undefined },
      expected: 'onsite',
    },
    {
      name: 'cookie session (both fields explicitly null)',
      req: { subject: null, apiKeyId: null },
      expected: 'onsite',
    },
    {
      name: 'personal API key',
      req: { subject: { type: 'apiKey', id: 42 }, apiKeyId: 42 },
      expected: 'api',
    },
    {
      name: 'OAuth app token',
      req: { subject: { type: 'oauth', id: 'client-abc' }, apiKeyId: null },
      expected: 'api',
    },
    {
      name: 'bearer with apiKeyId but no subject',
      req: { subject: undefined, apiKeyId: 7 },
      expected: 'api',
    },
    {
      name: 'bearer with subject but no apiKeyId',
      req: { subject: { type: 'apiKey', id: 7 }, apiKeyId: undefined },
      expected: 'api',
    },
    // `apiKeyId: 0` is the one numerically-falsy id. A `!req.apiKeyId` test would
    // read it as a browser session; the implementation uses `!= null`.
    {
      name: 'apiKeyId of 0 (falsy, still bearer)',
      req: { subject: undefined, apiKeyId: 0 },
      expected: 'api',
    },
  ];

  it.each(CASES)('$name → $expected', ({ req, expected }) => {
    expect(generationSurfaceForRequest(req)).toBe(expected);
  });

  it('🔴 no bearer-authenticated request is ever labelled onsite (the #3665 regression)', () => {
    // The bug being fixed was a hardcoded 'onsite' on a procedure that serves
    // both. Stated as its own assertion so a future change that reintroduces it
    // for ANY bearer shape fails on the property, not on one table row.
    const bearer = CASES.filter((c) => c.expected === 'api');
    expect(bearer.length).toBeGreaterThan(0);
    for (const c of bearer) expect(generationSurfaceForRequest(c.req)).not.toBe('onsite');
  });

  it('🔴 produces every surface in its declared range, and only those', () => {
    // `generation-surface-wiring` credits this resolver's call sites with the
    // WHOLE of REQUEST_RESOLVED_GENERATION_SURFACES when it checks that no
    // declared surface is an orphan. That credit is only sound if the resolver
    // really can produce each one — otherwise a value listed here but never
    // returned would be certified as covered while nothing emits it.
    const produced = new Set(CASES.map((c) => generationSurfaceForRequest(c.req)));
    expect([...produced].sort()).toEqual([...REQUEST_RESOLVED_GENERATION_SURFACES].sort());
  });

  it('every produced value survives the runtime surface narrowing', () => {
    // The collector drops an unrecognised surface rather than putting it on the
    // counter, so a resolver returning something outside GENERATION_SURFACES
    // would silently emit nothing at all.
    for (const c of CASES)
      expect(isGenerationSurface(generationSurfaceForRequest(c.req))).toBe(true);
  });
});
