import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';

/** Prefix of the per-app, per-block and per-instance tags an App Blocks submit stamps. */
export const APP_BLOCK_TAG_PREFIX = `${WORKFLOW_TAGS.APP_BLOCK}:`;

export const APP_BLOCK_TAG_REFUSED_MESSAGE =
  'App block tags are set by the app, not added by hand.';

export const CALLER_TAGS_SHAPE_MESSAGE = 'tags must be a list of strings.';

/**
 * Whether a caller-supplied tag is one an App Blocks submit stamps: the bare `app-block` tag or one
 * under its prefix. Refuse these on any path that puts caller tags onto a workflow.
 */
export function isAppBlockTag(tag: string): boolean {
  const normalized = tag.trim().toLowerCase();
  return normalized === WORKFLOW_TAGS.APP_BLOCK || normalized.startsWith(APP_BLOCK_TAG_PREFIX);
}

/** Why caller-supplied workflow tags are refused, or `null` when they may go on the workflow. */
export function callerTagsRefusal(tags: unknown): string | null {
  if (tags == null) return null;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string'))
    return CALLER_TAGS_SHAPE_MESSAGE;
  return tags.some(isAppBlockTag) ? APP_BLOCK_TAG_REFUSED_MESSAGE : null;
}
