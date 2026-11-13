import { describe, expect, it } from 'vitest';
import { getProfanityFilter } from '~/libs/profanity-simple';
import { maskProfanityOutsideMarkup } from '../mask-profanity';

const filter = getProfanityFilter();

// The previous implementation hid markup behind `__pf<nonce>T<i>__` tokens and cleaned the
// whole string, so a nonce that spelled a blocked word got the token masked and the tag was
// lost. These are the shapes such a token had: letters from a base-36 nonce, then T/M + index.
const HOSTILE_TOKENS = ['__pffuckabcdefT0__', '__pfqrstfuckvwT1__', '__pffuckabcdefM0__'];

describe('maskProfanityOutsideMarkup', () => {
  it('guard: the fixtures really are masked by the filter', () => {
    // Positive control: if the filter stopped matching these, the tests below could not fail.
    for (const token of HOSTILE_TOKENS) expect(filter.clean(token), token).not.toBe(token);
  });

  it('masks visible profane text', () => {
    const out = maskProfanityOutsideMarkup('<p>what the fuck</p>', filter);
    expect(out).not.toContain('fuck');
    expect(out.startsWith('<p>')).toBe(true);
    expect(out.endsWith('</p>')).toBe(true);
  });

  it('masks profane text between and inside nested tags', () => {
    const out = maskProfanityOutsideMarkup('<p>shit <b>fuck</b> <i>ok</i></p>', filter);
    expect(out).not.toMatch(/shit|fuck/);
    expect(out).toContain('<b>');
    expect(out).toContain('</b>');
    expect(out).toContain('<i>ok</i>');
  });

  it('leaves clean html byte-identical', () => {
    const html = '<p>hello <a href="https://example.com/cum?x=fuck">link</a></p>';
    // href is markup, not visible text, so it is never filtered; only "link" is text.
    expect(maskProfanityOutsideMarkup(html, filter)).toBe(html);
  });

  it('keeps mention spans, including a profane-looking label, untouched', () => {
    const mention = '<span data-type="mention" data-id="1" data-label="cum">@cum</span>';
    const out = maskProfanityOutsideMarkup(`<p>${mention} you fuck</p>`, filter);
    expect(out).toContain(mention);
    expect(out).not.toContain('fuck');
  });

  it('keeps tags whose attributes would match the filter', () => {
    const html = '<img src="https://x.test/cum.png" alt="fuck"><p>ok</p>';
    expect(maskProfanityOutsideMarkup(html, filter)).toBe(html);
  });

  it('restores every tag when user text looks like an old placeholder', () => {
    for (const token of HOSTILE_TOKENS) {
      const out = maskProfanityOutsideMarkup(`<p><b>${token}</b> <i>x</i></p>`, filter);
      expect(out.match(/<\/?[a-z]+>/g)).toEqual(['<p>', '<b>', '</b>', '<i>', '</i>', '</p>']);
    }
  });
});
