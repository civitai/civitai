import { convert } from 'html-to-text';
import { EMAIL_PREHEADER_CLASS } from '~/server/email/templates/util';

/**
 * The plain-text part for an email that has no `text()` of its own. Links keep their URL
 * (`label [https://…]`), so a button still works for a reader who only gets plain text. The logo
 * and the hidden preheader are left out. Layout tables (`role="presentation"`) read as blocks;
 * any other table is a data table and keeps its columns.
 */
export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: `.${EMAIL_PREHEADER_CLASS}`, format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'h1', options: { uppercase: false } },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'table', format: 'dataTable' },
      { selector: 'table[role=presentation]', format: 'block' },
    ],
  }).trim();
}
