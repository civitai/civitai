/**
 * Moderator-set event labels, e.g. `halloween`. A homepage Feed block selects crucibles by one, and
 * a shop section with a matching `meta.eventTag` picks up the shop items that carry it.
 */
export const MAX_EVENT_TAGS = 10;
export const EVENT_TAG_MAX_LENGTH = 32;
export const EVENT_TAG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const normalizeEventTag = (tag: string) => tag.trim().toLowerCase();
