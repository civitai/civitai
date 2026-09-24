import type { NextApiRequest } from 'next';

/**
 * The raw Bearer block JWT off an `/api/v1/blocks/*` request.
 *
 * ONE SPELLING, intended as the shared one for every block REST route that
 * forwards the token to a body which verifies it again. "One rule, one place"
 * exists for: a predicate copied N times is typically wrong at N-1 of them, and
 * a case-sensitivity or trim difference between two copies is exactly the kind
 * of divergence nothing would ever fail on until it did.
 *
 * 🔴 BE HONEST ABOUT WHAT THIS PR ACTUALLY CONSOLIDATED: very nearly nothing.
 * Measured on both trees with one command shape — `startsWith('bearer '` over
 * `src/**` `.ts`/`.tsx` — the open-coded spelling appears in **19 files, 20
 * occurrences** on `origin/main` and in **19 files, 20 occurrences** here. The
 * delta is ZERO. This PR removed exactly one open-coding (`blockWorkflowBearer`
 * in `block-workflow-rest.ts`, which now delegates here) and added exactly one
 * (this function's own body). An earlier draft of this docblock claimed
 * "thirteen call sites" going to twelve; that number was never measured, and it
 * also contradicted its own enumeration — one `blockWorkflowBearer` plus eleven
 * shared-storage routes is twelve, not thirteen.
 *
 * What this function actually bought is COUNTERFACTUAL, not a reduction: the
 * five new `/app-storage/*` routes call it instead of open-coding five MORE
 * copies. That is worth having, but it is avoided growth, not consolidation.
 *
 * Excluding this definition, **19 open-coded copies remain across 18 files**:
 * the eleven `/shared-storage/*` routes, plus `dev-token`, `submissions`,
 * `submit-version`, `blocks/withdraw`, `moderator-endpoint`, one test, and two
 * in `block-scope.middleware`. They are deliberately left alone here — they are
 * live routes whose behaviour this change must not touch, and converting them
 * is a mechanical follow-up with its own review, not something to smuggle into
 * a feature PR. The real 20 → 1 consolidation is still unwritten.
 *
 * 🔴 RETURNS `''`, NOT `undefined` OR `null`, on every failure to find a token.
 * Callers hand the result straight to a verifier that must REJECT it; an empty
 * string fails a `z.string().min(1)` bound and every signature check, so the
 * fail-closed direction is the default one. Returning a nullish value would make
 * `?? someFallback` at a call site silently succeed.
 */
export function blockBearerToken(req: NextApiRequest): string {
  const auth = req.headers.authorization ?? '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice('bearer '.length).trim() : '';
}
