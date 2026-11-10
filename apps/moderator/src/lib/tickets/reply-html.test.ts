import { describe, expect, it } from 'vitest';
import { normalizeNewlines, plainTextToHtml } from './reply-html';

describe('plainTextToHtml', () => {
  it('escapes markup so typed HTML is shown as text, never sent as HTML', () => {
    const html = plainTextToHtml(`<script>alert("x")</script> & <img src=x onerror='y'>`);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;x&quot;');
    expect(html).toContain('&#39;y&#39;');
  });

  it('turns a blank line into a paragraph break and a single newline into <br>', () => {
    expect(plainTextToHtml('Hello,\nthere.\r\n\r\nBye')).toBe('<p>Hello,<br>there.</p><p>Bye</p>');
  });

  it('is null for an empty or whitespace-only reply', () => {
    expect(plainTextToHtml('')).toBeNull();
    expect(plainTextToHtml(' \n\t \r\n ')).toBeNull();
  });

  it('counts a browser-submitted CRLF as one character, as the textarea limit does', () => {
    const typed = 'a\nb\nc';
    const posted = typed.replace(/\n/g, '\r\n');
    expect(normalizeNewlines(posted)).toBe(typed);
    expect(normalizeNewlines(posted).length).toBe(typed.length);
    expect(normalizeNewlines('a\rb')).toBe('a\nb');
  });
});
