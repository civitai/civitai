import type { EmblaCarouselType } from 'embla-carousel';
import { describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';

async function renderCarousel() {
  let embla: EmblaCarouselType | undefined;
  const onSlideChange = vi.fn();
  await renderWithProviders(
    <div style={{ width: 300 }}>
      <Embla duration={1} onSlideChange={onSlideChange} setEmbla={(api) => (embla = api)}>
        <Embla.Viewport style={{ overflow: 'hidden' }}>
          <Embla.Container style={{ display: 'flex' }}>
            {[0, 1, 2].map((index) => (
              <Embla.Slide key={index} index={index} style={{ flex: '0 0 100%' }}>
                <div style={{ height: 100 }}>slide {index}</div>
              </Embla.Slide>
            ))}
          </Embla.Container>
        </Embla.Viewport>
      </Embla>
    </div>
  );
  await expect.poll(() => embla).toBeDefined();
  return { embla: embla as EmblaCarouselType, onSlideChange };
}

describe('EmblaCarouselProvider onSlideChange', () => {
  test('a reInit that keeps the selected slide is not announced as a slide change', async () => {
    const { embla, onSlideChange } = await renderCarousel();
    embla.scrollTo(1, true);
    expect(onSlideChange).toHaveBeenLastCalledWith(1);
    onSlideChange.mockClear();

    // what a resize, or a slide appended by `watchSlides`, runs
    embla.reInit();

    expect(embla.selectedScrollSnap()).toBe(1);
    expect(onSlideChange).not.toHaveBeenCalled();
  });

  test('a reInit that moves the selected slide is announced', async () => {
    const { embla, onSlideChange } = await renderCarousel();
    onSlideChange.mockClear();

    embla.reInit({ startIndex: 2 });

    expect(onSlideChange).toHaveBeenCalledExactlyOnceWith(2);
  });
});
