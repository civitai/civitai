import { escape as escapeHtml } from 'he';
import { unified } from 'unified';
import remarkBreaks from 'remark-breaks';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';
import type { NcEarningsNotice } from '~/shared/constants/nc-earnings-notice.constants';
import {
  NC_EARNINGS_NOTICE,
  fillNcEarningsCopy,
} from '~/shared/constants/nc-earnings-notice.constants';

export type NcEarningsNoticeData = {
  to: string;
  notice: NcEarningsNotice;
  username: string;
  date: string;
  /** The creator's own affected base models. */
  baseModels: string[];
  /** "model name: version name", one per version that had a fee; empty for no fee. */
  versions: string[];
};

export function getNcEarningsNoticeSubject({
  notice,
  baseModels,
}: Pick<NcEarningsNoticeData, 'notice' | 'baseModels'>) {
  return fillNcEarningsCopy(NC_EARNINGS_NOTICE[notice].subject, baseModels, false);
}

export function getNcEarningsNoticeHtml({
  notice,
  username,
  date,
  baseModels,
  versions,
}: Omit<NcEarningsNoticeData, 'to'>) {
  // The notice's own text is filled before rendering; names a user chose are escaped into the HTML
  // after it, so they can't add markdown.
  const markdown = fillNcEarningsCopy(
    NC_EARNINGS_NOTICE[notice].markdown,
    baseModels,
    versions.length > 0
  );
  const html = String(
    unified()
      .use(remarkParse)
      .use(remarkBreaks)
      .use(remarkRehype)
      .use(rehypeStringify)
      .processSync(markdown)
  ).replace(
    // Email clients drop <style> blocks, so lists are styled inline.
    /<(ul|ol)>/g,
    (_, tag: string) => `<${tag} style="margin: 8px 0 8px 20px; padding: 0;">`
  );
  return html
    .replace(/\{versions\}/g, () => versions.map((v) => escapeHtml(v)).join(', '))
    .replace(/\{username\}/g, () => escapeHtml(username))
    .replace(/\{date\}/g, () => escapeHtml(date));
}

export const ncEarningsNoticeEmail = createEmail({
  header: ({ to, notice, baseModels }: NcEarningsNoticeData) => ({
    subject: getNcEarningsNoticeSubject({ notice, baseModels }),
    to,
  }),
  html(data: NcEarningsNoticeData) {
    return simpleEmailWithTemplate({
      header: getNcEarningsNoticeSubject(data),
      body: getNcEarningsNoticeHtml(data),
    });
  },
  testData: async () => ({
    to: 'test@tester.com',
    notice: 'nc-older' as const,
    username: 'Tester',
    date: 'November 5th',
    baseModels: ['Flux.1 Krea'],
    versions: ['Example LoRA: v1'],
  }),
});
