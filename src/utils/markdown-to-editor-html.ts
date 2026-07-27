import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { extractCloudflareUuid } from '~/utils/article-helpers';

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

/** Schemes the sanitizer will keep on an `<a href>`. */
const WEB_URL = /^(https?:|mailto:|\/|#)/i;

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
  url?: string;
  alt?: string;
  depth?: number;
  checked?: boolean | null;
  children?: MdNode[];
};

export type MarkdownConversionResult = {
  html: string;
  tablesConverted: number;
  headingsClamped: number;
  taskItemsConverted: number;
  externalImagesLinked: number;
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

    // `remarkRehype` without `allowDangerousHtml` deletes html nodes *and their
    // text*, so `replace <your-token> with your key` silently lost the token.
    // Keep the characters; they get escaped on output, so nothing executes.
    if (child.type === 'html') {
      children[i] = { type: 'text', value: child.value ?? '' };
      continue;
    }

    // `<lora:add_detail:0.8>` parses as an autolink, and the sanitizer then
    // can't validate the scheme and demotes it to a bare span — dropping the
    // angle brackets that make it a usable prompt token. Prompts are the most
    // common thing in an article here, so restore the literal text.
    if (child.type === 'link' && !WEB_URL.test(child.url ?? '')) {
      const label = (child.children ?? []).map(toPlainText).join('');
      if (label === child.url) {
        children[i] = { type: 'text', value: `<${child.url}>` };
        continue;
      }
    }

    // An off-site `<img>` survives the sanitizer but is invisible to image
    // scanning: `extractImagesFromArticle` and `getContentMedia` both go through
    // `extractCloudflareUuid`, which only accepts Civitai-hosted URLs. A foreign
    // host is therefore never extracted, never scanned and never counted by the
    // publish gate, while still leaking every reader's IP to it. Demote to a link
    // so the reference survives without embedding an unscanned image; the author
    // can re-add it with the image button, which uploads through Cloudflare.
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
  const stats: ConversionStats = {
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
  externalImagesLinked,
}: ConversionStats) {
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
