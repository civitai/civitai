import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  setUserCheckpointOverride,
  userCheckpointSetInput,
} from '~/server/services/blocks/user-settings.service';
import { blockBearerToken } from '~/server/utils/block-bearer';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

/**
 * POST /api/v1/blocks/user-checkpoint/set  body `{ versionId }` → `{ ok: true }`
 *
 * Persist (or CLEAR, with `versionId: null`) the VIEWER's own checkpoint override for the
 * install the block token names — the REST twin of the `SET_USER_CHECKPOINT` →
 * `USER_CHECKPOINT_SET` bridge message pair.
 *
 * A thin adapter over `setUserCheckpointOverride`, which is the SAME body
 * `trpc.blocks.updateUserSettings` reaches, so every gate runs verbatim, in one place, and
 * none of them is re-spelled here:
 *   - the anon refusal and the `app-blocks-enabled` audience check on the TOKEN subject;
 *   - the `assertViewerIsAppDeveloper` authoring gate (see the CONSUMER NOTE below);
 *   - the HARD `ctx.modelId` + `ctx.slotId` requirement;
 *   - the `(modelId, slotId, viewer)` install re-resolution, which is what makes synthetic
 *     instance ids fail closed;
 *   - the manifest filter (`forScope: 'viewer'`) and the write-time ecosystem re-validation.
 * See `VIEWER SETTINGS: ONE BODY, TWO TRANSPORTS` in `user-settings.service.ts`.
 *
 * 🔴 THE KEYING IS NOT A PARAMETER, AND THAT IS THE POINT. `block_user_settings` is keyed
 * `(block_instance_id, user_id)`, and this route accepts NEITHER half. Both come from the
 * verified JWT — `claims.blockInstanceId` and `parseSubjectUserId(claims.sub)` — so a caller
 * cannot write an override into an install its token does not already authorise, and cannot
 * write one on another viewer's behalf. The request body carries exactly one field. A future
 * edit that added a `blockInstanceId` or `userId` parameter here would silently make this
 * route disagree with the bridge about whose setting it is writing; `user-checkpoint-keying`
 * pins the whole shape against exactly that.
 *
 * 🔴 A FAILED WRITE REJECTS — IT NEVER RESOLVES `{ ok: false }`, and both transports depend
 * on that. The bridge's `USER_CHECKPOINT_SET { ok:false, error }` is synthesised by the HOST
 * from a caught rejection, and the SDK's `useCheckpointPicker().persist()` THROWS it. A 2xx
 * body meaning "not written" would be read as a successful persist by every caller, so
 * success → 200 `{ ok: true }` and every refusal → a thrown `TRPCError` → non-2xx through
 * `handleEndpointError`. There is no 2xx path that means "not written". Same contract as
 * `app-storage/set.ts`.
 *
 * ANONYMOUS VIEWERS GET 401, AND THE DECISION IS DELIBERATE (#5089). An anonymous viewer has
 * no `user_id` to key the row on — the write's own primary key requires one — so there is
 * nothing to persist and nothing to persist it against. The shared body throws
 * `UNAUTHORIZED` (`anon viewers cannot persist block settings`), which `handleEndpointError`
 * maps to 401, and that is the SAME refusal, with the same message, that an anonymous caller
 * already gets over the bridge. It is NOT silently treated as a success: an app that persisted
 * a "saved" checkpoint for an anon viewer would show them a setting that vanishes on reload,
 * which is exactly the confusion the shipped consumer's session-only note exists to describe.
 * Note this route declares NO `requiredScope`, so the refusal comes from the BODY rather than
 * from `enforceContextBinding` — unlike the app-storage routes, whose scoped 403 fires in the
 * middleware before their handler runs. Different status, same posture, and stated here
 * because the divergence is real.
 *
 * NO `requiredScope`, MATCHING THE BRIDGE EXACTLY. `blocks.updateUserSettings` enforces no
 * block scope: its audit row explicitly labels the ACTION (`user-settings:write`) rather than
 * claiming a `block:settings:write` scope, because that scope was decorative, unenforced, and
 * has been removed. Inventing a token scope for the REST twin alone would mean an app could
 * do this over the bridge and not over REST — the two transports disagreeing about the same
 * viewer's setting, which is the one outcome this whole surface exists to prevent. The write
 * is authorized by valid-token + non-anon + app-developer + install resolution, all in the
 * shared body.
 *
 * 🔴 CONSUMER NOTE — THIS ROUTE ALONE DOES NOT LET AN ORDINARY VIEWER PERSIST. The shared
 * body's `assertViewerIsAppDeveloper` gate means a viewer who is not an app AUTHOR is refused
 * FORBIDDEN over BOTH transports. That gate is pre-existing and was carried over unchanged
 * precisely so REST and the bridge stay identical; whether a PER-VIEWER setting belongs behind
 * an AUTHORING capability is a real open question, but it is a POLICY change affecting the
 * bridge as much as this route and is tracked separately. Do not "fix" it here — fixing it on
 * one transport is how the two come to disagree.
 *
 * Response: `{ ok: true }`.
 */

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

  // Parsed with the service's OWN schema (imported, not re-spelled).
  const parsed = userCheckpointSetInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await setUserCheckpointOverride(blockBearerToken(req), parsed.data.versionId);
    res.status(200).json(result);
    return;
  } catch (error) {
    // `handleEndpointError`, so failures answer `{ message }` and this route stays off the
    // known-leak list in `rest-error-envelope-ledger.test.ts`.
    return handleEndpointError(res, error);
  }
});

// 🔴 NO `stashBlockActionDetail` HERE, AND THE OMISSION IS DELIBERATE — the same decision
// #5068 recorded for `workflows/submit.ts` and `app-storage/set.ts`, for the same reason.
// The shared body already writes its OWN `block_scope_invocations` row
// (`endpoint: 'user-settings:write'`, `detail.action: 'settings.update'`), and it is the
// better row: it is the one the Activity panel already renders through `describeBlockAction`,
// and it is identical whichever transport produced it. `withBlockScope` then writes its own
// access row for this REST call, as it does for every wrapped route. So ONE REST write
// produces TWO rows where the same write over the bridge produces one — `Saved your block
// settings` and `Saved your checkpoint choice (API) · /api/v1/blocks/user-checkpoint/set`.
// That cost is stated rather than left to be discovered, and the labels are deliberately
// DIFFERENT so the pair reads as "action + the API call that caused it" rather than as two
// identical writes. The second label is why `'user-checkpoint'` is in
// `KNOWN_STATIC_ENDPOINT_SEGMENTS`: without it the audit row records the normalised
// `/api/v1/blocks/:seg/set` and the Activity panel falls through to rendering a raw string.
//
// allowOpaqueOrigin: an UNVERIFIED block direct-fetches this from an opaque origin
// (`Origin: null`), so it needs `ACAO: null` to clear the CORS preflight; the Bearer
// block-JWT (no cookies) remains the sole authz gate — mirrors app-storage/set.ts.
//
// NO `onApprovalLookupFailure` — this is a WRITE, so it fails closed on a lookup failure.
export default withBlockScope(baseHandler, {
  endpoint: 'user_checkpoint_set',
  allowOpaqueOrigin: true,
});
