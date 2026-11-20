import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeStringify);

export function markdownForEditor(source: string) {
  return sanitizeHtml(String(processor.processSync(source)), {
    allowTables: true,
    transformTags: { del: 's' },
  });
}
