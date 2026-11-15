import { describe, expect, it } from 'vitest';
import { removeBodyMedia } from '~/server/utils/article-body-media';

const KEPT = '11111111-1111-4111-8111-111111111111';
const HELD = '22222222-2222-4222-8222-222222222222';
const cdn = (path: string) => `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${path}`;

const strip = (html: string) => removeBodyMedia(html, { keep: new Set([KEPT]), withheld: [HELD] });

describe('removeBodyMediaExcept', () => {
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

  it('changes nothing when nothing is withheld and nothing is kept', () => {
    const html = `<img src="${cdn(`${HELD}/x.jpeg`)}">`;

    expect(removeBodyMedia(html, { withheld: [] })).toBe(html);
  });
});
