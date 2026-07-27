import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

/**
 * Markdown -> HTML for the Tiptap editor.
 *
 * Distinct from `markdownToHtml` (markdown-helpers.ts) on two counts: this one
 * is synchronous, so it can run inside a ProseMirror `handlePaste`, and it
 * reshapes constructs the editor cannot round-trip into ones it can.
 *
 * The binding constraint is `DEFAULT_ALLOWED_TAGS` in html-sanitize-helpers.ts,
 * which runs as a zod preprocess on save. Anything outside it is dropped
 * silently *after* the author has already hit publish, so we lower it here
 * instead and report what changed.
 */

const MAX_HEADING_DEPTH = 3;
const MIN_TABLE_COLUMN_WIDTH = 3;

/**
 * Leading YAML frontmatter. Deliberately not `gray-matter` (which
 * markdown-helpers.ts uses): that reaches for Node's `Buffer`, and this module
 * runs in the browser via the paste handler and the import control, where it
 * throws `ReferenceError: Buffer is not defined`.
 *
 * Requires a `key:` line inside the fence so a document opening with a `---`
 * horizontal rule doesn't get its first section eaten.
 */
const FRONTMATTER = /^﻿?---[ \t]*\r?\n([^]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function stripFrontmatter(markdown: string) {
  const match = markdown.match(FRONTMATTER);
  if (!match) return markdown;

  const block = match[1];
  const looksLikeYaml = /^[ \t]*[\w.-]+[ \t]*:/m.test(block) && !/\r?\n[ \t]*\r?\n/.test(block);

  return looksLikeYaml ? markdown.slice(match[0].length) : markdown;
}

type MdNode = {
  type: string;
  value?: string;
  depth?: number;
  checked?: boolean | null;
  children?: MdNode[];
};

export type MarkdownConversionResult = {
  html: string;
  tablesConverted: number;
  headingsClamped: number;
  taskItemsConverted: number;
};

type ConversionStats = Omit<MarkdownConversionResult, 'html'>;

function toPlainText(node: MdNode): string {
  if (typeof node.value === 'string') return node.value;
  if (!node.children) return '';
  return node.children.map(toPlainText).join('');
}

/**
 * Re-emit a GFM table as padded pipe text for a code block. Reconstructing from
 * the parsed cells rather than slicing the source keeps ragged hand-written
 * tables aligned in the output.
 */
function renderTableAsText(table: MdNode): string {
  const rows = (table.children ?? []).map((row) =>
    (row.children ?? []).map((cell) => toPlainText(cell).replace(/\s+/g, ' ').trim())
  );
  if (!rows.length) return '';

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

function fitToEditorSchema(node: MdNode, stats: ConversionStats) {
  const children = node.children;
  if (!children) return;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];

    if (child.type === 'table') {
      children[i] = { type: 'code', value: renderTableAsText(child) };
      stats.tablesConverted++;
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

/**
 * Structural signals only. A paste carrying nothing but `**bold**` or backticks
 * is far more likely to be prose than a document, and mangling an ordinary
 * paste is worse than leaving markdown unconverted.
 */
const STRUCTURAL_MARKDOWN = [
  /^#{1,6} \S/m, // ATX heading
  /^```/m, // fenced code block
  /^\|[-: |]+\|[ \t]*$/m, // GFM table delimiter row
  /^> \S/m, // blockquote
];

export function looksLikeMarkdown(text: string) {
  return STRUCTURAL_MARKDOWN.some((pattern) => pattern.test(text));
}

export function convertMarkdownForEditor(markdown: string): MarkdownConversionResult {
  const content = stripFrontmatter(markdown);
  const stats: ConversionStats = {
    tablesConverted: 0,
    headingsClamped: 0,
    taskItemsConverted: 0,
  };

  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(() => (tree: unknown) => {
      fitToEditorSchema(tree as MdNode, stats);
    })
    // No `allowDangerousHtml`/rehype-raw: embedded HTML in a markdown file would
    // be stripped by the sanitizer anyway, and dropping it here keeps the
    // editor's document matching what gets stored.
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
}: ConversionStats) {
  const plural = (count: number, noun: string) => `${count} ${noun}${count > 1 ? 's' : ''}`;
  const notes: string[] = [];

  if (tablesConverted) notes.push(`${plural(tablesConverted, 'table')} converted to code blocks`);
  if (headingsClamped) notes.push(`${plural(headingsClamped, 'heading')} lowered to H3`);
  if (taskItemsConverted) notes.push(`${plural(taskItemsConverted, 'checklist item')} flattened`);

  return notes.length ? notes.join(', ') : undefined;
}
