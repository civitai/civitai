import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import type { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { dbWrite } from '~/server/db/client';
import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { assertAppBlocksEnabledForTokenUser } from '~/server/services/blocks/block-token-access.service';
import { checkBlockCatalogRateLimit } from '~/server/utils/block-catalog-rate-limit';

/**
 * GET /api/v1/blocks/me
 *
 * Block-side identity endpoint. Returns a minimal viewer profile derived
 * from the block JWT subject claim. Distinct from /api/v1/me by design:
 *
 *   - /api/v1/me uses AuthedEndpoint (session cookie or API key/OAuth);
 *     wrapping it with withBlockScope dead-codes the block path because
 *     the inner session check 401s first.
 *   - This route's outer auth IS withBlockScope; there is no session
 *     fallback. Anon block tokens are rejected (no anonymous viewer
 *     identity).
 *
 * Scope: `user:read:self` (audit I3). The previous gate was buzz:read:self,
 * which forced every block that wanted a viewer name to ask for a
 * buzz-bit scope — semantic mismatch + over-privileged. user:read:self
 * is the least-privileged scope that conveys "viewer identity."
 *
 * buzzBudget is still surfaced on the response when the JWT carries the
 * ai:write:budgeted claim — a block that wants the budget along with
 * identity asks for both scopes in its manifest.
 *
 * CORS: handled in withBlockScope from BLOCK_ALLOWED_ORIGINS.
 *
 * ## THIS ROUTE AND `blocks.getMyViewer` ARE TWO FRONT DOORS TO ONE CAPABILITY
 *
 * `blocks.getMyViewer` (`blocks.router.ts`) is the host-mediated bridge twin of this
 * route and backs the SDK `useViewer()` hook. The two are kept aligned deliberately, and
 * `blocks.router.me-parity.test.ts` pins it as BEHAVIOUR rather than as a promise in
 * prose — read that file's header for the full statement of what is and is not shared.
 *
 * 🔴 THIS ROUTE CARRIED A HARDCODED `if (!user.isModerator) → 403` UNTIL 2026-09-18 AND
 * IT IS GONE ON PURPOSE. It was a pre-Flipt vestige, commented "App Blocks is
 * moderator-only until GA"; `getMyViewer` never had it. The divergence stayed invisible
 * because the live `app-blocks-enabled` audience is MOSTLY moderators, for whom the
 * literal refused nobody the flag would have admitted — but it is not ONLY moderators:
 * the audience also holds hand-allowlisted non-moderator userIds, and for every one of
 * them this route already 403'd while the tRPC twin returned 200. ⚠️ THAT LAST FACT IS
 * NOT VERIFIABLE FROM THIS REPO — it is a reading of the live Flipt segment taken
 * 2026-09-18, and it is what makes the divergence present-tense rather than
 * latent-until-GA. If the segment is ever mods-only, dropping the literal changes nothing
 * that day and this is purely a GA-safety change. Re-read Flipt rather than trusting this
 * sentence.
 *
 * The Flipt flag is the gate, so the literal was dropped and the flag gate `getMyViewer`
 * already had was added here instead. DO NOT RE-ADD an `isModerator` literal to narrow
 * the audience: narrow the Flipt segment.
 *
 * 🔴 THE PRICE OF THAT PARITY IS TWO NEW REFUSAL DEPENDENCIES:
 *
 *   1. THE AUTH HUB. The gate resolves the subject via `sessionClient.getSessionUserById`,
 *      and a `null` subject is a refusal here. That returns `null` on an unset
 *      `AUTH_INTERNAL_TOKEN` and on a hub failure — BOTH behind the shared
 *      `session:data2:<userId>` cache, which the ordinary cookie path also warms, so
 *      neither refuses a cache-warm viewer. Before this change the handler read `dbWrite`
 *      and nothing else, so this door had no hub leg at all.
 *   2. THE `app-blocks-enabled` FLAG ITSELF — deleted, renamed, or its segment emptied, a
 *      moderator this route used to serve is refused, because `isAppBlocksEnabled` has NO
 *      moderator floor (its sibling `isAppBlocksAuthorEnabled` does; this one does not).
 *
 * Both are exactly what the tRPC twin already carries, and accepting them is the point of
 * the change. What is worth knowing beyond the diff is that a refusal from (1) is
 * BYTE-IDENTICAL on the wire to a policy refusal from (2) — both 401 `Apps are not
 * enabled` — so neither this route's response nor its logs can tell an operator which
 * fired. See the catch below for where the signal does live.
 *
 * ⚠️ DELIBERATELY NO RANKING, NO PERCENTAGES AND NO PROPAGATION TIMES HERE, because five
 * consecutive review rounds found this paragraph asserting one. It has claimed, wrongly,
 * that the route never consulted Flipt; that a hub outage refuses everyone; that the
 * unset-token branch is unconditional; and that the flag has no cache in front of it and
 * propagates instantly. Each was a plausible-sounding comparative that depended on cache
 * and poll behaviour in three other packages, and each went stale or was wrong on first
 * contact with the source. The couplings above are durable; their relative blast radii are
 * not, and a route docblock is the wrong place to pin them. Read the caches (`readCachedUser`
 * in `packages/civitai-auth`, the eval `TtlCache` in `packages/civitai-flipt`) at the time
 * you need the answer.
 *
 * ⚠️ AN EARLIER REVISION OF THIS PARAGRAPH NAMED A THIRD COUPLING THAT IS NOT NEW, and
 * got the mechanism wrong in the process: it said "before, this route never consulted
 * Flipt at all", so a Flipt outage now 401s it. False. `withBlockScope` has always called
 * `isAppBlocksRuntimeEnabled()` on every block-JWT request, and on an outage that
 * resolves `false` and the wrapper treats a present token as ABSENT — the handler then
 * 401s `Block token required` without this gate ever running. So the outage-401 predates
 * this change and cannot be attributed to it; a responder following the old sentence
 * would have looked past the hub leg above, which is the one that IS new.
 *
 * ⚠️ Do NOT reach for the `availability:['mod']` feature-flag fallback as a floor here:
 * that mechanism serves `hasFeature` / `ctx.features` (it is what gives the MINT path its
 * mod floor), not this gate. An earlier revision cited it as if it applied.
 */
const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    // withBlockScope only invokes this handler when a valid block JWT
    // is present; this guard exists for defense in depth.
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  let userId: number | null;
  try {
    userId = parseSubjectUserId(claims.sub);
  } catch {
    res.status(403).json({ error: 'Invalid subject claim' });
    return;
  }
  if (userId == null) {
    res.status(403).json({ error: 'Anonymous block tokens may not call /blocks/me' });
    return;
  }

  // The App-Blocks kill-switch, evaluated against the TOKEN subject — the SAME shared
  // gate `getMyViewer` calls, imported rather than re-spelled so the two front doors
  // cannot drift. It is what replaced this route's hardcoded moderator literal, and it
  // is also the defense-in-depth that literal was reaching for: block-token minting is
  // gated on this same flag, but a token minted just before the subject leaves the
  // audience stays valid for up to ~15min.
  //
  // The gate throws `TRPCError` because its other caller is a tRPC proc, so this is the
  // one place the two doors' protocols have to be bridged. Two rules, both load-bearing:
  //
  //   STATUS is DERIVED, never hand-written — `getHTTPStatusCodeFromError` is tRPC's OWN
  //   code→status map, so for THIS refusal the status is by construction the one the
  //   bridge answers. (The route's other statuses — 405/401/403/404/429 — are literals on
  //   both sides and agree by inspection, not by derivation; this sentence is about the
  //   gate only.) Detection is duck-typed on `.code` rather than `instanceof`, matching
  //   the four sibling routes in this directory: `instanceof` fails across a duplicated
  //   `@trpc/server` instance in an API-route bundle, which would rethrow into a 500.
  //
  //   The MESSAGE is a LITERAL WE OWN, and the gate's own message is deliberately NOT
  //   echoed. Two independent reasons. (a) `rest-error-envelope-ledger.test.ts` blocks any
  //   REST route that serialises a caught error's `.message` into a body — the shape, not
  //   this instance, is the hazard, and restructuring to dodge that regex is called out
  //   there as the wrong direction. (b) The gate's two messages are deliberately distinct
  //   so an OPERATOR can separate them in a log; a third-party block iframe has no use for
  //   "the subject could not be resolved" and it is not ours to disclose. So both refusals
  //   render as one literal here while staying separable at the throw site. 🔴 The
  //   unhydratable-subject message is additionally a compiled-branch watchlist ANCHOR that
  //   must stay unique app-wide — re-spelling it here to win message parity would break
  //   that guard. The parity test therefore compares STATUS on this branch, not text, and
  //   says so.
  //   The SPELLING is the siblings' (`<binding> as TRPCError`, then
  //   `typeof trpcError?.code === 'string'`), deliberately, so a future `@trpc/server` shape
  //   change is greppable across all of them at once rather than across three phrasings.
  //   (Only the caught binding's name differs — `err` here, `error` in the siblings.)
  //   What differs here is the DISPOSITION: the siblings fall back to 500 and serialise
  //   the message, this one rethrows a non-TRPC error (matching `withBlockScope`'s own
  //   `catch`) and never serialises. 🔴 The catch is WIDER than `TRPCError` by
  //   construction — anything with a string `.code` thrown inside the gate (a hub/Redis
  //   `ECONNREFUSED`, a Prisma `P2xxx`) renders as this refusal. That is fail-closed
  //   (`getHTTPStatusCodeFromError` maps an unknown code to 500, never to a 2xx) but it
  //   is NOT observable here: a session-hub outage makes `getSessionUserById` return
  //   null, which is byte-identical on the wire to a policy refusal. The signal that
  //   separates them is out-of-band — the `identity-by-id` leg of `observeSessionLeg` in
  //   the session client — so look there, not in this route's logs. 🔴 LOOK AT THE WHOLE
  //   LEG, NOT AT ONE OUTCOME: a hub failure is only `error`/`timeout` when the hub is
  //   UNREACHABLE. When it ANSWERS non-ok — a 5xx, or a 401 from a wrong or rotated
  //   `AUTH_INTERNAL_TOKEN` — the leg records `miss`, which is also what a legitimately
  //   vanished user produces, and nothing on the series separates those two. An earlier
  //   revision named only `error`/`timeout` here, which would have cleared the hub during
  //   exactly the outage shapes an operator is most likely to hit. And one sub-case emits
  //   NOTHING: an UNSET `AUTH_INTERNAL_TOKEN` returns before the leg is instrumented at
  //   all, so it is invisible on the metric AND byte-identical on the wire — check the
  //   env, not the dashboard, for that one.
  try {
    await assertAppBlocksEnabledForTokenUser(userId);
  } catch (err) {
    const trpcError = err as TRPCError;
    if (typeof trpcError?.code === 'string') {
      res.status(getHTTPStatusCodeFromError(trpcError)).json({ error: 'Apps are not enabled' });
      return;
    }
    throw err;
  }

  // Per-instance rate limit (the shared blocks catalog bucket, keyed on the stable
  // `blockInstanceId`) — BEFORE the db read below, which hits the PRIMARY. Same bucket
  // and same placement as `getMyViewer`. This route was one of three block REST routes
  // with no limiter at all; the other two (`shared-storage/top.ts`,
  // `collections/[id]/follow.ts`) still have none, so do not read this as "the surface is
  // uniformly limited". Fail-open on a redis incident, by construction inside the helper.
  const rateLimit = await checkBlockCatalogRateLimit(claims.blockInstanceId);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    return;
  }

  // M1: dbWrite for ban/mute/deleted lookup. The token endpoint uses
  // dbWrite for the same check; reading from the replica here lets a
  // banned-during-replication-lag user surface to the block as active.
  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      bannedAt: true,
      muted: true,
      deletedAt: true,
    },
  });
  if (!user || user.deletedAt) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  // M1+M6: a banned user with a still-valid session must NOT be surfaced
  // to blocks as a real viewer. The token-issuance endpoint already gates
  // on this, but a token minted just before a ban is still valid for up to
  // 15 minutes. Reject here as a second line of defense. Muted users pass
  // through with `status: 'muted'` so the block can suppress write UI.
  if (user.bannedAt) {
    res.status(403).json({ error: 'banned' });
    return;
  }

  res.status(200).json({
    id: user.id,
    username: user.username,
    status: user.muted ? 'muted' : 'active',
    // buzzBudget is the per-call spend cap the block was issued with —
    // surfaces here so the block can clamp UI without a second API call.
    //
    // 🔴 THE DECLARED CEILING, NOT THE GRANTED ONE. `claims.buzzBudget` carries
    // the declared budget plus author-fee headroom; reporting that sum would tell
    // an app it can afford a generation the fee then pushes over the gate. The
    // declared number answers the question a block is actually asking — how
    // expensive may my generation be. A refusal message quotes the other one, on
    // purpose; see the gate in `blocks.router.ts`.
    buzzBudget: claims.buzzBudgetDeclared ?? claims.buzzBudget ?? null,
  });
});

export default withBlockScope(baseHandler, { endpoint: 'me', requiredScope: 'user:read:self' });
