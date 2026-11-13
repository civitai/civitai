import { escape as escapeHtml } from 'he';
import { renderNoticeMarkdown } from '~/server/email/notice-markdown';
import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';
import type { Klein9bNoticeVariant } from '~/shared/constants/klein9b-notice.constants';
import { KLEIN9B_NOTICE } from '~/shared/constants/klein9b-notice.constants';

export type Klein9bNoticeData = {
  to: string;
  variant: Klein9bNoticeVariant;
  username: string;
  date: string;
  /** "model name: version name", one per charged version. */
  versions?: string[];
};

const rendered: Partial<Record<Klein9bNoticeVariant, string>> = {};
export function getKlein9bNoticeHtml({
  variant,
  username,
  date,
  versions = [],
}: Omit<Klein9bNoticeData, 'to'>) {
  rendered[variant] ??= renderNoticeMarkdown(KLEIN9B_NOTICE[variant].markdown);
  const list = `<ul style="margin: 8px 0 8px 20px; padding: 0;">${versions
    .map((v) => `<li>${escapeHtml(v)}</li>`)
    .join('')}</ul>`;
  return rendered[variant]
    .replace('<p>{versions}</p>', () => list)
    .replace(/\{username\}/g, () => escapeHtml(username))
    .replace(/\{date\}/g, () => escapeHtml(date));
}

export const klein9bNoticeEmail = createEmail({
  header: ({ to, variant }: Klein9bNoticeData) => ({
    subject: KLEIN9B_NOTICE[variant].subject,
    to,
  }),
  html(data: Klein9bNoticeData) {
    return simpleEmailWithTemplate({
      header: KLEIN9B_NOTICE[data.variant].subject,
      body: getKlein9bNoticeHtml(data),
    });
  },
  testData: async () => ({
    to: 'test@tester.com',
    variant: 'charged' as const,
    username: 'Tester',
    date: 'November 4th',
    versions: ['Example LoRA: v1'],
  }),
});
