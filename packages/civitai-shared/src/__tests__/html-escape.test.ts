import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../html-escape';

describe('escapeHtml', () => {
  it.each([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
  ])('escapes %j as %j', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  it('escapes every special character in a mixed string, once', () => {
    expect(escapeHtml(`<a href="x" title='y'>Tom & Jerry</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;Tom &amp; Jerry&lt;/a&gt;'
    );
  });

  it('escapes an existing entity again rather than passing it through', () => {
    expect(escapeHtml('&amp; &lt;')).toBe('&amp;amp; &amp;lt;');
  });

  it('leaves other characters alone', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml('plain text / `tick` = é 🎨\n')).toBe('plain text / `tick` = é 🎨\n');
  });
});
