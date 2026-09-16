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
  // 🔴 IT DELIBERATELY DOES NOT ENUMERATE CAPABILITIES ANY MORE, AND THAT IS THE
  // WHOLE POINT OF THE CURRENT WORDING. Enumerating was tried and it failed
  // three times in a row, each time discovered by a later audit round:
  //
  //   - "training models" — CUT. Allowed by the denylist but not reachable:
  //     `isBillingModeImplemented` accepts `'prepaidFixed'` ONLY, so a
  //     variable-cost training step cannot even be registered.
  //   - "and video" — CUT as unreachable, on the reasoning that
  //     `blockWorkflowBodySchema` has three members, `textToImage` is bounded to
  //     `BLOCK_IMAGE_WORKFLOW_TYPES`, both recipes are image and both registered
  //     steps are `convertImage` / `chatCompletion`.
  //   - 🔴 AND THAT SECOND CUT WAS ITSELF WRONG. Operator-confirmed
  //     2026-09-16: an inline `customComfy` graph CAN generate video. The enum
  //     reasoning was sound for every arm it covered and simply did not cover
  //     the one arm bounded by no enum — `customComfy` `mode:'inline'`, which
  //     forwards an arbitrary graph, and whose read path applies no media-type
  //     check (`workflow.service.ts` pushes every available blob url into
  //     `imageUrls`).
  //
  // So the enumeration was wrong in BOTH directions inside one short arc:
  // over-promising twice, then under-naming a capability that was live all
  // along. Under-naming is the worse error for consent — the user agrees to
  // "images" while the app spends their Buzz on video.
  //
  // 🔴 THE FIX IS STRUCTURAL, NOT A BETTER LIST. A generic term cannot be
  // falsified by a capability arriving or turning out to be reachable, because
  // it asserts no inventory. "AI generation services" covers image, video, LLM
  // inference and whatever the inline arm grows next, and it stays true without
  // anyone re-auditing the wire. Do NOT reintroduce a list of modalities here;
  // the cost of getting one wrong is a re-consent of every live grant, and the
  // benefit is specificity nobody asked for.
  //
  // What DOES still require a new sentence and a fresh re-consent is a change of
  // KIND rather than of modality — if this scope ever reaches something that is
  // not "spend the viewer's Buzz on an AI generation job", say so explicitly.
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
    "Run AI generation services that spend the viewer's Buzz, with a per-call cap",
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
