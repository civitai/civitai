import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { extractCloudflareUuid } from '~/utils/article-helpers';

/**
 * Markdown -> HTML for the Tiptap editor, lowered to what `DEFAULT_ALLOWED_TAGS`
 * permits. The sanitizer runs as a zod preprocess on save, so anything it drops
 * is lost after the author has already published.
 */

const MAX_HEADING_DEPTH = 3;
const MIN_TABLE_COLUMN_WIDTH = 3;

/** Schemes the sanitizer will keep on an `<a href>`. */
const WEB_URL = /^(https?:|ftp:|mailto:|\/|#)/i;

/** An HTML comment or a genuine tag, as opposed to `<your-token>`. */
const HTML_MARKUP = /^<!--|^<\/?[a-z][a-z0-9]*(\s|\/?>)/i;

/**
 * Not `gray-matter`: it needs Node's `Buffer` and this runs in the browser.
 * Line-wise because a leading `---` is more often a horizontal rule, and
 * frontmatter may contain blank lines.
 */
function stripFrontmatter(markdown: string) {
  const text = markdown.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return text;

  // Column 0 only. `line.trim() === '---'` also matched an indented `---` inside
  // a block scalar, which ended the fence early and published the rest of the
  // frontmatter as body content.
  const close = lines.findIndex((line, index) => index > 0 && line === '---');
  if (close === -1) return text;

  // Every non-blank line must read as YAML \u2014 a `key:`, a list item, or an
  // indented continuation \u2014 so a `---` horizontal rule followed by prose that
  // happens to contain a colon isn't mistaken for frontmatter and deleted.
  // `#` lines are YAML comments here, not markdown headings.
  const isYamlish = (line: string) =>
    line.trim() === '' ||
    /^#/.test(line.trim()) ||
    /^[ \t]/.test(line) ||
    /^- /.test(line.trim()) ||
    // `https://example.com` also matches `key:`, so exclude bare URIs.
    (/^[\w.$-]+[ \t]*:/.test(line) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(line.trim()));

  // Frontmatter never opens with a blank line, but `---` + blank + prose is a
  // common horizontal rule, so that alone separates the two.
  const block = lines.slice(1, close);
  if (!block.length || block[0].trim() === '' || !block.every(isYamlish)) return text;

  return lines
    .slice(close + 1)
    .join('\n')
    .replace(/^\n+/, '');
}

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  identifier?: string;
  depth?: number;
  checked?: boolean | null;
  children?: MdNode[];
};

type MarkdownConversionResult = {
  html: string;
  tablesConverted: number;
  headingsClamped: number;
  taskItemsConverted: number;
  externalImagesLinked: number;
};

export type MarkdownConversionStats = Omit<MarkdownConversionResult, 'html'>;

function toPlainText(node: MdNode): string {
  if (typeof node.value === 'string') return node.value;
  if (!node.children) return '';
  return node.children.map(toPlainText).join('');
}

/** Padded pipe text for a code block; rebuilt from cells so ragged tables align. */
function renderTableAsText(table: MdNode): string {
  const rows = (table.children ?? []).map((row) =>
    (row.children ?? []).map((cell) => toPlainText(cell).replace(/\s+/g, ' ').trim())
  );
  if (!rows.length) return '';

  // Widest row, not the header's width: remark keeps excess body cells, and this
  // renders to a code block that is never re-parsed as a table, so clamping to
  // the header would just delete them.
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(MIN_TABLE_COLUMN_WIDTH, ...rows.map((row) => (row[column] ?? '').length))
  );

  const renderRow = (cells: string[]) =>
    `| ${widths.map((width, i) => (cells[i] ?? '').padEnd(width)).join(' | ')} |`;

  const [header, ...body] = rows;
  const divider = `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`;

  return [renderRow(header), divider, ...body.map(renderRow)].join('\n');
}

function prefixParagraph(item: MdNode, prefix: string) {
  const paragraph = item.children?.find((child) => child.type === 'paragraph');
  if (!paragraph) return;
  paragraph.children = [{ type: 'text', value: prefix }, ...(paragraph.children ?? [])];
}

function collectDefinitions(node: MdNode, into: Map<string, string>) {
  for (const child of node.children ?? []) {
    if (child.type === 'definition' && child.identifier)
      into.set(child.identifier.toLowerCase(), child.url ?? '');
    collectDefinitions(child, into);
  }
}

