import type { EmblaCarouselType } from 'embla-carousel';
import { describe, expect, test } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';
import { STICKER_EDITOR_ATTR, watchTouchDrag } from '~/components/EmblaCarousel/watchTouchDrag';

/** A touch swipe from right to left, starting on `target`. */
const swipe = (target: Element) => {
  const at = (x: number) =>
    new Touch({ identifier: 1, target, clientX: x, clientY: 50, pageX: x, pageY: 50 });
  const fire = (type: string, x: number) => {
    const touch = at(x);
    target.dispatchEvent(
      new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === 'touchend' ? [] : [touch],
        targetTouches: type === 'touchend' ? [] : [touch],
        changedTouches: [touch],
      })
    );
  };
  fire('touchstart', 250);
  for (let x = 230; x >= 30; x -= 20) fire('touchmove', x);
  fire('touchend', 30);
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

async function renderCarousel() {
  let embla: EmblaCarouselType | undefined;
  await renderWithProviders(
    <div style={{ width: 300 }}>
      <Embla watchDrag={watchTouchDrag} setEmbla={(api) => (embla = api)}>
        <Embla.Viewport style={{ overflow: 'hidden' }}>
          <Embla.Container style={{ display: 'flex' }}>
            <Embla.Slide index={0} style={{ flex: '0 0 100%' }}>
              <div style={{ position: 'relative', height: 200 }}>
                <p data-testid="image">image</p>
                <div
                  data-testid="draft"
                  {...{ [STICKER_EDITOR_ATTR]: '' }}
                  onPointerDown={(event) => event.stopPropagation()}
                  style={{ position: 'absolute', left: 100, top: 20, width: 100, height: 100 }}
                />
              </div>
            </Embla.Slide>
            <Embla.Slide index={1} style={{ flex: '0 0 100%' }}>
              <div style={{ height: 200 }}>second</div>
            </Embla.Slide>
          </Embla.Container>
        </Embla.Viewport>
      </Embla>
    </div>
  );
  await expect.poll(() => embla).toBeDefined();
  return () => embla as EmblaCarouselType;
}

// The draft also stops pointerdown, as the real one does: that must not be what
// keeps the carousel still.
describe('watchTouchDrag', () => {
  test('a swipe on the image changes slide', async () => {
    const embla = await renderCarousel();
    swipe(document.querySelector('[data-testid="image"]') as Element);
    await expect.poll(() => embla().selectedScrollSnap()).toBe(1);
  });

  test('a drag on a sticker being placed leaves the slide where it is', async () => {
    const embla = await renderCarousel();
    swipe(document.querySelector('[data-testid="draft"]') as Element);
    await settle();
    expect(embla().selectedScrollSnap()).toBe(0);
  });
});
