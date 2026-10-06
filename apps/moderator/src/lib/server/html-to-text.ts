/**
 * Freshdesk ticket HTML → plain text that keeps the shape a reader needs: paragraphs, line breaks and
 * list items. Everything else (styling, links' targets, images, tables' structure) is dropped.
 *
 * 🔴 THE OUTPUT IS TEXT, AND MUST ONLY EVER BE RENDERED AS TEXT. This is not a sanitiser: entities are
 * decoded, so `&lt;script&gt;` in the input comes out as a literal `<script>`. That is harmless in a
 * `{text}` interpolation and an injection in `{@html}`.
 *
 * 🔴 THE INPUT IS CUSTOMER-WRITTEN AND THIS RUNS ON THE REQUEST PATH, so it must stay linear in the
 * input: every scan moves forward and never re-reads what it passed, the tag pattern cannot run past
 * the next `<`, and nothing tests the end of a string with an end-anchored regex (V8 retries those
 * from every position, so a long run of spaces or newlines goes quadratic). The first version did
 * all three, and 160k characters of `<a` took twelve seconds.
 */

/** Characters of HTML read. The page shows far less; the rest of a longer message is in Freshdesk. */
export const HTML_MAX_CHARS = 200_000;

/** Elements whose CONTENT is never shown — dropped whole, up to their closing tag. */
const DROPPED = new Set([
  'script',
  'style',
  'head',
  'title',
  'noscript',
  'template',
  'textarea',
  'select',
]);

/** Elements that start and end a paragraph (a blank line either side). */
const PARAGRAPH = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table']);
/** Elements that start and end a line. */
const LINE = new Set([
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'address',
  'figure',
  'figcaption',
  'tr',
  'dl',
  'dt',
  'dd',
  'hr',
]);

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
};

const codePoint = (n: number): string =>
  Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
    ? String.fromCodePoint(n)
    : '�';

/** Decodes numeric and the common named entities; an unknown name is left exactly as written. */
export const decodeEntities = (s: string): string =>
  s.replace(/&(#\d{1,8}|#[xX][0-9a-fA-F]{1,7}|[a-zA-Z]{2,8});/g, (whole, ref: string) => {
    if (ref[0] !== '#') return NAMED[ref.toLowerCase()] ?? whole;
    return codePoint(
      ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
    );
  });

/**
 * One tag at the sticky position. Attribute values may contain `>`, but nothing may cross a `<`: that
 * bound is what keeps a failed match from scanning the rest of the input.
 */
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b(?:"[^"<]*"|'[^'<]*'|[^'"<>])*>/y;

/** How many of `s`'s last characters are in `set` — a backwards walk, not an end-anchored regex. */
function trailing(s: string, set: string): number {
  let j = s.length;
  while (j > 0 && set.includes(s[j - 1])) j--;
  return s.length - j;
}
const SPACE = ' \t';

export function htmlToText(input: string): string {
  const html = input.length > HTML_MAX_CHARS ? input.slice(0, HTML_MAX_CHARS) : input;
  const parts: string[] = [];
  // The output's tail, tracked as parts are pushed so nothing ever re-reads the output.
  let last = '';
  let trailingNewlines = 0;
  /** A list marker was just pushed as its own part, with no text after it yet. */
  let marker = false;
  /** One entry per open list: `null` for a bullet list, the next number for an ordered one. */
  const lists: (number | null)[] = [];
  let pre = 0;

  const push = (s: string) => {
    if (!s) return;
    parts.push(s);
    last = s;
    const nl = trailing(s, '\n');
    trailingNewlines = nl === s.length ? trailingNewlines + nl : nl;
  };
  const dropTrailingSpace = () => {
    const n = trailing(last, SPACE);
    if (n) parts[parts.length - 1] = last = last.slice(0, last.length - n);
  };
  /** Ends the current line, and leaves at most `n` newlines in a row. */
  const breakLine = (n: 1 | 2) => {
    // A block opening inside a list item (`<li><p>…`) belongs on the marker's line.
    if (marker || parts.length === 0) return;
    dropTrailingSpace();
    if (trailingNewlines < n) push('\n'.repeat(n - trailingNewlines));
  };

  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    TAG_RE.lastIndex = i;
    const tag = html[i] === '<' ? TAG_RE.exec(html) : null;
    if (!tag) {
      // Text up to the next `<` — including the `<` itself when it opens no tag.
      let next = html.indexOf('<', i + 1);
      if (next < 0) next = html.length;
      let text = decodeEntities(html.slice(i, next));
      i = next;
      if (!pre) {
        text = text.replace(/\s+/g, ' ');
        const lineStart = parts.length === 0 || trailingNewlines > 0;
        if (text[0] === ' ' && (lineStart || last.endsWith(' '))) text = text.slice(1);
      }
      if (text) {
        marker = false;
        push(text);
      }
      continue;
    }
    i = TAG_RE.lastIndex;
    const isClose = tag[1] === '/';
    const name = tag[2].toLowerCase();

    if (DROPPED.has(name)) {
      if (isClose) continue;
      // Up to the matching close tag; an unclosed one swallows the rest, as it does in a browser.
      const close = new RegExp(`</${name}\\s*>`, 'gi');
      close.lastIndex = i;
      i = close.exec(html) ? close.lastIndex : html.length;
      continue;
    }

    if (name === 'br') {
      // A break before an item's first text would separate the bullet from it.
      if (marker) continue;
      dropTrailingSpace();
      push('\n');
    } else if (name === 'li') {
      // An item that never got any text is dropped, marker and all.
      if (marker) {
        parts.pop();
        last = parts[parts.length - 1] ?? '';
        trailingNewlines = parts.length ? trailing(last, '\n') : 0;
        marker = false;
      }
      breakLine(1);
      if (!isClose) {
        const depth = Math.max(lists.length, 1);
        const top = lists.length ? lists[lists.length - 1] : null;
        let bullet = '• ';
        if (top !== null) {
          bullet = `${top}. `;
          lists[lists.length - 1] = top + 1;
        }
        push('  '.repeat(depth - 1) + bullet);
        marker = true;
      }
    } else if (name === 'ul' || name === 'ol') {
      if (isClose) lists.pop();
      else lists.push(name === 'ol' ? 1 : null);
      // A nested list is a line inside its item; a top-level one is its own paragraph.
      breakLine(lists.length > (isClose ? 0 : 1) ? 1 : 2);
    } else if (PARAGRAPH.has(name)) {
      if (name === 'pre') pre = Math.max(0, pre + (isClose ? -1 : 1));
      breakLine(2);
    } else if (LINE.has(name)) {
      breakLine(1);
    } else if ((name === 'td' || name === 'th') && isClose) {
      if (parts.length && trailingNewlines === 0 && !last.endsWith(' ')) push(' ');
    }
  }

  return parts
    .join('')
    .split('\n')
    .map((l) => l.slice(0, l.length - trailing(l, SPACE)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
