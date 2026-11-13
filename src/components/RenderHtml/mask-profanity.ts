import type { SimpleProfanityFilter } from '~/libs/profanity-simple';

// A mention span (whole span + label) or any single tag. Mentions are tried first at each
// position so a mention's label is never filtered; every other tag is kept verbatim, which
// also protects href/src values since the whole opening tag is one match.
const MARKUP_REGEX = /<span[^>]*data-type="mention"[^>]*>.*?<\/span>|<[^>]+>/gi;

/**
 * Runs the profanity filter over the visible text of `html` only, leaving tags and mentions
 * untouched. The filter sees each run of text between markup separately, so there is no
 * placeholder for it to mangle: an earlier version swapped markup for `__pf<nonce>T<i>__`
 * tokens and cleaned the whole string, and a random nonce that spelled a blocked word got
 * the token masked, which lost the tag. (Digits are no safer: the leet-speak transformer
 * maps 0, 1 and 3-7 to letters.)
 */
export function maskProfanityOutsideMarkup(html: string, filter: SimpleProfanityFilter): string {
  let result = '';
  let last = 0;
  for (const match of html.matchAll(MARKUP_REGEX)) {
    const index = match.index ?? 0;
    result += filter.clean(html.slice(last, index)) + match[0];
    last = index + match[0].length;
  }
  return result + filter.clean(html.slice(last));
}
