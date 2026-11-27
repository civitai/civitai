import { describe, expect, it, vi } from 'vitest';
import {
  readerArticleBody,
  removeBodyMedia,
  servableBodyImageUrls,
} from '~/server/utils/article-body-media';
import { servableArticleImage } from '~/shared/utils/article-card-image';

const KEPT = '11111111-1111-4111-8111-111111111111';
const HELD = '22222222-2222-4222-8222-222222222222';
const cdn = (path: string) => `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${path}`;

const strip = (html: string) => removeBodyMedia(html, { keep: new Set([KEPT]), withheld: [HELD] });

describe('removeBodyMedia', () => {
  it('keeps a servable image and the text around it', () => {
    const src = cdn(`${KEPT}/width=450/x.jpeg`);

    expect(strip(`<p>a</p><img src="${src}" alt="x"><p>b</p>`)).toBe(
      `<p>a</p><img src="${src}" alt="x" /><p>b</p>`
    );
  });

  it('🔴 drops a kept image whose source also names a withheld uuid', () => {
    for (const path of [
      `${KEPT}/original=true/${HELD}.jpeg`,
      `${KEPT}/x.jpeg?${HELD.toUpperCase()}`,
    ]) {
      const out = strip(`<p>a</p><img src="${cdn(path)}">`);
      expect(out.toLowerCase()).not.toContain(HELD);
      expect(out).toBe('<p>a</p>');
    }
  });

  it('🔴 drops a withheld image however its source spells the uuid', () => {
    const encoded = [...HELD].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('');
    const out = removeBodyMedia(
      `<p>a</p><img src="${cdn(`${encoded}/x.jpeg`)}"><edge-media url="${cdn(
        `${encoded}/x.mp4`
      )}"></edge-media>`,
      { withheld: [HELD] }
    );

    expect(out).toBe('<p>a</p>');
  });

  it('🔴 a link to a withheld image keeps its text and loses its href', () => {
    const out = strip(`<p><a href="${cdn(`${HELD}/a.jpeg`)}" rel="ugc">see</a></p>`);

    expect(out).toBe('<p><a rel="ugc">see</a></p>');
  });

  it('leaves a link to anything else alone', () => {
    const html = `<p><a href="${cdn(`${KEPT}/a.jpeg`)}">see</a></p>`;

    expect(strip(html)).toBe(html);
  });

  it('🔴 without `keep`, drops only withheld media and leaves unlinked images', () => {
    const other = cdn('33333333-3333-4333-8333-333333333333/x.jpeg');
    const out = removeBodyMedia(
      `<img src="${cdn(
        `${HELD}/x.jpeg`
      )}"><edge-media url="${HELD}"></edge-media><img src="${other}">`,
      { withheld: [HELD] }
    );

    expect(out).toBe(`<img src="${other}" />`);
  });

  it('keeps a servable video given by its full url', () => {
    const html = `<edge-media url="${cdn(`${KEPT}/x.mp4`)}"></edge-media>`;

    expect(strip(html)).toBe(html);
  });

  it('leaves other links and sources as stored', () => {
    const html = `<p><a href="civitai://models/1">m</a></p>`;

    expect(strip(html)).toBe(html);
  });

  it('an empty withheld entry withholds nothing', () => {
    const html = `<img src="${cdn(`${KEPT}/x.jpeg`)}" /><p><a href="https://example.com">x</a></p>`;

    expect(removeBodyMedia(html, { keep: new Set([KEPT]), withheld: [''] })).toBe(html);
  });

  it('🔴 drops an edge-media whose url names no uuid, even with nothing withheld', () => {
    const out = removeBodyMedia(`<p>a</p><edge-media url="not-a-uuid"></edge-media>`, {
      withheld: [],
    });

    expect(out).toBe('<p>a</p>');
  });

  it('🔴 given keepEdgeMedia, drops edge-media outside it and leaves images alone', () => {
    const img = `<img src="${cdn(`${HELD}/x.jpeg`)}" />`;
    const out = removeBodyMedia(
      `${img}<edge-media url="${KEPT}"></edge-media><edge-media url="${HELD}"></edge-media>`,
      { keepEdgeMedia: new Set([KEPT]), withheld: [] }
    );

    expect(out).toBe(`${img}<edge-media url="${KEPT}"></edge-media>`);
  });

  it('🔴 still reads an edge-media the quick check cannot', () => {
    for (const tag of [
      `<edge-media type="a>b" url="not-a-uuid"></edge-media>`,
      `<edge-media url='not-a-uuid'></edge-media>`,
      `<edge-media data-url="${KEPT}" url="not-a-uuid"></edge-media>`,
    ])
      expect(
        removeBodyMedia(`<p>a</p>${tag}`, { keepEdgeMedia: new Set([KEPT]), withheld: [] })
      ).toBe('<p>a</p>');
  });

  it('returns a body with nothing to remove as stored', () => {
    const html = `<p>a<br></p><edge-media url="${KEPT}" type="video"></edge-media><img src="${cdn(
      `${HELD}/x.jpeg`
    )}">`;

    expect(removeBodyMedia(html, { keepEdgeMedia: new Set([KEPT]), withheld: [] })).toBe(html);
  });

  it('removes media without warning, passing script and style through unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const out = strip(
        `<p>a</p><img src="${cdn(`${HELD}/x.jpeg`)}"><script>alert(1)</script><style>p{}</style>`
      );
      expect(out).toBe('<p>a</p><script>alert(1)</script><style>p{}</style>');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('changes nothing when nothing is withheld and nothing is kept', () => {
    const html = `<img src="${cdn(`${HELD}/x.jpeg`)}">`;

    expect(removeBodyMedia(html, { withheld: [] })).toBe(html);
  });
});

describe('what a reader is served of a body image', () => {
  const MISSING = '33333333-3333-4333-8333-333333333333';
  const image = (ingestion: string) => ({
    id: 1,
    url: MISSING,
    ingestion: ingestion as 'Scanned',
    nsfwLevel: 1,
    needsReview: null,
    tosViolation: false,
    modelRestricted: false,
    minor: false,
  });
  const body = `<p>a</p><img src="${cdn(
    `${MISSING}/x.jpeg`
  )}"><edge-media url="${MISSING}"></edge-media>`;

  // An article with a missing image goes public, so its url must never reach a reader before the
  // image itself is Scanned.
  it.each(['NotFound', 'Error', 'Pending', 'Rescan', 'Blocked'])(
    '🔴 never serves an image at %s',
    (ingestion) => {
      const served = readerArticleBody(body, [image(ingestion)], new Set());

      expect(served.kept).toEqual([]);
      expect(served.content).toBe('<p>a</p>');
      expect(servableBodyImageUrls([image(ingestion)], 1).size).toBe(0);
      expect(servableArticleImage(image(ingestion))).toBeNull();
    }
  );

  it('serves the same image once it is Scanned', () => {
    const served = readerArticleBody(body, [image('Scanned')], new Set());

    expect(served.kept).toHaveLength(1);
    expect(served.content).toContain(MISSING);
    expect(servableBodyImageUrls([image('Scanned')], 1)).toEqual(new Set([MISSING]));
  });
});
