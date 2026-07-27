import { describe, expect, it } from 'vitest';
import { htmlToModerationText } from '~/server/utils/moderation-text';

describe('htmlToModerationText', () => {
  it('drops markup but keeps the prose', () => {
    const text = htmlToModerationText(
      '<h2>Look 1</h2><p>Some <strong>bold</strong> prose.</p><pre><code>1girl, solo</code></pre>'
    );

    expect(text).toContain('Look 1');
    expect(text).toContain('Some bold prose.');
    expect(text).toContain('1girl, solo');
    expect(text).not.toContain('<');
  });

  // The whole reason this isn't `removeTags`: that would leave "click" and throw
  // the URL away, which is the signal spam moderation most needs.
  it('keeps link targets visible', () => {
    const text = htmlToModerationText('<p>See <a href="https://spam.example/x">click</a></p>');

    expect(text).toContain('click');
    expect(text).toContain('https://spam.example/x');
  });

  it('keeps image alt text and target', () => {
    const text = htmlToModerationText('<p><img src="https://evil.example/t.jpg" alt="a shot"></p>');

    expect(text).toContain('a shot');
    expect(text).toContain('https://evil.example/t.jpg');
  });

  it('does not uppercase headings', () => {
    expect(htmlToModerationText('<h1>Costume Party</h1>')).toBe('Costume Party');
  });

  it('does not wrap long lines', () => {
    const sentence = `${'word '.repeat(40)}end`;
    const text = htmlToModerationText(`<p>${sentence}</p>`);

    expect(text).not.toContain('\n');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('returns an empty string for %s content', (_label, input) => {
    expect(htmlToModerationText(input)).toBe('');
  });

  // Legacy rows store tiptap JSON rather than HTML; it must pass through as text
  // rather than throw.
  it('leaves legacy json content intact enough to scan', () => {
    const text = htmlToModerationText('{"type":"doc","content":[{"text":"hello there"}]}');

    expect(text).toContain('hello there');
  });
});
