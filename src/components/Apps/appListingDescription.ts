import remarkParse from 'remark-parse';
import { unified } from 'unified';

/**
 * ONE rule for how an app-listing `description` is presented, in one place.
 *
 * ## Why this module exists
 *
 * The same stored string used to render three different ways across four
 * surfaces, so an author could not predict what their description would look
 * like:
 *
 * | surface                     | before                          |
 * |-----------------------------|---------------------------------|
 * | `AppListingDetailBody`      | `CustomMarkdown` (full markdown)|
 * | `/apps/[appBlockId]`        | `<Text whiteSpace: pre-wrap>`   |
 * | `AppDetailsModal`           | `<Text whiteSpace: pre-wrap>`   |
 * | `AppBlockCard`              | `<Text line-clamp-3>`           |
 *
 * A description written with backticks (`` `{style}` ``, `` `#tag` ``) rendered
 * as a code span on the first surface and as literal backtick characters on the
 * other three; one written with hard line wraps rendered as wrapped lines under
 * `pre-wrap` and as a reflowed paragraph under markdown. Both spellings are in
 * live first-party listings, because authors were hedging against a platform
 * that had no stated rule.
 *
 * ## The rule
 *
 * **The stored `description` is Markdown.** That is now true everywhere, and it
 * is the format authors were already writing (backticks are a markdown idiom).
 * There are exactly TWO presentations of it, chosen by what the surface is for:
 *
 * 1. **Full surfaces** render the markdown — see `AppListingDescription` in
 *    `AppListingDescription.tsx`. These are the places a reader goes to read the
 *    description: the listing detail body, the app detail page, the details
 *    modal.
 * 2. **Teaser / metadata surfaces** render the markdown's PLAIN-TEXT PROJECTION
 *    — this file's {@link appListingDescriptionToPlainText}. These are places
 *    where markdown block elements would be wrong or impossible: a 3-line
 *    clamped card in a grid, and `<meta name="description">` / `og:description`.
 *
 * The second half is what makes the rule honest. If the canonical format is
 * markdown, a surface that cannot render markdown must not show markdown
 * SOURCE — otherwise the card and the OG snippet display raw `` `{style}` ``
 * backticks and `**bold**` asterisks, which is the same unpredictability in a
 * new place.
 *
 * 🔴 The projection is also the metadata safety property: it emits only the
 * VALUES of mdast text-ish nodes, so it can never introduce markup into a
 * `<meta>` tag. It does not "strip HTML" — it never constructs any.
 */

/** A structural stand-in for mdast nodes; `@types/mdast` is not a direct dep. */
type MdNode = {
  type: string;
  value?: unknown;
  alt?: unknown;
  children?: MdNode[];
};

/**
 * Node types whose `value` IS the text to keep.
 *
 * `inlineCode` and `code` are the load-bearing entries: a description using
 * `` `{style}` `` for literal syntax must show `{style}` in a teaser, not
 * `` `{style}` `` with the backticks still attached.
 */
const VALUE_NODES = new Set(['text', 'inlineCode', 'code']);

/**
 * Node types that separate their text from the next text with a space.
 *
 * `break` (a hard line break) and the block containers are here so that
 * `paragraph one\nparagraph two` reads as `paragraph one paragraph two` rather
 * than `paragraph oneparagraph two`. This is what collapses the ~76-column hard
 * wraps some listings carry — correct for a teaser, where the author's column
 * width is meaningless.
 */
const SEPARATING_NODES = new Set([
  'break',
  'paragraph',
  'heading',
  'listItem',
  'blockquote',
  'thematicBreak',
  'table',
  'tableRow',
  'code',
]);

function collect(node: MdNode, out: string[]): void {
  if (VALUE_NODES.has(node.type) && typeof node.value === 'string') {
    out.push(node.value);
  } else if (node.type === 'image' && typeof node.alt === 'string') {
    // An image cannot render in a teaser or a meta tag; its alt text is the
    // closest honest textual stand-in.
    out.push(node.alt);
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) collect(child, out);
  }

  if (SEPARATING_NODES.has(node.type)) out.push(' ');
}

/**
 * Render an app-listing description's markdown down to a single line of plain
 * text, for surfaces that cannot render markdown (the card teaser, `<meta>`).
 *
 * Guarantees, each pinned by a test in
 * `src/components/Apps/__tests__/appListingDescription.test.ts`:
 *
 * - **No markdown syntax survives.** Backticks, `**`, `_`, `#`, `[]()` are gone;
 *   their CONTENT remains.
 * - **No markup is produced.** The output is built only from mdast text values,
 *   so it can never contain `<` from a construct this function created.
 * - **Whitespace is collapsed** to single spaces and trimmed, so hard-wrapped
 *   source reflows into one line.
 * - **Total.** Every string is valid markdown, so there is no throwing input.
 */
export function appListingDescriptionToPlainText(description: string): string {
  if (!description) return '';

  const tree = unified().use(remarkParse).parse(description) as unknown as MdNode;
  const parts: string[] = [];
  collect(tree, parts);

  return parts.join('').replace(/\s+/g, ' ').trim();
}
