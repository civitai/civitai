import { describe, expect, it } from 'vitest';
import { createBlurbInputSchema, MAX_BLURB_LENGTH } from '~/server/schema/blurb.schema';

const parse = (content: string) => createBlurbInputSchema.safeParse({ name: 'footer', content });

describe('blurbContentSchema — the length cap', () => {
  it('accepts content at the cap', () => {
    expect(parse('a'.repeat(MAX_BLURB_LENGTH)).success).toBe(true);
  });

  it('🔴 rejects content one character past it', () => {
    const result = parse('a'.repeat(MAX_BLURB_LENGTH + 1));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe(
      `Snippets are limited to ${MAX_BLURB_LENGTH} characters.`
    );
  });

  it('🔴 counts visible text only, so markup never eats the budget', () => {
    const paragraphs = Array.from({ length: 150 }, () => `<p>${'a'.repeat(18)}</p>`).join('');
    expect(paragraphs.length).toBeGreaterThan(MAX_BLURB_LENGTH);

    const result = parse(paragraphs);
    expect(result.success).toBe(true);
    expect(result.data?.content).toBe(paragraphs);
  });

  it('🔴 rejects text past the cap even when wrapped in markup', () => {
    const result = parse(`<p><strong>${'a'.repeat(MAX_BLURB_LENGTH + 1)}</strong></p>`);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe(
      `Snippets are limited to ${MAX_BLURB_LENGTH} characters.`
    );
  });
});

describe('blurbContentSchema — empty content', () => {
  it.each(['', '<p></p>', '<p>   </p><p><strong></strong></p>'])(
    '🔴 rejects %j as empty',
    (input) => {
      const result = parse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toBe('Snippet cannot be empty.');
    }
  );

  it('🔴 strips empty elements before storing', () => {
    expect(parse('<p>a</p><p></p><p><em></em></p><p>b</p>').data?.content).toBe(
      '<p>a</p><p>b</p>'
    );
    expect(parse('<ul><li></li><li>x</li></ul>').data?.content).toBe('<ul><li>x</li></ul>');
  });

  it('keeps line breaks', () => {
    expect(parse('<p>a<br />b</p>').data?.content).toBe('<p>a<br />b</p>');
  });
});

describe('blurbContentSchema — block structure', () => {
  // A blurb is spliced into a `<div>` of its own, so blocks round-trip rather than being flattened
  // to `<br>`. The preprocess that did the flattening is gone; these pin that it stays gone.
  const kept: Array<[string, string]> = [
    ['paragraphs', '<p>a</p><p>b</p>'],
    ['a heading and a paragraph', '<h2>a</h2><p>b</p>'],
    ['a bullet list', '<ul><li>a</li><li>b</li></ul>'],
    ['a numbered list', '<ol><li>a</li></ol>'],
  ];

  it.each(kept)('🔴 keeps %s intact', (_label, input) => {
    const result = parse(input);
    expect(result.success).toBe(true);
    expect(result.data?.content).toBe(input);
  });

  it('still flattens the blocks the toolbar does not offer, keeping their text', () => {
    expect(parse('<blockquote><p>a</p></blockquote><p>b</p>').data?.content).toBe(
      '<p>a</p><p>b</p>'
    );
    expect(parse('<pre><code>a</code></pre><p>b</p>').data?.content).toBe('<code>a</code><p>b</p>');
  });

  it('leaves a single block alone', () => {
    expect(parse('<p>just one line</p>').data?.content).toBe('<p>just one line</p>');
  });
});
