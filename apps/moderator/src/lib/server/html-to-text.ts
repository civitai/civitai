/**
 * Freshdesk ticket HTML → plain text that keeps the shape a reader needs: paragraphs, line breaks and
 * list items. Everything else (styling, links' targets, images, tables' structure) is dropped.
 *
 * 🔴 THE OUTPUT IS TEXT, AND MUST ONLY EVER BE RENDERED AS TEXT. This is not a sanitiser: entities are
 * decoded, so `&lt;script&gt;` in the input comes out as a literal `<script>`. That is harmless in a
 * `{text}` interpolation and an injection in `{@html}`.
 */

/** Elements whose CONTENT is never shown — dropped whole, before anything else reads the input. */
const DROPPED = ['script', 'style', 'head', 'title', 'noscript', 'template', 'textarea', 'select'];

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
  'ul',
  'ol',
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

/** A tag's attributes — quoted values may contain `>`. */
const ATTRS = `(?:"[^"]*"|'[^']*'|[^'">])*`;
const DROP_RE = new RegExp(`<(${DROPPED.join('|')})\\b${ATTRS}>[\\s\\S]*?</\\1\\s*>`, 'gi');
/** An unclosed dropped element swallows the rest of the input, as it does in a browser. */
const DROP_UNCLOSED_RE = new RegExp(`<(?:${DROPPED.join('|')})\\b[\\s\\S]*$`, 'i');
// A tag (open, close or self-closing), a comment, or a run of text. A `<` that starts none of the first
// two is text.
const TOKEN_RE = new RegExp(
  `<!--[\\s\\S]*?(?:-->|$)|<(\\/?)([a-zA-Z][a-zA-Z0-9]*)\\b${ATTRS}>|[^<]+|<`,
  'g'
);

export function htmlToText(html: string): string {
  let out = '';
  /** One entry per open list: `null` for a bullet list, the next number for an ordered one. */
  const lists: (number | null)[] = [];
  let pre = 0;
  /** Length of a list marker just written with nothing after it yet; 0 otherwise. */
  let marker = 0;

  const trimEnd = () => {
    out = out.replace(/[ \t]+$/, '');
  };
  /** Ends the current line, and leaves at most `n` newlines in a row. */
  const breakLine = (n: 1 | 2) => {
    // A block opening inside a list item (`<li><p>…`) belongs on the marker's line.
    if (marker) return;
    trimEnd();
    if (out === '') return;
    const have = /\n*$/.exec(out)?.[0].length ?? 0;
    if (have < n) out += '\n'.repeat(n - have);
  };
  const atLineStart = () => out === '' || out.endsWith('\n');

  for (const m of html.replace(DROP_RE, ' ').replace(DROP_UNCLOSED_RE, ' ').matchAll(TOKEN_RE)) {
    const [token, closing, rawName] = m;
    if (token.startsWith('<!--')) continue;
    if (rawName === undefined) {
      let text = decodeEntities(token);
      if (!pre) {
        text = text.replace(/\s+/g, ' ');
        if (atLineStart()) text = text.replace(/^ /, '');
        else if (out.endsWith(' ')) text = text.replace(/^ /, '');
      }
      if (text) marker = 0;
      out += text;
      continue;
    }
    const name = rawName.toLowerCase();
    const isClose = closing === '/';

    if (name === 'br') {
      trimEnd();
      out += '\n';
    } else if (name === 'li') {
      // An item that never got any text is dropped, marker and all.
      if (marker) out = out.slice(0, -marker);
      marker = 0;
      breakLine(1);
      if (!isClose) {
        const depth = Math.max(lists.length, 1);
        const top = lists.length ? lists[lists.length - 1] : null;
        let bullet = '• ';
        if (top !== null) {
          bullet = `${top}. `;
          lists[lists.length - 1] = top + 1;
        }
        const written = '  '.repeat(depth - 1) + bullet;
        out += written;
        marker = written.length;
      }
    } else if (name === 'ul' || name === 'ol') {
      if (isClose) lists.pop();
      else lists.push(name === 'ol' ? 1 : null);
      // A nested list is a line inside its item; a top-level one is its own paragraph.
      breakLine(lists.length > (isClose ? 0 : 1) ? 1 : 2);
    } else if (PARAGRAPH.has(name)) {
      if (name === 'pre') pre += isClose ? (pre > 0 ? -1 : 0) : 1;
      breakLine(2);
    } else if (LINE.has(name)) {
      breakLine(1);
    } else if (name === 'td' || name === 'th') {
      if (isClose && !atLineStart() && !out.endsWith(' ')) out += ' ';
    }
  }

  return out
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
