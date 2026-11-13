import { describe, expect, it } from 'vitest';
import { ARTICLE_TEXT_LIMIT, articleBody } from '../article-body';

/**
 * The article queue's body: text with the images back where the author put them. Still text — the
 * point is that nothing author-written becomes markup — so the hostile cases matter as much as the
 * ordering.
 */

describe('articleBody', () => {
  it('puts each editor image between the text around it', () => {
    const body = articleBody(
      '<h2>Intro</h2><p>Before.</p><edge-media url="abc-123" type="image" filename="a.png"></edge-media><p>After.</p>'
    );
    expect(body?.segments).toEqual([
      { kind: 'text', text: 'Intro\n\nBefore.' },
      { kind: 'media', url: 'abc-123', mediaType: 'image' },
      { kind: 'text', text: 'After.' },
    ]);
    expect(body?.truncated).toBe(false);
  });

  it('keeps a video as a video', () => {
    const body = articleBody('<edge-media url="v-1" type="video"></edge-media>');
    expect(body?.segments).toEqual([{ kind: 'media', url: 'v-1', mediaType: 'video' }]);
  });

  // A pasted image is usually another site's: carried as its address, loaded only on a click.
  it('carries a pasted image as an external one, with its alt', () => {
    const body = articleBody(
      '<p>x</p><img src="https://example.com/a.jpg?t=1&amp;u=2" alt="Fig &amp; 1" />'
    );
    expect(body?.segments[1]).toEqual({
      kind: 'external',
      src: 'https://example.com/a.jpg?t=1&u=2',
      alt: 'Fig & 1',
    });
  });

  it('turns an embed into its address', () => {
    const body = articleBody(
      '<iframe src="https://www.youtube.com/embed/xyz" width="640"></iframe>'
    );
    expect(body?.segments).toEqual([{ kind: 'embed', src: 'https://www.youtube.com/embed/xyz' }]);
  });

  describe('hostile markup stays text', () => {
    it('drops a script and its body', () => {
      const body = articleBody('<p>hi</p><script>alert(1)</script>');
      expect(body?.segments).toEqual([{ kind: 'text', text: 'hi' }]);
    });

    it.each(['javascript:alert(1)', 'data:image/png;base64,AAAA', '/relative.png', 'JaVaScRiPt:x'])(
      'never links or loads a src of %s',
      (src) => {
        expect(articleBody(`<img src="${src}"><iframe src="${src}"></iframe>`)).toBeNull();
      }
    );

    it('reads src, not data-src or onerror', () => {
      const body = articleBody(
        '<img data-src="https://evil.example/x" onerror="alert(1)" src="https://ok.example/y.png">'
      );
      expect(body?.segments).toEqual([
        { kind: 'external', src: 'https://ok.example/y.png', alt: null },
      ]);
    });

    // The site's sanitiser does not check a media tag's url, so an author can point it anywhere;
    // `EdgeMedia` would fetch an address the moment the panel opened.
    it.each([
      ['https://tracker.example/p.png', 'https://tracker.example/p.png'],
      ['//tracker.example/p.png', 'https://tracker.example/p.png'],
    ])('makes a media tag naming %s an outside image, behind a click', (url, src) => {
      const body = articleBody(
        `<edge-media url="${url}" type="image" filename="p.png"></edge-media>`
      );
      expect(body?.segments).toEqual([{ kind: 'external', src, alt: 'p.png' }]);
    });

    it('drops a media tag naming a non-web address', () => {
      expect(
        articleBody('<edge-media url="javascript:alert(1)" type="image"></edge-media>')
      ).toBeNull();
    });

    it('takes url, not data-url, from a media tag', () => {
      const body = articleBody(
        '<edge-media data-url="wrong" url="right" type="image"></edge-media>'
      );
      expect(body?.segments).toEqual([{ kind: 'media', url: 'right', mediaType: 'image' }]);
    });
  });

  it('caps the text, says so, and shows no media past the cut', () => {
    const long = 'a'.repeat(ARTICLE_TEXT_LIMIT + 10);
    const body = articleBody(
      `<p>${long}</p><edge-media url="late" type="image"></edge-media><p>more</p>`
    );
    expect(body?.truncated).toBe(true);
    expect(body?.segments).toHaveLength(1);
    expect((body?.segments[0] as { text: string }).text).toHaveLength(ARTICLE_TEXT_LIMIT);
  });

  it('is null for an empty body', () => {
    expect(articleBody('')).toBeNull();
    expect(articleBody('<p>  </p>')).toBeNull();
    expect(articleBody(null)).toBeNull();
  });

  // The split must stay linear: a run of unclosed media tags once cost a scan of the rest of the input
  // per tag in the text converter.
  it('splits a body of unclosed tags in linear time', () => {
    const start = performance.now();
    articleBody('<img src="https://x.example/'.repeat(50_000));
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
