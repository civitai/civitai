import { unified } from 'unified';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';

/**
 * Renders a notice email's markdown to HTML. Email clients drop <style> blocks, so lists are styled
 * inline; margin rather than padding, as Outlook ignores list padding and client defaults indent
 * ~40px.
 */
export function renderNoticeMarkdown(markdown: string, { gfm = false } = {}) {
  const processor = unified().use(remarkParse);
  if (gfm) processor.use(remarkGfm);
  return String(
    processor.use(remarkBreaks).use(remarkRehype).use(rehypeStringify).processSync(markdown)
  ).replace(
    /<(ul|ol)>/g,
    (_, tag: string) => `<${tag} style="margin: 8px 0 8px 20px; padding: 0;">`
  );
}
