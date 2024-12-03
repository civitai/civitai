import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import rehypeRaw from 'rehype-raw';

const markdownHtmlProcessor = unified()
  .use(remarkParse)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  // TODO: Might be good to add sanitization back in. But right now, more trouble than worth.
  // .use(rehypeSanitize, {
  //   ...defaultSchema,
  //   tagNames: [...(defaultSchema?.tagNames ?? []), 'span'],
  //   attributes: {
  //     span: ['style'],
  //   },
  // })
  .use(rehypeStringify);

export async function markdownToHtml(markdown: string) {
  const { content } = matter(markdown);
  const result = await markdownHtmlProcessor.process(content);
  return result.toString();
}
