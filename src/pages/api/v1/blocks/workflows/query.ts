import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  blockWorkflowBearer,
  blockWorkflowCaller,
} from '~/server/services/blocks/block-workflow-rest';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

/**
 * POST /api/v1/blocks/workflows/query  body `{ cursor?, limit? }`
 *   → `{ workflows: AppWorkflow[], cursor }`
 * Scope `ai:write:budgeted`.
 *
 * The calling app's OWN tag-scoped slice of the viewer's generation workflows —
 * the REST twin of the `QUERY_APP_WORKFLOWS` bridge message (`useAppWorkflows`
 * in `@civitai/blocks-react`), and the route a block rebuilding its in-flight +
 * done generation queue lives on after it ports off the postMessage bridge.
 *
 * 🔴 THE FILTER IS SERVER-DERIVED AND THE REQUEST BODY CANNOT REACH IT. THAT IS
 * THE ENTIRE POINT OF THIS ROUTE, AND THE ONE PROPERTY A REVIEWER SHOULD CHECK
 * FIRST. The app scope on this read is a HOST-FORCED positive tag filter
 * `tags: ['app-block:<appId>']`, built inside `blocks.queryAppWorkflows` from
 * `claims.appId` off the VERIFIED block JWT. It is the security boundary that
 * keeps the read to the app's own subqueue and OUT of the viewer's personal
 * generations, and the bridge's own contract is that "the block can never widen
 * the filter".
 *
 * TWO INDEPENDENT LAYERS KEEP THAT TRUE HERE, and they fail in different
 * directions on purpose:
 *
 *   1. THIS ROUTE'S BODY SCHEMA IS `z.strictObject`, so a body carrying ANY key
 *      the schema does not declare — `tags` above all, but equally `appId`,
 *      `userId` or a second `blockToken` — is a 400 `unrecognized_keys` BEFORE
 *      any delegation happens. The divergence from its four siblings (all plain
 *      `z.object`) is deliberate: `z.object` would SILENTLY STRIP `tags`, and a
 *      block author who sent one would then receive a plausible, correctly-narrow
 *      answer and ship code believing their filter took effect. A loud refusal
 *      makes the trust boundary audible to the one caller who needs to hear it.
 *      (It is the only `strictObject` among the five `/workflows/*` routes;
 *      `blocks/tools.ts` closes its own body schema with `.strict()`, so it is
 *      not the only closed schema under `/api/v1/blocks/`.)
 *
 *      🔴 WHAT THIS DOES **NOT** CATCH, stated because an earlier draft of this
 *      docblock claimed it did and was WRONG — measured, not argued.
 *      `app.orchestration.queryWorkflows({ tags })` in `@civitai/sdk` does take
 *      `tags` FROM THE CALLER, and a block reaching for it instead of this route
 *      really does relocate a server-enforced boundary into the iframe while
 *      type-checking cleanly. But that client is a **GET** to a DIFFERENT HOST
 *      (`DEFAULT_ORCHESTRATION_URL`, path `v2/consumer/workflows`) with `tags` in
 *      the QUERY STRING. Pointed at this path it meets the 405 method guard
 *      below and never reaches the schema; `tags` never enters a body at all, so
 *      the strict schema cannot see it. (Precisely: Next parses the body BEFORE
 *      the handler runs, so what the 405 precedes is this route's own validation,
 *      not body parsing — an earlier draft said "before any body parsing", which
 *      is wrong about the ordering even though the conclusion holds.) "This catches the SDK substitute" is FALSE and must
 *      not be re-derived as a reason to keep the schema.
 *
 *      ⚠ THE REAL SUBSTITUTE RISK IS NOT INTERCEPTABLE HERE AT ALL: a block
 *      talking to `orchestration.civitai.com` directly with its own token never
 *      touches civitai.com. What layer 1 genuinely buys is narrower — a
 *      hand-rolled `fetch` POST to THIS route carrying `tags` gets told no
 *      instead of being quietly narrowed. That is worth having and is what the
 *      tests actually measure; it is not the same claim.
 *
 *      ⚠ AND THE COST SIDE, which the first draft never weighed. `strictObject`
 *      makes this the one route on the surface where a NEWER CLIENT TALKING TO AN
 *      OLDER SERVER is a hard 400: add a paging or filter field server-side, have
 *      the SDK start sending it, and every request landing on a pod that has not
 *      rolled yet fails un-retryably for the length of the rolling deploy. The
 *      four `z.object` siblings structurally cannot have that window, and neither
 *      can a client that attaches a benign extra key (a tracing or request id).
 *      Accepted deliberately — the audibility above is judged worth it on the one
 *      route whose whole point is a filter the caller must not control — but it
 *      is a trade-off, not a free win, and a future field addition on this route
 *      needs a client-then-server ordering the siblings do not.
 *
 *   2. AND IF LAYER 1 WERE DELETED, THE BOUNDARY WOULD STILL HOLD — which is
 *      why it is defence in depth rather than the guard itself. The route
 *      forwards three explicitly-named fields (`blockToken`, `cursor`, `limit`)
 *      and never spreads `req.body`; the procedure's input schema declares no
 *      `tags` field, so zod strips one that arrives anyway; and the tag handed
 *      to the orchestrator LIST is `appBlockTag(claims.appId)`, unconditionally,
 *      with no `??` fallback to anything client-supplied. Both layers are pinned
 *      — the strict schema in `workflows-endpoints.test.ts`, the end-to-end
 *      property (forged `tags` in the body cannot broaden the orchestrator
 *      filter) through the REAL procedure in `workflows-controls-seam.test.ts`.
 *
 * WHY A tRPC CALLER RATHER THAN A SERVICE EXTRACTION, since #5054/#5055 set the
 * other precedent and #5085 (`/app-storage/*`) followed it. That precedent does
 * not transfer to a procedure living in `blocks.router.ts`:
 * `no-unguarded-block-bridge-token.test.ts` computes guard reachability
 * TEXTUALLY, inside `blocks.router.ts` only, and its own docblock states the
 * consequence — "a proc that delegates to an imported helper which calls the
 * guard reads as UNGUARDED here and will fail". `queryAppWorkflows` is a ledgered
 * entry in that file's `GUARD_CALL_SITE_LEDGER`, so moving its body to a service
 * would take a fail-closed security guard offline to satisfy a style preference.
 * The `apps.router.ts` storage procedures are outside that scan, which is why the
 * extraction was correct there and is not correct here. This route therefore
 * matches its four siblings in this directory and reuses `blockWorkflowCaller`,
 * whose module docblock carries the rest of the argument.
 *
 * ANON: 401, and it is the PROCEDURE'S refusal, not this route's. `withBlockScope`
 * does not stop an anon subject here — `enforceContextBinding`'s
 * `ai:write:budgeted` case binds `claims.buzzBudget > 0`, not `sub != 'anon'` —
 * so the handler runs, and `queryAppWorkflows` throws `UNAUTHORIZED` ("workflow
 * query requires authenticated viewer") on a `sub` that parses to no user id.
 * `handleEndpointError` renders that as a 401.
 *
 * 🔴 DELIBERATELY 401 AND NOT THE 403 `/app-storage/*` CHOSE (civitai/civitai#5089
 * is the live question on that). The two are not the same situation and copying
 * the storage answer here would be wrong in both directions: on storage the
 * middleware refuses the request before the handler, so 403 is a statement about
 * the TOKEN; here the request is legitimately shaped and it is the VIEWER
 * BINDING that is missing, which is what 401 means. It also keeps this route
 * byte-identical in refusal to its four workflow siblings, which is the
 * comparison an SDK author actually makes — a query that 403s while a poll on
 * the same token 401s would read as an authorization difference that does not
 * exist. If #5089 settles on one answer for the whole block surface, this route
 * moves with it; it should not move alone.
 *
 * 🔴 THE ERROR CONTRACT — 2xx IFF THE PROCEDURE RESOLVED, the same rule as the
 * other four. Note what it means HERE specifically: the rate-limit refusal on
 * this procedure THROWS `TOO_MANY_REQUESTS` (unlike `pollWorkflow`, which sheds
 * by RESOLVING a non-terminal snapshot), so it reaches the wire as a 429 and the
 * caller must back off rather than treat it as an empty subqueue. An adapter that
 * turned it into `{ workflows: [] }` would tell a block its queue had drained.
 *
 * ACTIVITY FEED: `/api/v1/blocks/workflows/query` gets its own arm in
 * `humaniseScopeInvocation` (`AppActivityPanel.tsx`) — "Listed AI workflows".
 * Without one it would fall past the endpoint arms into `SCOPE_ACTION_LABELS`
 * and render as "Submit AI workflow" — the hazard #5068 found and closed.
 *
 * ⚠ NOT "the mislabelling #5068 SHIPPED", which an earlier draft of this line
 * said and which the history does not support: `git log -S "Checked an AI
 * workflow"` returns exactly one commit, `2a2eb0fe2f` (#5068), and that squash
 * added `workflows/poll.ts` AND its label arm together. No row ever rendered
 * wrong in production. The hazard is real and this arm is why it stays closed;
 * the production-history claim was not.
 *
 * Response: `{ workflows, cursor }` — `workflows` is the `AppWorkflow[]`
 * projection (`{ workflowId, status, images, cost, createdAt }`) the bridge
 * delivers in `APP_WORKFLOWS_RESULT`; `cursor` is the opaque keyset cursor, or
 * `null` when the page is the last one.
 */

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };

