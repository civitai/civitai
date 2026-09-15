import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import { appBlockTag } from '~/server/services/blocks/workflow.service';
import { workflowOwnerId } from '~/server/services/orchestrator/assert-workflow-owner';

/**
 * Scoping assertions for a `workflowId` that arrived in a block-token procedure's INPUT rather than
 * off the verified block JWT. They are what turn that string back into a scoped reference: the
 * workflow must be the CALLING VIEWER's, and it must be one the CALLING APP produced.
 *
 * 🔴 THERE ARE THREE BLOCK-WORKFLOW ACCESS GATES AND ONLY TWO OF THEM LIVE HERE. The third is
 * `blockWorkflowOwnedByAppUser` in `~/server/services/blocks/block-workflows.service.ts`, a
 * `block_workflows` read-model lookup keyed on (userId, appBlockId, workflowId). Named here because
 * this file is where the next person will look for all three.
 *
 * 🔴 AND THE TWO SCHEMES ARE NOT INTERCHANGEABLE — do not swap one for the other while
 * consolidating. `cancelAppWorkflow` / `publishGenerationOutputs` / `resolveOwnedWorkflowOutputs`
 * bind their viewer with the read-model row, which is per-APP-BLOCK; the viewer assertion below
 * binds only the USER. Replacing the row check with it would WIDEN those three from per-app-block
 * to per-user. What the two schemes genuinely share is the app-tag half — which is why that half is
 * this module's, called from all five sites, and the viewer half is not.
 *
 * The row is deliberately not part of the pair this module offers: `upsertBlockWorkflowOnSubmit` is
 * fire-and-forget behind its own swallowing try/catch, and the submit sites skip it entirely for
 * `claims.dev === true`, so its absence does not mean what a gate would need it to mean.
 */

/**
 * VIEWER SCOPE. The orchestrator mints every workflow id server-side as
 * `<owning userId>-<timestamp>` (a client cannot supply one), so the id itself names its owner and
 * a plain equality against the token's `sub` is a complete viewer binding.
 *
 * 🔴 FAIL-CLOSED on an id whose owner cannot be read, which is the OPPOSITE of the submit-path
 * `assertWorkflowOwner`. The reasoning does not transfer between the two, because the ids do not
 * have the same provenance: there, the id was just handed back by the orchestrator for a
 * legitimate submit, so refusing an unfamiliar shape would destroy real work. Here the id is
 * request input, so an unreadable owner means only that the caller named something this host
 * cannot attribute — and there is no legitimate caller in that position:
 *
 *   - `parseSubjectUserId` accepts `user:<positive int>` and nothing else, and both callers reject
 *     an anonymous subject before reaching this, so `userId` is always >= 1.
 *   - Every block submit path runs as that real positive user, so every workflow a block can
 *     legitimately name was minted `<that same positive userId>-…` and parses.
 *   - The two non-conforming shapes the orchestrator does mint — `0-<guid>` for anonymous/system
 *     submits, and a configured negative identity such as `-100-…` — therefore belong to
 *     submitters that are not the block's viewer either way, and are correctly refused. (`0-…`
 *     parses fine and is refused by the equality; `-100-…` splits to `''` and returns null.)
 *
 * DEV EXEMPTION, for the same reason `assertWorkflowOwner` has one: with `ORCHESTRATOR_MODE=dev`,
 * `getOrchestratorToken` hands every user the shared system credential, so the orchestrator
 * attributes every locally-submitted workflow to the system account and the prefix can never match
 * the viewer. This is a local-development-only mode; `dev:live` block tokens are NOT this — they
 * carry a real viewer against the real orchestrator, so their ids do carry that viewer's id and
 * they are checked like any other. 🔴 THE EXEMPTION IS THIS ASSERTION'S ALONE — it must never be
 * widened to `assertBlockWorkflowTaggedForApp`, whose premise has nothing to do with which
 * credential was used. `blocks.router.workflowScope.test.ts` pins both halves of that.
 */
export function assertBlockWorkflowMintedForViewer(input: {
  workflowId: string;
  userId: number;
}): void {
  if (env.ORCHESTRATOR_MODE === 'dev') return;
  if (workflowOwnerId(input.workflowId) === input.userId) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'workflow does not belong to this viewer',
  });
}

/**
 * APP SCOPE. The orchestrator's own record for the workflow must carry the calling app's
 * provenance tag. `buildWorkflowTags` stamps `app-block:<appId>` on every workflow a block submit
 * creates, and `appBlockTag` is the same helper on both ends, so the STAMP and this READ cannot
 * desync.
 *
 * THE ONLY SPELLING OF THIS PREDICATE. It was open-coded at three other sites before — two in
 * `blocks.router.ts` and one in `block-post.service.ts` — which is four copies of one security
 * decision, and a semantic change (a second admissible tag, a prefix rule, an exemption) would have
 * landed in one of them while the other three kept the old behaviour. All five call sites now come
 * through here. The message is the one those three already threw, so no live refusal changed.
 *
 * FAIL-CLOSED on absent tags. `Workflow.tags` is a required field on the orchestrator wire type, so
 * the `?? []` is a belt rather than a live branch — an empty array means the workflow genuinely
 * carries no app provenance, which no block-submitted workflow does. Deliberately NO env exemption:
 * the premise is about what the record says, not about which credential fetched it.
 */
export function assertBlockWorkflowTaggedForApp(input: {
  tags: readonly string[] | null | undefined;
  appId: string;
}): void {
  if ((input.tags ?? []).includes(appBlockTag(input.appId))) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'workflow is not tagged for this app',
  });
}
