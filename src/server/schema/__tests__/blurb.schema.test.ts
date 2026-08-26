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
      `Blurbs are limited to ${MAX_BLURB_LENGTH} characters.`
    );
  });

  it('🔴 measures the SANITIZED length, not what the client sent', () => {
    // The cap is what stops one blurb becoming a large multiple of itself across every entity
    // using it, so it has to measure what gets STORED. Checked before the sanitize instead and
    // markup the sanitize was going to strip counts against the author's budget.
    const stripped = `<div>${'a'.repeat(MAX_BLURB_LENGTH - 1)}</div>`;
    expect(stripped.length).toBeGreaterThan(MAX_BLURB_LENGTH);

    const result = parse(stripped);
    expect(result.success).toBe(true);
    expect(result.data?.content).toBe('a'.repeat(MAX_BLURB_LENGTH - 1));
  });
});

describe('blurbContentSchema — block boundaries', () => {
  // The strip below keeps a block element's TEXT and drops the tag, so a boundary the
  // preprocessor misses runs two lines together with nothing to point at afterwards.
  const cases: Array<[string, string, string]> = [
    ['paragraphs', '<p>a</p><p>b</p>', 'a<br />b'],
    ['a code block', '<pre><code>a</code></pre><p>b</p>', '<code>a</code><br />b'],
    ['a blockquote', '<blockquote><p>a</p></blockquote><p>b</p>', 'a<br />b'],
    ['list items', '<ul><li><p>a</p></li><li><p>b</p></li></ul>', 'a<br />b'],
    ['a heading', '<h2>a</h2><p>b</p>', 'a<br />b'],
    ['a paragraph and a pre', '<p>a</p><pre>b</pre>', 'a<br />b'],
    ['blocks separated by whitespace', '<p>a</p>\n  <p>b</p>', 'a<br />b'],
  ];

  it.each(cases)('🔴 keeps the break between %s', (_label, input, expected) => {
    const result = parse(input);
    expect(result.success).toBe(true);
    expect(result.data?.content).toBe(expected);
  });

  it('leaves a single block alone', () => {
    expect(parse('<p>just one line</p>').data?.content).toBe('just one line');
  });
});
