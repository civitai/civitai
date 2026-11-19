import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSanitizedRenderHtml,
  optionsKey,
  SANITIZE_CACHE_MAX_CHARS,
  SANITIZE_CACHE_MAX_ENTRIES,
  sanitizeCacheForTests,
  sanitizeRenderHtml,
  type RenderHtmlSanitizeOptions,
} from '~/components/RenderHtml/sanitize-render-html';

/**
 * RenderHtml's sanitize output is memoized across renders and component instances, keyed on the
 * exact input HTML plus every option the sanitizer reads. A hit must return exactly what the
 * sanitizer would have produced, and a change to ANY input must miss.
 */

const BASE: RenderHtmlSanitizeOptions = {
  maskProfanity: false,
  allowStickers: false,
  allowCustomStyles: true,
  colorScheme: 'dark',
  withMentions: false,
  thirdPartyAllowed: true,
  host: 'civitai.red',
  ownHosts: ['civitai.com', 'civitai.red'],
};

/** One alternative value per option, each different from BASE. */
const FLIPPED: { [K in keyof RenderHtmlSanitizeOptions]: RenderHtmlSanitizeOptions[K] } = {
  maskProfanity: true,
  allowStickers: true,
  allowCustomStyles: false,
  colorScheme: 'light',
  withMentions: true,
  thirdPartyAllowed: false,
  host: 'civitai.com',
  ownHosts: ['civitai.com'],
};

beforeEach(() => sanitizeCacheForTests.clear());
afterEach(() => sanitizeCacheForTests.clear());

describe('getSanitizedRenderHtml memo', () => {
  it('sanitizes an input once and serves repeats from the cache', () => {
    const sanitize = vi.fn((html: string) => `<p>${html}</p>`);
    expect(getSanitizedRenderHtml('a', BASE, sanitize)).toBe('<p>a</p>');
    expect(getSanitizedRenderHtml('a', { ...BASE }, sanitize)).toBe('<p>a</p>');
    expect(getSanitizedRenderHtml('a', { ...BASE, ownHosts: [...BASE.ownHosts] }, sanitize)).toBe(
      '<p>a</p>'
    );
    expect(sanitize).toHaveBeenCalledTimes(1);
  });

  it('misses on different HTML', () => {
    const sanitize = vi.fn((html: string) => html);
    getSanitizedRenderHtml('a', BASE, sanitize);
    getSanitizedRenderHtml('b', BASE, sanitize);
    expect(sanitize).toHaveBeenCalledTimes(2);
  });

  // The key must cover every option: one case per option, so dropping any one from the key
  // turns exactly that case red.
  it.each(Object.keys(FLIPPED) as Array<keyof RenderHtmlSanitizeOptions>)(
    'misses when only %s changes',
    (option) => {
      const sanitize = vi.fn((html: string, options: RenderHtmlSanitizeOptions) =>
        JSON.stringify([html, options[option]])
      );
      const flipped = { ...BASE, [option]: FLIPPED[option] };
      expect(optionsKey(flipped)).not.toBe(optionsKey(BASE));
      const a = getSanitizedRenderHtml('same', BASE, sanitize);
      const b = getSanitizedRenderHtml('same', flipped, sanitize);
      expect(sanitize).toHaveBeenCalledTimes(2);
      expect(b).not.toBe(a);
    }
  );

  it('keeps host lists distinct that a naive join would merge', () => {
    expect(optionsKey({ ...BASE, ownHosts: ['a,b'] })).not.toBe(
      optionsKey({ ...BASE, ownHosts: ['a', 'b'] })
    );
    expect(optionsKey({ ...BASE, host: '' })).not.toBe(optionsKey({ ...BASE, host: null }));
  });

  it('is bounded by entry count, evicting the oldest first', () => {
    const sanitize = vi.fn((html: string) => html);
    for (let i = 0; i < SANITIZE_CACHE_MAX_ENTRIES + 7; i++)
      getSanitizedRenderHtml(`e${i}`, BASE, sanitize);
    expect(sanitizeCacheForTests.size()).toBe(SANITIZE_CACHE_MAX_ENTRIES);
    sanitize.mockClear();
    getSanitizedRenderHtml(`e${SANITIZE_CACHE_MAX_ENTRIES + 6}`, BASE, sanitize); // newest: hit
    expect(sanitize).not.toHaveBeenCalled();
    getSanitizedRenderHtml('e0', BASE, sanitize); // oldest: evicted
    expect(sanitize).toHaveBeenCalledTimes(1);
  });

  it('is bounded by total characters held', () => {
    const sanitize = vi.fn((html: string) => html);
    // ~150k chars per entry (input + output): over the char budget well before the entry cap.
    const big = (i: number) => `${i}:`.padEnd(75_000, 'x');
    for (let i = 0; i < 40; i++) getSanitizedRenderHtml(big(i), BASE, sanitize);
    expect(sanitizeCacheForTests.chars()).toBeLessThanOrEqual(SANITIZE_CACHE_MAX_CHARS);
    expect(sanitizeCacheForTests.size()).toBeLessThan(40);
    expect(sanitizeCacheForTests.size()).toBeGreaterThan(0);
  });

  it('never caches a single oversized entry', () => {
    const sanitize = vi.fn((html: string) => html);
    const huge = 'y'.repeat(150_000);
    getSanitizedRenderHtml(huge, BASE, sanitize);
    getSanitizedRenderHtml(huge, BASE, sanitize);
    expect(sanitize).toHaveBeenCalledTimes(2);
    expect(sanitizeCacheForTests.size()).toBe(0);
  });
});

// Representative stored descriptions/comments: links on our own and foreign domains, mentions,
// coloured spans (colour swap depends on colorScheme), embeds (consent on/off), a strawpoll div,
// a sticker span, raw style attributes and script injection.
const SAMPLES = [
  '<p>Plain <strong>bold</strong> &amp; <em>em</em> — ünïcødé 😀</p>',
  '<p><a href="https://civitai.com/models/1">ours</a> <a href="https://example.com/x" target="_blank">theirs</a></p>',
  '<p><span data-type="mention" data-id="42" data-label="alice">@alice</span> hi</p>',
  '<p><span style="color:#111111">dark text</span> <span style="color:rgb(250, 250, 250)">light text</span></p>',
  '<div data-youtube-video=""><iframe src="https://www.youtube.com/embed/abc" allow="autoplay"></iframe></div>',
  '<div data-type="strawPoll" style="height:400px"><iframe src="https://strawpoll.com/embed/xyz"></iframe></div>',
  '<p><span data-type="sticker" data-id="7"></span></p>',
  '<div style="height:12px" data-consent-blocked="youtube">fake placeholder</div>',
  '<p onclick="alert(1)">x</p><script>alert(1)</script><img src="x" onerror="alert(1)">',
];

describe('cached output is byte-identical to the sanitizer', () => {
  it.each(SAMPLES)('%s', (html) => {
    for (const option of [undefined, ...Object.keys(FLIPPED)] as Array<
      keyof RenderHtmlSanitizeOptions | undefined
    >) {
      const options = option ? { ...BASE, [option]: FLIPPED[option] } : BASE;
      const direct = sanitizeRenderHtml(html, options);
      expect(getSanitizedRenderHtml(html, options)).toBe(direct); // miss
      expect(getSanitizedRenderHtml(html, options)).toBe(direct); // hit
    }
  });
});
