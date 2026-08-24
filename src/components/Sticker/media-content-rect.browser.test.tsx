import { describe, expect, test } from 'vitest';
import { mediaContentRectOf } from '~/components/Sticker/media-content-rect';

/**
 * The half the unit tests cannot reach: reading a real element.
 *
 * `mediaContentRect` is arithmetic and covered as arithmetic. What is asserted
 * here is that the three values fed to it come off the DOM correctly — the
 * natural size of a decoded image, and `object-fit`/`object-position` as the
 * browser resolves them, which is where keywords become percentages and where a
 * stylesheet's `object-position: top` stops being a string anyone can predict.
 */

/** A 2x1 PNG. Its natural size is the point; the pixels are not. */
const TWO_BY_ONE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGP4z8AARAAI/gH/xp559wAAAABJRU5ErkJggg==';

const drawImage = async (style: Partial<CSSStyleDeclaration>) => {
  const host = document.createElement('div');
  host.style.width = '400px';
  host.style.height = '400px';
  document.body.append(host);

  const img = document.createElement('img');
  Object.assign(img.style, { width: '100%', height: '100%', ...style });

  const loaded = new Promise((resolve, reject) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', reject, { once: true });
  });

  img.src = TWO_BY_ONE;
  host.append(img);
  await loaded;

  return { img, cleanup: () => host.remove() };
};

describe('reading a real element', () => {
  test('cover: the artwork overflows the element, and the rect says where', async () => {
    const { img, cleanup } = await drawImage({ objectFit: 'cover', objectPosition: 'top' });

    // The element is the square the card gives it...
    expect(img.offsetWidth).toBe(400);
    expect(img.offsetHeight).toBe(400);

    // ...and the artwork inside it is 2:1, scaled to cover 400 tall, so it is
    // 800 wide and hanging 200px off each side. `object-position: top` resolves
    // to `50% 0%`, which centres the horizontal overflow.
    const drawn = mediaContentRectOf(img);
    expect(drawn).toEqual({ width: 800, height: 400, left: -200, top: 0 });

    cleanup();
  });

  test('an element with no object-fit is its own box', async () => {
    const { img, cleanup } = await drawImage({});

    expect(mediaContentRectOf(img)).toEqual({ width: 400, height: 400, left: 0, top: 0 });

    cleanup();
  });

  /**
   * The state the overlay measures in before the file arrives. It must come back
   * as the element box rather than as `NaN` — a `NaN` reaches the DOM as
   * `NaNpx` and the overlay vanishes instead of being merely misplaced.
   */
  test('an image that has not loaded yields the element box, not NaN', () => {
    const host = document.createElement('div');
    host.style.cssText = 'width:400px;height:400px';
    const img = document.createElement('img');
    img.style.cssText = 'width:100%;height:100%;object-fit:cover';
    host.append(img);
    document.body.append(host);

    expect(img.naturalWidth).toBe(0);
    const drawn = mediaContentRectOf(img);

    expect(Number.isNaN(drawn.width + drawn.height + drawn.left + drawn.top)).toBe(false);
    expect(drawn).toEqual({ width: 400, height: 400, left: 0, top: 0 });

    host.remove();
  });
});
