import type { GenerationSurface } from '~/shared/data-graph/generation/model-substitution';

/**
 * HOW A REQUEST WAS AUTHENTICATED — the only two fields that distinguish a
 * browser session from a bearer token. Structural, not an import of `Context`,
 * so this module stays free of the tRPC context's transitive graph (redis /
 * clickhouse / prom-client) and is unit-testable on its own.
 *
 * 🔴 BOTH KEYS ARE REQUIRED, THOUGH EITHER VALUE MAY BE `undefined`. That looks
 * pedantic and is load-bearing: with both optional this is a WEAK type, and TS's
 * weak-type check passes any object sharing at least one property name — so a
 * bare `generationSurfaceForRequest({})` type-checks clean and silently resolves
 * every request to `onsite`, i.e. reinstates the exact #3665 defect with a green
 * build and a green guard suite. (Measured: `{}` produced 0 tsc errors and 84/84
 * guard tests passing before this change.) Requiring the keys makes `{}` a
 * compile error while still accepting the real `ctx`, whose two fields are always
 * PRESENT and merely `undefined` under cookie auth (`createContext` returns them
 * unconditionally).
 */
export type GenerationSurfaceRequest = {
  /** Set only for bearer auth — `{ type: 'apiKey' | 'oauth', id }`; `undefined` under a session. */
  subject: { type: 'apiKey'; id: number } | { type: 'oauth'; id: string } | null | undefined;
  /** Set only for bearer auth; `undefined` under a session. */
  apiKeyId: number | null | undefined;
};

/**
 * Which {@link GenerationSurface} a shared tRPC generation procedure is serving
 * on THIS request (#3665).
 *
 * 🔴 WHY THIS EXISTS AS A FUNCTION AT ALL. Every other surface is a property of
 * its CALL SITE — `blocks.router`'s bridge is always `block`, preset generation
 * is always `preset` — so those pass a literal and `generation-surface-wiring`
 * pins it statically. `orchestrator.router`'s two procedures are the exception:
 * ONE procedure serves both the on-site generator and every external caller,
 * because `AIServicesRead`/`AIServicesWrite` are user-grantable scopes and the
 * procedures carry them deliberately. The surface there is a property of the
 * REQUEST, and no static pin can express it.
 *
 * 🔴 THE DISCRIMINATOR IS `subject`/`apiKeyId`, AND IT IS NOT NEGOTIABLE.
 * `createContext` sets both ONLY for bearer auth (`get-server-auth-session`
 * populates them off the token result); cookie-session auth leaves both absent.
 * Two nearby fields look usable and are NOT:
 *   - `tokenScope` is `TokenScope.Full` for a cookie session AND for a
 *     full-access personal API key, so it cannot separate them at all.
 *   - a `user-agent` / `origin` sniff is caller-controlled, i.e. exactly the
 *     "guessed at the clamp" failure the surface label was introduced to avoid.
 *
 * Both fields are read because `get-server-auth-session` assigns them
 * independently (`result.apiKeyId ?? null`, `result.subject ?? null`) — a token
 * result carrying one but not the other is bearer auth either way, and must not
 * fall through to `onsite`. `onsite` is the DEFAULT only in the sense that
 * "no bearer evidence" is what a browser session looks like.
 *
 * 🔴 SAME INPUT AS `Tracker.setProvenance`, DELIBERATELY DIFFERENT OUTPUT.
 * That reads the same two fields to tag content-creation events `'web' |
 * 'api-key' | 'oauth'`. This does not import it (the Tracker drags in the
 * ClickHouse client) and does not reuse its vocabulary, because this label feeds
 * one question — was the correction observable to the caller? — for which a
 * personal key and an OAuth app are the same answer. The shared thing is the
 * DISCRIMINATOR (`ctx.subject`), which is declared once in `createContext`; the
 * two mappings off it are per-consumer by design.
 */
export function generationSurfaceForRequest(
  req: GenerationSurfaceRequest
): RequestResolvedGenerationSurface {
  return req.subject != null || req.apiKeyId != null ? 'api' : 'onsite';
}

/**
 * The surfaces {@link generationSurfaceForRequest} can actually return.
 *
 * 🔴 DECLARED HERE SO IT IS NOT DECLARED TWICE. `generation-surface-wiring`
 * pins every call site to the surface it must produce; for a literal call site
 * that is one string it can read off the AST, but a RESOLVED call site has a
 * RANGE, and a range hand-copied into the guard would be a second source of
 * truth that drifts silently the day this function learns a third answer.
 * The guard imports this; `generation-surface.test.ts` proves the set is
 * exhaustive by execution rather than trusting the annotation.
 *
 * Subset of `GENERATION_SURFACES` — `block` and `preset` are properties of
 * their call sites and can never be produced from a request.
 */
export const REQUEST_RESOLVED_GENERATION_SURFACES = [
  'api',
  'onsite',
] as const satisfies readonly GenerationSurface[];

export type RequestResolvedGenerationSurface =
  (typeof REQUEST_RESOLVED_GENERATION_SURFACES)[number];