/**
 * 🔴 `strictObject`, NOT `object` — see layer 1 of the trust-boundary note above.
 * The bounds mirror `blocks.queryAppWorkflows`'s own input minus `blockToken`
 * (which rides the Authorization header here): `limit` 1..50 and `cursor` a
 * bounded opaque string. The procedure applies the `?? 20` page-size default, so
 * it is NOT restated here — one constant, one place.
 */
const bodySchema = z.strictObject({
  cursor: z.string().min(1).max(256).nullish(),
  limit: z.number().int().min(1).max(50).optional(),
});

// Exported for unit testing (the default export is wrapped in withBlockScope,
// whose JWT gate would otherwise have to be satisfied to reach this handler).
export const baseHandler = withAxiom(async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  // 🔴 A ZERO-ARGUMENT POST IS THIS ROUTE'S PRIMARY CALL SHAPE, AND NEXT DOES NOT
  // HAND IT OVER AS `{}`. `req.body ?? {}` alone is NOT enough, and the bug it
  // left was measured on the real handler rather than reasoned about:
  //
  //   req.body === undefined  -> 200   (there is no body at all)
  //   req.body === ''         -> 400   ← a POST with no body and no Content-Type
  //   req.body === '{}'       -> 400   ← a JSON body sent with no Content-Type
  //
  // Next's `parseBody` defaults a MISSING `Content-Type` to `text/plain` and then
  // returns the RAW STRING, so a bodyless POST arrives as `''`. `'' ?? {}` is
  // `''` — `??` only catches null/undefined — and `strictObject.safeParse('')`
  // fails with `expected object, received string`.
  //
  // 🔴 THAT BROKE THE EXACT SPELLING THIS ROUTE EXISTS TO ENABLE. `query` is the
  // only one of the five whose whole input is optional, so `fetch(url, { method:
  // 'POST', headers: { Authorization } })` with no body is the natural call — and
  // `@civitai/sdk`'s own `createHttp` sets `Content-Type` ONLY when
  // `opts.body !== undefined`, making it the DEFAULT spelling for an argument-less
  // POST. Worse, the 400 it produced was indistinguishable at a glance from the
  // trust-boundary 400 below, which is the one refusal on this route that is
  // supposed to be unambiguous.
  //
  // ⚠ THE COERCION IS DELIBERATELY NARROW: an EMPTY-or-whitespace string only. A
  // non-empty string body still reaches the schema and still 400s — this route
  // does NOT re-implement JSON parsing to rescue a client that omitted its
  // `Content-Type`, because guessing at an unlabelled payload is how a body gets
  // interpreted two different ways by two different layers. Sending JSON means
  // sending the header; sending nothing now means nothing.
  const rawBody = req.body;
  const body = typeof rawBody === 'string' && rawBody.trim() === '' ? {} : rawBody ?? {};

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }

  try {
    const caller = await blockWorkflowCaller(req, res);
    // 🔴 THREE NAMED FIELDS, NEVER `...req.body` AND NEVER `...parsed.data`. The
    // spread is the shape that would re-open the boundary the moment the schema
    // above gained a field, and it buys nothing: the procedure's contract is
    // three keys wide. `tags` is absent here because it is absent from the
    // contract — the app scope is derived inside the procedure from the verified
    // token, and there is no request-side expression of it to forward.
    const result = await caller.queryAppWorkflows({
      blockToken: blockWorkflowBearer(req),
      ...(parsed.data.cursor != null ? { cursor: parsed.data.cursor } : {}),
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    });
    res.status(200).json(result);
    return;
  } catch (error) {
    // See estimate.ts — `handleEndpointError`, so failures answer `{ message }`
    // and this route stays off the known-leak list in
    // `rest-error-envelope-ledger.test.ts`. The scope refusal is `FORBIDDEN`
    // (403), the anon refusal `UNAUTHORIZED` (401) and the rate-limit shed
    // `TOO_MANY_REQUESTS` (429).
    return handleEndpointError(res, error);
  }
});

// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque
// origin (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight;
// the Bearer block-JWT (no cookies) remains the sole authz gate — mirrors
// images.ts; see WithBlockScopeOpts.allowOpaqueOrigin.
export default withBlockScope(baseHandler, {
  endpoint: 'workflows_query',
  requiredScope: 'ai:write:budgeted',
  allowOpaqueOrigin: true,
});
