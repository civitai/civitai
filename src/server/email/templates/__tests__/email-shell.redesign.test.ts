import { existsSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';

// A non-default origin, so every asset and site link is seen to follow the main app's own base
// URL rather than the package default.
setEnv({ NEXTAUTH_URL: 'https://staging.example.test' });
const ORIGIN = 'https://staging.example.test';

const { simpleEmailWithTemplate, renderEmailSummary, renderEmailCallout, emailAccents } =
  await import('~/server/email/templates/util');
const { htmlToPlainText } = await import('~/server/email/plain-text');

const openingTags = (html: string, tag: string) =>
  html.match(new RegExp(`<${tag}\\b[^>]*>`, 'gi')) ?? [];

describe('icon badge, eyebrow and accent', () => {
  const html = simpleEmailWithTemplate({
    header: 'Your model is ready',
    body: '<p>Body</p>',
    icon: '🎉',
    accent: 'violet',
    eyebrow: 'Model training',
  });

  it('renders the badge and the eyebrow above the heading, in the accent colours', () => {
    const badge = html.match(/<td class="em-badge"[^>]*>([^<]*)<\/td>/);
    expect(badge?.[1]).toBe('🎉');
    expect(badge?.[0]).toContain(`bgcolor="${emailAccents.violet.tint}"`);
    const eyebrow = html.match(/<p class="em-eyebrow" style="([^"]*)">([^<]*)<\/p>/);
    expect(eyebrow?.[2]).toBe('Model training');
    expect(eyebrow?.[1]).toContain(`color: ${emailAccents.violet.text};`);
    expect(html.indexOf('class="em-badge"')).toBeLessThan(html.indexOf('class="em-eyebrow"'));
    expect(html.indexOf('class="em-eyebrow"')).toBeLessThan(html.indexOf('<h1 '));
    // Apple Mail's dark mode swaps the eyebrow to the accent's dark-surface colour.
    expect(html).toContain(`.em-eyebrow { color: ${emailAccents.violet.darkText} !important; }`);
  });

  it('paints the stripe with a solid bgcolor under the gradient, for clients without gradients', () => {
    const stripe = openingTags(html, 'td').find((tag) => tag.includes('class="em-accent"'));
    expect(stripe).toContain(`bgcolor="${emailAccents.violet.solid}"`);
    expect(stripe).toContain(`background-color: ${emailAccents.violet.solid};`);
    expect(stripe).toContain(
      `background-image: linear-gradient(90deg, ${emailAccents.violet.from}, ${emailAccents.violet.to});`
    );
  });

  it('defaults to the blue accent with no badge or eyebrow', () => {
    const plain = simpleEmailWithTemplate({ header: 'H', body: 'B' });
    expect(plain).not.toContain('class="em-badge"');
    expect(plain).not.toContain('class="em-eyebrow"');
    const stripe = openingTags(plain, 'td').find((tag) => tag.includes('class="em-accent"'));
    expect(stripe).toContain(`bgcolor="${emailAccents.blue.solid}"`);
  });

  it('leaves the badge out of the plain text but keeps the eyebrow and heading', () => {
    const text = htmlToPlainText(html);
    expect(text).not.toContain('🎉');
    expect(text).toContain('Model training');
    expect(text).toContain('Your model is ready');
  });
});

describe('page footer', () => {
  const html = simpleEmailWithTemplate({ header: 'H', body: 'B' });
  const socialImgs = openingTags(html, 'img').filter((tag) => tag.includes('/social-'));

  it('links the five social profiles with sized, labelled icons from the app origin', () => {
    expect(socialImgs.map((tag) => tag.match(/alt="([^"]*)"/)?.[1])).toEqual([
      'Discord',
      'X',
      'Instagram',
      'YouTube',
      'Reddit',
    ]);
    for (const tag of socialImgs) {
      expect(tag).toMatch(new RegExp(`src="${ORIGIN}/images/email/social-[a-z]+@2x\\.png"`));
      expect(tag).toContain('width="32"');
      expect(tag).toContain('height="32"');
    }
    for (const href of [
      'https://discord.gg/civitai',
      'https://twitter.com/HelloCivitai',
      'https://www.instagram.com/hellocivitai/',
      'https://www.youtube.com/@civitai',
      'https://reddit.com/r/civitai',
    ])
      expect(html).toContain(`<a href="${href}"`);
  });

  it('ships every icon it references', () => {
    expect(socialImgs).toHaveLength(5);
    for (const tag of socialImgs) {
      const file = tag.match(/\/images\/email\/([^"]+)"/)![1]!;
      expect(
        existsSync(path.resolve(__dirname, '../../../../../public/images/email', file)),
        file
      ).toBe(true);
    }
  });

  it('links the policies on the app origin, and keeps them but not the icons in plain text', () => {
    for (const href of ['/content/tos', '/content/privacy', '/support'])
      expect(html).toContain(`href="${ORIGIN}${href}"`);
    const text = htmlToPlainText(html);
    expect(text).toContain(`Terms of Service [${ORIGIN}/content/tos]`);
    expect(text).toContain(`Privacy [${ORIGIN}/content/privacy]`);
    expect(text).not.toContain('discord.gg');
    expect(text).not.toContain('twitter.com');
  });
});

describe('summary and callout blocks', () => {
  it('renders label/value rows in a layout table that reads as lines in plain text', () => {
    const block = renderEmailSummary([
      { label: 'Model', value: 'Pixel &amp; Pal' },
      { label: 'Version', value: 'v2' },
    ]);
    expect(openingTags(block, 'table').every((tag) => tag.includes('role="presentation"'))).toBe(
      true
    );
    expect(block).toMatch(/>Model<\/td>\s*<td[^>]*>Pixel &amp; Pal<\/td>/);
    expect(block).toMatch(/>Version<\/td>\s*<td[^>]*>v2<\/td>/);
    const text = htmlToPlainText(simpleEmailWithTemplate({ header: 'H', body: block }));
    expect(text).toMatch(/Model\s+Pixel & Pal/);
    expect(text).toMatch(/Version\s+v2/);
  });

  it('puts a callout behind an accent bar, in a monospace face when asked', () => {
    const note = renderEmailCallout('Payment ID: 1\nTXID: 2', { accent: 'red', mono: true });
    expect(note).toContain(`border-left: 4px solid ${emailAccents.red.solid};`);
    expect(note).toContain(`bgcolor="${emailAccents.red.tint}"`);
    expect(note).toContain('white-space: pre-wrap;');
    expect(note).toContain('Menlo');
    expect(renderEmailCallout('x')).not.toContain('Menlo');
  });
});
