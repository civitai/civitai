/**
 * Friendly per-scope + per-slot descriptions surfaced in the App Blocks UI.
 *
 * Shared by:
 *   - /apps/review (mod-facing manifest viewer)
 *   - /apps/activity (viewer-facing "what does this app claim" section)
 *
 * Unknown scope/slot ids render as bare chips without a description —
 * keeping this map a soft contract means new scopes ship without breaking
 * the UI.
 *
 * SCOPE_DESCRIPTIONS mirrors the comments in
 * src/shared/constants/block-scope.constants.ts.
 *
 * SLOT_DESCRIPTIONS mirrors the KNOWN_SLOT_IDS enum in
 * src/server/routers/blocks.router.ts — keep in sync when adding new
 * slots (W8 roadmap).
 */

export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'user:read:self': "Read the viewer's username and account status",
  'models:read:self': 'Read the model on the page where the block is mounted',
  'buzz:read:self': "Read the viewer's Buzz balance",
  // 🔴 THIS SENTENCE IS A CONSENT PROMISE, NOT A LABEL — and it was rewritten
  // because the scope's MEANING widened underneath it, not because the old
  // wording was unclear.
  //
  // It previously read "Submit generations with a per-call Buzz cap". Under the
  // no-allowlist direction the per-call cap half is still exactly true, but
  // "generations" stopped being: the scope now reaches hosted LLM inference
  // (`chatCompletion`, registered and live), which is not a generation in any
  // sense a reader of the old sentence would have understood. A user who agreed
  // to the old sentence did not agree to this one.
  //
  // 🔴 THIS SENTENCE NAMES ONLY WHAT IS REACHABLE TODAY, AND THAT IS LOAD-BEARING.
  // Promising a capability that has not shipped and re-consenting NOW would BANK
  // the permission — and when it does ship, nothing re-prompts, because consent
  // is stored per (user, app) and no lookup reads a version. That is precisely
  // the "silent scope escalation" this table was created to prevent (see its
  // migration header).
  //
  // 🔴 TWO CAPABILITIES HAVE ALREADY BEEN CUT FROM THIS SENTENCE FOR THAT
  // REASON, IN SUCCESSIVE AUDIT ROUNDS — which is why the rule is written out
  // rather than left as a judgement:
  //
  //   - "training models". ALLOWED by the denylist, NOT reachable:
  //     `isBillingModeImplemented` accepts `'prepaidFixed'` ONLY, so a
  //     variable-cost training step cannot even be registered.
  //   - "and video". Also not reachable: `blockWorkflowBodySchema` has three
  //     members, `textToImage` is bounded to `BLOCK_IMAGE_WORKFLOW_TYPES`
  //     (txt2img / img2img / img2img:edit), both registered recipes are image,
  //     and both registered steps are `convertImage` / `chatCompletion`.
  //     `workflow.schema.ts` says a non-image media class is "a later phase".
  //
  // 🔴 THE RULE, because "name only what is reachable" was applied TWICE and a
  // second unreachable capability still shipped in the same sentence: reach for
  // the WIRE, not for the denylist. A `$type` being allowed says nothing about
  // whether any arm accepts it. Enumerate `blockWorkflowBodySchema`'s members,
  // then what each one actually admits, and write down only that.
  //
  // When a capability named here becomes reachable, that is fine. When a
  // capability NOT named here becomes reachable, this sentence must change AND
  // the grants must be re-taken again. Do not pre-load it.
  //
  // ⚠️ An inline `customComfy` graph is the one arm whose reach is not bounded
  // by an enum in this repo. If it turns out a stock-node graph can produce
  // video or audio, that is a capability this sentence does not name — decide
  // and write it down rather than discovering it after the grants are re-taken.
  //
  // 🔴 CHANGING THIS STRING DOES NOT RE-ASK ANYBODY. Consent is stored per
  // (user, app) in `app_user_scope_grants` and the lookup does NOT read the
  // `version` column it stamps, so no app release re-prompts. Existing grants
  // must be revoked for the new text to be seen — the raw SQL for that is in
  // `scripts/oneoffs/2026-09-16-reconsent-ai-write-budgeted.sql`, and it is
  // applied BY HAND, AFTER this copy is confirmed live. Applied before, users
  // re-consent to the OLD sentence and the exercise is void while both halves
  // individually look done.
  'ai:write:budgeted':
    "Run AI work that spends the viewer's Buzz, with a per-call cap — including generating images and running language models",
  'social:tip:self': 'Post tips on behalf of the viewer',
  'apps:storage:read': "Read this app's private per-install data store",
  'apps:storage:write': "Write to this app's private per-install data store",
  'apps:storage:shared:read': "Read this app's shared, community-wide data (e.g. everyone's posts + vote counts)",
  'apps:storage:shared:write': "Post + vote in this app's shared, community-wide data — visible to all users of the app",
  'collections:read:self': 'Browse and read public Civitai collections, and your own public collections',
  'collections:write:self': 'Bookmark (follow) collections on your behalf',
  'collections:read:private': 'Read your private collections',
  'posts:write:self':
    "Publish posts to your profile from this app's own results — you approve each one",
};

export const SLOT_DESCRIPTIONS: Record<string, string> = {
  'model.sidebar_top': 'Top of the model page sidebar',
  'model.below_images': 'Below the model page image gallery',
  'model.actions_extra': 'Among the model page action buttons',
};