function fitToEditorSchema(
  node: MdNode,
  stats: MarkdownConversionStats,
  definitions: Map<string, string>
) {
  const children = node.children;
  if (!children) return;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];

    if (child.type === 'table') {
      children[i] = { type: 'code', value: renderTableAsText(child) };
      stats.tablesConverted++;
      continue;
    }

    // remarkRehype drops html nodes *and their text*, which lost `<your-token>`.
    // Only rescue the ones that aren't actually markup: a comment or a real tag
    // should stay dropped, or private notes and `<div>` wrappers get published as
    // visible text. `<br>` is allowlisted, so keep it as a real break.
    if (child.type === 'html') {
      const raw = child.value ?? '';
      if (/^<br\s*\/?>$/i.test(raw)) children[i] = { type: 'break' };
      else if (HTML_MARKUP.test(raw)) children.splice(i--, 1);
      else children[i] = { type: 'text', value: raw };
      continue;
    }

    // `<lora:x:0.8>` parses as an autolink, and the sanitizer demotes an
    // unvalidatable scheme to a span — losing the brackets the prompt needs.
    if (child.type === 'link' && !WEB_URL.test(child.url ?? '')) {
      const label = (child.children ?? []).map(toPlainText).join('');
      if (label === child.url) {
        children[i] = { type: 'text', value: `<${child.url}>` };
        continue;
      }
    }

    // Image scanning only sees Civitai-hosted URLs, so an off-site `<img>` would
    // publish unscanned and leak reader IPs. Demote rather than embed. Reference
    // style (`![alt][id]`) counts too — it reaches the same `<img>`.
    if (child.type === 'image' || child.type === 'imageReference') {
      const url = child.url ?? definitions.get((child.identifier ?? '').toLowerCase()) ?? '';
      if (!extractCloudflareUuid(url)) {
        children[i] = {
          type: 'link',
          url,
          children: [{ type: 'text', value: child.alt?.trim() || url }],
        };
        stats.externalImagesLinked++;
        continue;
      }
      // Resolve the reference so the surviving image carries a real src.
      if (child.type === 'imageReference') children[i] = { type: 'image', url, alt: child.alt };
      continue;
    }

    if (child.type === 'heading' && (child.depth ?? 0) > MAX_HEADING_DEPTH) {
      child.depth = MAX_HEADING_DEPTH;
      stats.headingsClamped++;
    }

    // A GFM task item renders as `<input type="checkbox">`, which the sanitizer
    // drops along with any indication the item was ever a checkbox.
    if (child.type === 'listItem' && child.checked != null) {
      prefixParagraph(child, child.checked ? '[x] ' : '[ ] ');
      child.checked = null;
      stats.taskItemsConverted++;
    }

    fitToEditorSchema(child, stats, definitions);
  }
}

export function convertMarkdownForEditor(markdown: string): MarkdownConversionResult {
  const content = stripFrontmatter(markdown);
  const stats: MarkdownConversionStats = {
    tablesConverted: 0,
    headingsClamped: 0,
    taskItemsConverted: 0,
    externalImagesLinked: 0,
  };

  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(() => (tree: unknown) => {
      const definitions = new Map<string, string>();
      collectDefinitions(tree as MdNode, definitions);
      fitToEditorSchema(tree as MdNode, stats, definitions);
    })
    .use(remarkRehype)
    .use(rehypeStringify)
    .processSync(content);

  // Tiptap's strike mark parses <del> but serializes <s>, and only <s> is
  // allowlisted. Normalize so the pre- and post-save HTML agree.
  const html = String(file).replace(/<(\/?)del>/g, '<$1s>');

  return { html, ...stats };
}

export function markdownToEditorHtml(markdown: string) {
  return convertMarkdownForEditor(markdown).html;
}

export function describeMarkdownConversion({
  tablesConverted,
  headingsClamped,
  taskItemsConverted,
  externalImagesLinked,
}: MarkdownConversionStats) {
  const plural = (count: number, noun: string) => `${count} ${noun}${count > 1 ? 's' : ''}`;
  const notes: string[] = [];

  if (tablesConverted) notes.push(`${plural(tablesConverted, 'table')} converted to code blocks`);
  if (headingsClamped) notes.push(`${plural(headingsClamped, 'heading')} lowered to H3`);
  if (taskItemsConverted) notes.push(`${plural(taskItemsConverted, 'checklist item')} flattened`);
  if (externalImagesLinked)
    notes.push(
      `${plural(
        externalImagesLinked,
        'off-site image'
      )} turned into links (re-add them with the image button so they get scanned)`
    );

  return notes.length ? notes.join(', ') : undefined;
}
