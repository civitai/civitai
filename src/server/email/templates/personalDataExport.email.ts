import { escape as escapeHtml } from 'he';
import { renderNoticeMarkdown } from '~/server/email/notice-markdown';
import { createEmail } from '~/server/email/templates/base.email';
import { simpleEmailWithTemplate } from '~/server/email/templates/util';
import {
  COVER_NOTE_SUBJECT,
  COVER_NOTE_TEMPLATE,
  formatTakenAt,
} from '~/server/services/personal-data-export/cover-note';

type ReadyData = { to: string; username: string; link: string; takenAt: Date };

let coverHtml: string | undefined;

/** The cover note as HTML. Placeholders are filled after rendering, escaped, so no value is markdown. */
export function personalDataExportReadyHtml({ username, link, takenAt }: Omit<ReadyData, 'to'>) {
  coverHtml ??= renderNoticeMarkdown(COVER_NOTE_TEMPLATE);
  return coverHtml
    .replace(/\{username\}/g, () => escapeHtml(username))
    .replace(/\{link\}/g, () => `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`)
    .replace(/\{taken_at\}/g, () => escapeHtml(formatTakenAt(takenAt)));
}

/** To the account owner, on release: the cover note and the archive link. */
export const personalDataExportReadyEmail = createEmail({
  header: ({ to }: ReadyData) => ({ subject: COVER_NOTE_SUBJECT, to }),
  html: (data: ReadyData) =>
    simpleEmailWithTemplate({
      header: COVER_NOTE_SUBJECT,
      body: personalDataExportReadyHtml(data),
    }),
  testData: async () => ({
    to: 'test@tester.com',
    username: 'Tester',
    link: 'https://example.com/archive.zip',
    takenAt: new Date('2026-11-06T15:15:00Z'),
  }),
});

type BuiltData = {
  to: string;
  exportId: number;
  userId: number;
  username: string | null;
  held: boolean;
  archiveLink: string;
  notesLink: string | null;
  expiresAt: Date;
};

/** To the staff member who queued the export: the archive is built, here is a link. */
export const personalDataExportBuiltEmail = createEmail({
  header: ({ to, exportId }: BuiltData) => ({
    subject: `Personal data export #${exportId} is ready`,
    to,
  }),
  html({ exportId, userId, username, held, archiveLink, notesLink, expiresAt }: BuiltData) {
    const who = `${escapeHtml(username ?? 'No username')} (#${userId})`;
    const parts = [
      `<p>The personal data export #${exportId} for ${who} is built.</p>`,
      `<p><a href="${escapeHtml(
        archiveLink
      )}">Download the archive</a>. The link works until ${escapeHtml(
        formatTakenAt(expiresAt)
      )}.</p>`,
      notesLink
        ? `<p><a href="${escapeHtml(
            notesLink
          )}">Internal notes file</a>: Legal review before release. It is not part of the archive and is never sent to the account owner by the release step.</p>`
        : '',
      held
        ? '<p><strong>This export is held.</strong> It cannot be released to the account owner from the dashboard; contact Legal.</p>'
        : '<p>Nothing has been sent to the account owner. Release it from the Data Exports page once it has been reviewed.</p>',
    ];
    return simpleEmailWithTemplate({
      header: `Personal data export #${exportId}`,
      body: parts.join(''),
    });
  },
  testData: async () => ({
    to: 'test@tester.com',
    exportId: 1,
    userId: 1,
    username: 'Tester',
    held: false,
    archiveLink: 'https://example.com/archive.zip',
    notesLink: 'https://example.com/notes.csv',
    expiresAt: new Date('2026-11-08T15:15:00Z'),
  }),
});
