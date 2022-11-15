import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkHtml from 'remark-html';

const markdownHtmlProcessor = unified().use(remarkParse).use(remarkHtml);

export async function markdownToHtml(markdown: string) {
  const { content } = matter(markdown);
  const result = await markdownHtmlProcessor.process(content);
  return result.toString();
}
