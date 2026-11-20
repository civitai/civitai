import { describe, expect, it } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';

// A production-shaped origin, so the logo's https URL is checked as it ships, not as
// http://localhost. getBaseUrl reads NEXTAUTH_URL when it is called; setEnv is per-file.
setEnv({ NEXTAUTH_URL: 'https://civitai.com' });

const { simpleEmailWithTemplate } = await import('~/server/email/templates/util');
const { htmlToPlainText } = await import('~/server/email/plain-text');

const full = {
  header: 'Your app &quot;Pixel Pal&quot; is approved',
  preheader: 'Preview line for the inbox',
  body: '<p style="margin: 0;">Body copy</p>',
  btnUrl: 'https://civitai.com/apps/run/pixel-pal',
  btnLabel: 'Open your app',
  afterButton: '<p style="margin: 0;">After the button</p>',
  footer: 'Footer small print',
};

describe('simpleEmailWithTemplate', () => {
  it('renders the shared shell', () => {
    expect(simpleEmailWithTemplate(full)).toMatchSnapshot();
  });

  it('wraps the card in a 600px table for classic Outlook and pads cells instead of cellspacing', () => {
    const html = simpleEmailWithTemplate(full);
    expect(html).toContain(
      '<!--[if mso]><table role="presentation" align="center" width="600" border="0" cellspacing="0" cellpadding="0"><tr><td><![endif]-->'
    );
    expect(html).toContain('<!--[if mso]></td></tr></table><![endif]-->');
    expect(html).not.toMatch(/cellspacing="[1-9]/);
    expect(html).not.toContain('cellgap');
  });

  it('gives the button padding, a border, and mso-padding-alt inside an MSO conditional', () => {
    const html = simpleEmailWithTemplate(full);
    const button = html.match(/<a class="em-btn"[^>]*>/)![0];
    expect(button).toContain('href="https://civitai.com/apps/run/pixel-pal"');
    expect(button).toContain('padding: 12px 24px');
    expect(button).toContain('border: 1px solid #1971C2');
    expect(html).toMatch(
      /<!--\[if mso\]><style>[^]*mso-padding-alt: 12px 24px[^]*<\/style><!\[endif\]-->/
    );
  });

  it('declares light and dark support, with dark rules for clients that honour them', () => {
    const html = simpleEmailWithTemplate(full);
    expect(html).toContain('<meta name="supported-color-schemes" content="light dark" />');
    expect(html).toContain(':root { color-scheme: light dark;');
    expect(html).toMatch(
      /@media \(prefers-color-scheme: dark\) \{[^]*\.em-card \{ background-color: #25262B !important;/
    );
    // Only the dark-mode block lives in a <style>; the MSO block is hidden from every other client.
    expect(html.match(/<style>/g)).toHaveLength(2);
  });

  it('heads the card with an h1 that has no margin, escaped as given', () => {
    const html = simpleEmailWithTemplate(full);
    expect(html).toMatch(
      /<h1 class="em-h1" style="margin: 0;[^"]*">Your app &quot;Pixel Pal&quot; is approved<\/h1>/
    );
    expect(html).toContain('<title>Your app &quot;Pixel Pal&quot; is approved</title>');
  });

  it('hides the preheader in the HTML and leaves it out of the plain text', () => {
    const html = simpleEmailWithTemplate(full);
    expect(html).toMatch(
      /<div class="em-preheader" style="display: none;[^"]*">Preview line for the inbox/
    );
    const text = htmlToPlainText(html);
    expect(text).toContain('Body copy');
    expect(text).not.toContain('Preview line for the inbox');
  });

  it('leaves out the optional parts when they are not given', () => {
    const html = simpleEmailWithTemplate({ header: 'Header', body: 'Body' });
    // The class names also appear as CSS selectors, so the attribute is what is checked.
    expect(simpleEmailWithTemplate(full)).toContain('class="em-footer"');
    expect(html).not.toContain('class="em-preheader"');
    expect(html).not.toContain('class="em-btn"');
    expect(html).not.toContain('class="em-footer"');
    expect(html).not.toContain('After the button');
    // A url with no label renders no button rather than one that reads "undefined".
    expect(
      simpleEmailWithTemplate({ header: 'H', body: 'B', btnUrl: 'https://x.test' })
    ).not.toContain('class="em-btn"');
  });
});
