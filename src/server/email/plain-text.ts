import { convert } from 'html-to-text';
import {
  EMAIL_DECORATION_CLASSES,
  EMAIL_PREHEADER_CLASS,
  EMAIL_ROW_CLASS,
} from '~/server/email/templates/util';

/**
 * The plain-text part for an email that has no `text()` of its own. Links keep their URL
 * (`label [https://…]`), so a button still works for a reader who only gets plain text. The logo,
 * the hidden preheader, the icon badge and the social icons are left out. Layout tables
 * (`role="presentation"`) read as blocks and each summary row as a line; any other table is a
 * data table and keeps its columns.
 */
export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: `.${EMAIL_PREHEADER_CLASS}`, format: 'skip' },
      ...EMAIL_DECORATION_CLASSES.map((c) => ({ selector: `.${c}`, format: 'skip' })),
      // A summary row is a line of its own; html-to-text otherwise writes table rows inline.
      { selector: `.${EMAIL_ROW_CLASS}`, format: 'block' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'h1', options: { uppercase: false } },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'table', format: 'dataTable' },
      { selector: 'table[role=presentation]', format: 'block' },
    ],
  }).trim();
}
