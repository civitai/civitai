import { describe, expect, it } from 'vitest';
import { htmlToPlainText } from '~/server/email/plain-text';
import { createEmail } from '~/server/email/templates/base.email';

describe('htmlToPlainText', () => {
  it('keeps a link URL next to its label', () => {
    const text = htmlToPlainText(
      '<p>Read <a href="https://civitai.com/content/tos">the terms</a> first.</p>'
    );
    expect(text).toBe('Read the terms [https://civitai.com/content/tos] first.');
  });

  it('prints a URL once when the label is the URL', () => {
    expect(htmlToPlainText('<a href="https://civitai.com/x">https://civitai.com/x</a>')).toBe(
      'https://civitai.com/x'
    );
  });

  it('drops images and the preheader, and keeps a data table in columns', () => {
    const text = htmlToPlainText(
      '<div class="em-preheader">Preview</div><img src="https://civitai.com/logo.png" alt="Civitai" />' +
        '<table role="presentation"><tr><td>Layout cell</td></tr></table>' +
        '<table><tr><th>Plan</th><th>Price</th></tr><tr><td>Gold</td><td>$10</td></tr></table>'
    );
    expect(text).not.toContain('Preview');
    expect(text).not.toContain('Civitai');
    expect(text).toContain('Layout cell');
    expect(text).toMatch(/Plan\s+Price\n\s*Gold\s+\$10/);
  });
});

describe('createEmail plain-text part', () => {
  it('derives it from the HTML, links included, when the template has no text()', () => {
    const email = createEmail({
      header: (data: { to: string }) => ({ subject: 'S', to: data.to }),
      html: () => '<p>Hi</p><a class="em-btn" href="https://civitai.com/apps/run/a%20b">Open</a>',
    });
    expect(email.getText({ to: 'a@example.com' })).toBe(
      'Hi\n\nOpen [https://civitai.com/apps/run/a%20b]'
    );
  });

  it("keeps a template's own text()", () => {
    const email = createEmail({
      header: (data: { to: string }) => ({ subject: 'S', to: data.to }),
      html: () => '<p>Hi</p>',
      text: () => 'Own text',
    });
    expect(email.getText({ to: 'a@example.com' })).toBe('Own text');
  });
});
