import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';

/** Prefix of the per-app, per-block and per-instance tags an App Blocks submit stamps. */
export const APP_BLOCK_TAG_PREFIX = `${WORKFLOW_TAGS.APP_BLOCK}:`;

export const APP_BLOCK_TAG_REFUSED_MESSAGE =
  'App block tags are set by the app, not added by hand.';

/**
 * Whether a caller-supplied tag is one an App Blocks submit stamps: the bare `app-block` tag or one
 * under its prefix. Only an App Blocks submit may set these, so every user-facing path that takes
 * workflow tags refuses them through this one check.
 */
export function isAppBlockTag(tag: string): boolean {
  const normalized = tag.trim().toLowerCase();
  return normalized === WORKFLOW_TAGS.APP_BLOCK || normalized.startsWith(APP_BLOCK_TAG_PREFIX);
}
