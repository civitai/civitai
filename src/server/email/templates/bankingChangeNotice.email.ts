import { escape as escapeHtml } from 'he';
import { unified } from 'unified';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';
import { getBaseUrl } from '~/server/utils/url-helpers';
import {
  BANKING_CHANGE_NOTICE_MARKDOWN,
  BANKING_CHANGE_NOTICE_SUBJECT,
} from '~/shared/constants/banking-change-notice.constants';

type BankingChangeNoticeData = {
  to: string;
  username: string;
};

const cell = 'border: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: top;';

// Email clients drop <style> blocks, so the table and images are styled inline.
const noticeHtml = String(
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkBreaks)
    .use(remarkRehype)
    .use(rehypeStringify)
    .processSync(BANKING_CHANGE_NOTICE_MARKDOWN)
)
  .replace(/<table>/g, '<table style="border-collapse: collapse; width: 100%;">')
  .replace(/<th>/g, `<th style="${cell}">`)
  .replace(/<td>/g, `<td style="${cell}">`)
  .replace(/<img /g, '<img style="max-width: 100%; height: auto;" ')
  // Margin rather than padding: Outlook ignores list padding, and client defaults indent ~40px.
  .replace(/<(ul|ol)>/g, (_, tag: string) => `<${tag} style="margin: 8px 0 8px 20px; padding: 0;">`)
  .replace(/<h2>/g, '<h2 style="font-size: 18px; margin: 24px 0 8px;">');

export function getBankingChangeNoticeHtml(username: string) {
  const baseUrl = getBaseUrl();
  return noticeHtml
    .replace(/(src|href)="\//g, (_, attr: string) => `${attr}="${baseUrl}/`)
    .replace(/\{username\}/g, () => escapeHtml(username));
}

export const bankingChangeNoticeEmail = createEmail({
  header: ({ to }: BankingChangeNoticeData) => ({
    subject: BANKING_CHANGE_NOTICE_SUBJECT,
    to,
  }),
  html({ username }: BankingChangeNoticeData) {
    return simpleEmailWithTemplate({
      header: BANKING_CHANGE_NOTICE_SUBJECT,
      body: getBankingChangeNoticeHtml(username),
    });
  },
  testData: async () => ({
    to: 'test@tester.com',
    username: 'Tester',
  }),
});
