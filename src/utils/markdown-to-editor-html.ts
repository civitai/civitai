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
const WEB_URL = /^(https?:|mailto:|\/|#)/i;

/**
 * Not `gray-matter`: it needs Node's `Buffer` and this runs in the browser.
 * Line-wise because a leading `---` is more often a horizontal rule, and
 * frontmatter may contain blank lines.
 */
function stripFrontmatter(markdown: string) {
  const text = markdown.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return text;

  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close === -1) return text;

  const block = lines.slice(1, close);
  const opensWithKey = /^[\w.-]+[ \t]*:/.test(block[0] ?? '');
  const hasHeading = block.some((line) => /^#{1,6} /.test(line));
  if (!opensWithKey || hasHeading) return text;

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

  // GFM ignores body cells beyond the header's width, so widening to the longest
  // row would render a phantom column that appears nowhere else.
  const columnCount = rows[0].length;
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

function fitToEditorSchema(node: MdNode, stats: MarkdownConversionStats) {
  const children = node.children;
  if (!children) return;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];

    if (child.type === 'table') {
      children[i] = { type: 'code', value: renderTableAsText(child) };
      stats.tablesConverted++;
      continue;
    }

    // remarkRehype drops html nodes *and their text*, losing `<your-token>`.
    // Keeping the characters is safe: they are escaped on output.
    if (child.type === 'html') {
      children[i] = { type: 'text', value: child.value ?? '' };
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
    // publish unscanned and leak reader IPs. Demote rather than embed.
    if (child.type === 'image' && !extractCloudflareUuid(child.url ?? '')) {
      const url = child.url ?? '';
      children[i] = {
        type: 'link',
        url,
        children: [{ type: 'text', value: child.alt?.trim() || url }],
      };
      stats.externalImagesLinked++;
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

    fitToEditorSchema(child, stats);
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
      fitToEditorSchema(tree as MdNode, stats);
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
