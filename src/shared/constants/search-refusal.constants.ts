/**
 * The code a search refused for profanity answers with: `code` in the /api/search body, the
 * message of a semantic search's UNPROCESSABLE_CONTENT error. The browser shows its refusal on it.
 */
export const SEARCH_REFUSED_CODE = 'search_refused';

/** Which check refused a search, as a moderator is told it. Never sent to anyone else. */
export const SEARCH_REFUSED_BY = [
  'minor',
  'real people',
  'blocked words',
  'profanity',
  'query guard',
  'error',
] as const;
export type SearchRefusedBy = (typeof SEARCH_REFUSED_BY)[number];

/** The label each word check is named by, for the browser's and the server's verdicts alike. */
export const WORD_CHECK_LABEL = {
  minor: 'minor',
  poi: 'real people',
  blocked: 'blocked words',
} as const satisfies Record<string, SearchRefusedBy>;

/**
 * A semantic search page's refusal mark. `refused` is on every page; `refusedBy` only on a
 * moderator's refused page, so a non-moderator's refused page is a no-match page plus `refused`.
 */
export type SearchRefusalMark = { refused: boolean; refusedBy?: SearchRefusedBy };

/** The one message every refusal other than the minors notice shows. */
export const SEARCH_POLICY_MESSAGE = {
  title: "This search isn't available",
  body: "Some searches are limited by our content rules, so we can't show results for this one. Try different words.",
} as const;

/** The extra line a moderator sees on a refusal. */
export function searchRefusedByLine(by: SearchRefusedBy) {
  return by === 'error'
    ? 'Moderator view: refused: the check could not complete (fail-closed)'
    : `Moderator view: refused by the ${by} check`;
}
