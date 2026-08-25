import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';

const BLURB = '<span data-type="blurb" data-id="7">text</span>';

describe('blurb spans in sanitizeHtml', () => {
  it('are stripped by default', () => {
    expect(sanitizeHtml(`<p>a</p>${BLURB}`)).not.toContain('data-type="blurb"');
  });

  it('survive when the surface opts in', () => {
    expect(sanitizeHtml(`<p>a</p>${BLURB}`, { allowBlurbs: true })).toContain('data-type="blurb"');
  });

  it('are matched case-insensitively and ignoring whitespace', () => {
    const odd = '<span data-type=" BLURB " data-id="7">x</span>';
    expect(sanitizeHtml(odd)).not.toContain('data-id="7"');
  });

  it('do not disturb mentions', () => {
    const mention = '<span data-type="mention" data-id="3">@x</span>';
    expect(sanitizeHtml(mention)).toContain('data-type="mention"');
  });

  it('keeps the words when it strips the reference', () => {
    const out = sanitizeHtml(`<p>a</p>${BLURB}<p>b</p>`);
    expect(out).toContain('text');
    expect(out).not.toContain('data-id');
  });

  it("a caller's own span transform cannot reinstate the reference", () => {
    const out = sanitizeHtml(BLURB, {
      transformTags: { span: (tagName, attribs) => ({ tagName, attribs }) },
    });
    expect(out).not.toContain('data-type="blurb"');
    expect(out).toContain('text');
  });
});
