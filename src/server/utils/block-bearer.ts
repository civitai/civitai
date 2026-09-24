import type { NextApiRequest } from 'next';

/**
 * The raw Bearer block JWT off an `/api/v1/blocks/*` request.
 *
 * ONE SPELLING, shared by every block REST route that forwards the token to a
 * body which verifies it again. Before this existed the same three lines were
 * open-coded at thirteen call sites (`blockWorkflowBearer` plus a private
 * `bearer()` in each of the eleven shared-storage routes) — the shape "One rule,
 * one place" exists for: a predicate copied N times is typically wrong at N-1 of
 * them, and a case-sensitivity or trim difference between two copies is exactly
 * the kind of divergence nothing would ever fail on until it did.
 *
 * The `/app-storage/*` routes were the point at which a FOURTEENTH copy would
 * have been written, so it was centralised here instead of copied again.
 * `blockWorkflowBearer` now delegates to this function, so the count went DOWN
 * rather than up. The eleven shared-storage routes are deliberately left alone:
 * they are live routes whose behaviour this change must not touch, and
 * converting them is a mechanical follow-up with its own review, not something
 * to smuggle into a feature PR.
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
