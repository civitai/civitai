/** Only markup that survives the text item's sanitizer (`STORYLINE_TEXT_ALLOWED_TAGS`). */
export const STORYLINE_TEXT_CONTROLS = [
  'heading',
  'formatting',
  'list',
  'link',
  'mentions',
] as const;

/** `h1` is not on the text item's allowlist, so the heading control offers 2 and 3 only. */
export const STORYLINE_TEXT_HEADING_LEVELS: Array<2 | 3> = [2, 3];
