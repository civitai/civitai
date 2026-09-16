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
  // 🔴 THIS SENTENCE IS A CONSENT PROMISE, NOT A LABEL. Three rules govern it.
  // The arc that produced them (four successive sentences, each retracted) is
  // recorded once, in `SUPERSEDED` in
  // `src/server/services/blocks/__tests__/scope-descriptions.consent-copy.test.ts`
  // — machine-readable, and next to the test that goes red. Do not restate it
  // here.
  //
  // 🔴 1. DO NOT ENUMERATE CAPABILITIES. Every enumerating draft was wrong
  // within one audit round — twice over-promising something unreachable, once
  // under-naming `video`, which an inline `customComfy` graph can in fact
  // produce (operator-confirmed 2026-09-16; that arm is bounded by no enum and
  // its read path applies no media-type check). A generic head noun asserts no
  // inventory, so a capability arriving cannot falsify it. Each failure costs a
  // re-consent of every live grant; the benefit of a list is specificity nobody
  // asked for.
  //
  // 🔴 2. "AI work", NOT "generation". The word this scope outgrew is
  // `generation` — the scope reaches hosted LLM inference (`chatCompletion`,
  // registered and live), which is not a generation in the sense a reader would
  // apply, and on Civitai "Generate" and "Train a LoRA" are two distinct
  // top-level actions. That is the entire justification for re-taking the live
  // grants, so the replacement must not reuse the root. A draft of this change
  // read "AI generation services" and was caught in audit for exactly this.
  //
  // 🔴 3. TRAINING IS NOT NAMED, AND THAT SUPERSEDES DECISION 6.
  // `appblocks-no-allowlist-decision-2026-09-15.md` §5a decision 6 required
  // this sentence to say "an app may train a model on the viewer's Buzz" in
  // words. Operator, 2026-09-16: superseded, because training is NOT REACHABLE
  // — `isBillingModeImplemented` accepts `'prepaidFixed'` only, so a
  // variable-cost training step cannot be registered at all. Naming it would
  // BANK permission for a widening that has not shipped, and nothing re-prompts
  // when it does; that is the silent scope escalation this table exists to
  // prevent. When #599 lands and training becomes reachable, this sentence
  // changes and the grants are re-taken again — the intended cost, not an
  // oversight. The same applies to any change of KIND rather than of modality.
  //
  // 🔴 CHANGING THIS STRING DOES NOT RE-ASK ANYBODY. Consent is stored per
  // (user, app) in `app_user_scope_grants` and the lookup does NOT read the
  // `version` column it stamps, so no app release re-prompts. Existing grants
  // must be revoked for the new text to be seen — the raw SQL for that is in
  // `scripts/oneoffs/2026-09-16-reconsent-ai-write-budgeted.sql`, and it is
  // applied BY HAND, AFTER this copy is confirmed live. Applied before, users
  // re-consent to the OLD sentence and the exercise is void while both halves
  // individually look done.
  'ai:write:budgeted': "Run AI work that spends the viewer's Buzz, with a per-call cap",
  'social:tip:self': 'Post tips on behalf of the viewer',
  'apps:storage:read': "Read this app's private per-install data store",
  'apps:storage:write': "Write to this app's private per-install data store",
  'apps:storage:shared:read':
    "Read this app's shared, community-wide data (e.g. everyone's posts + vote counts)",
  'apps:storage:shared:write':
    "Post + vote in this app's shared, community-wide data — visible to all users of the app",
  'collections:read:self':
    'Browse and read public Civitai collections, and your own public collections',
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
