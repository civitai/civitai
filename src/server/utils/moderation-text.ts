import { convert } from 'html-to-text';

/**
 * Rich-text HTML -> plain text for text moderation.
 *
 * Entity content is stored as sanitized HTML, and submitting it verbatim makes
 * the scanner read tag markup (`<p>`, `<iframe>`, `<edge-media>`, attribute
 * values) as part of the prose — tokens it has to spend budget ignoring.
 *
 * Deliberately not `removeTags`: that deletes each tag wholesale, so
 * `<a href="http://spam.example">click</a>` collapses to "click" and the URL —
 * the most useful signal for spam and off-site abuse — disappears. `html-to-text`
 * renders it as `click [http://spam.example]`, keeping the link and image targets
 * visible while dropping the markup.
 */
export function htmlToModerationText(html: string | null | undefined) {
  if (!html?.trim()) return '';

  return convert(html, {
    // Default wraps at 80 columns, which injects newlines mid-sentence.
    wordwrap: false,
    selectors: [
      // The default `heading` formatter uppercases; the scanner should see the
      // author's text as written.
      { selector: 'h1', format: 'block' },
      { selector: 'h2', format: 'block' },
      { selector: 'h3', format: 'block' },
    ],
  }).trim();
}
