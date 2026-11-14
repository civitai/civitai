/**
 * Only markup that survives the text item's sanitizer (`COMMENT_ALLOWED_TAGS`): headings and lists
 * would be stripped at save.
 */
export const STORYLINE_TEXT_CONTROLS = ['formatting', 'link', 'mentions'] as const;
