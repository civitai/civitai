/**
 * Friendly per-scope + per-slot descriptions surfaced in the App Blocks UI.
 *
 * Shared by:
 *   - /apps/review (mod-facing manifest viewer)
 *   - /apps/installed (viewer-facing "what does this app claim" section)
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
  'media:read:owned': "Read the viewer's own uploaded media",
  'buzz:read:self': "Read the viewer's Buzz balance",
  'ai:write:budgeted': 'Submit generations with a per-call Buzz cap',
  'social:tip:self': 'Post tips on behalf of the viewer',
  'block:settings:read': "Read this block's per-install settings",
  'block:settings:write': "Update this block's per-install settings",
  'apps:storage:read': "Read this app's private per-install data store",
  'apps:storage:write': "Write to this app's private per-install data store",
  'apps:storage:shared:read': "Read this app's shared, community-wide data (e.g. everyone's posts + vote counts)",
  'apps:storage:shared:write': "Post + vote in this app's shared, community-wide data — visible to all users of the app",
};

export const SLOT_DESCRIPTIONS: Record<string, string> = {
  'model.sidebar_top': 'Top of the model page sidebar',
  'model.below_images': 'Below the model page image gallery',
  'model.actions_extra': 'Among the model page action buttons',
};
