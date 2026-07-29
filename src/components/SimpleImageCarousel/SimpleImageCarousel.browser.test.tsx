import { describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../test/component-setup';
import { SimpleImageCarousel } from '~/components/SimpleImageCarousel/SimpleImageCarousel';

// =============================================================================
// Opt-in swipe on SimpleImageCarousel (`swipeGalleryCards` user setting).
//
// Pins the gesture contract the gallery post cards depend on:
//   * OFF by default — no touch-action opt-out, and a horizontal drag does
//     nothing (this is what every viewer gets unless they turn the setting on).
//   * ON — a horizontal drag advances/rewinds the slide, and only past the
//     distance threshold.
//   * A VERTICAL drag is handed back to the browser so the feed still scrolls.
//   * A completed drag swallows the click behind it, so releasing your finger
//     doesn't also open the image-detail link under the slide.
// =============================================================================

function Harness({
  enableSwipe,
  onLinkClick,
}: {
  enableSwipe?: boolean;
  onLinkClick?: () => void;
}) {
  return (
    <SimpleImageCarousel total={3} enableSwipe={enableSwipe}>
      <SimpleImageCarousel.Viewport className="size-40">
        <SimpleImageCarousel.Container>
          {[0, 1, 2].map((index) => (
            <SimpleImageCarousel.Slide key={index} index={index}>
              <a data-testid="link" onClick={onLinkClick}>
                <div data-testid="slide" data-index={String(index)} className="size-40" />
              </a>
            </SimpleImageCarousel.Slide>
          ))}
        </SimpleImageCarousel.Container>
      </SimpleImageCarousel.Viewport>
    </SimpleImageCarousel>
  );
}

const activeIndex = () =>
  document.querySelector('[data-testid="slide"]')?.getAttribute('data-index');

const viewport = () => document.querySelector('[data-testid="slide"]')!.closest('div.relative')!;

function pointer(type: string, x: number, y: number) {
  return new PointerEvent(type, {
    pointerId: 1,
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
    cancelable: true,
  });
}

/** Drag from (0,0) by (dx, dy) in a few steps, as a real finger would. */
function drag(dx: number, dy: number) {
  const target = viewport();
  target.dispatchEvent(pointer('pointerdown', 0, 0));
  for (const step of [0.34, 0.67, 1]) {
    target.dispatchEvent(pointer('pointermove', dx * step, dy * step));
  }
  target.dispatchEvent(pointer('pointerup', dx, dy));
}

function click() {
  document
    .querySelector('[data-testid="link"]')!
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('SimpleImageCarousel swipe', () => {
  test('is off by default: no drag surface, no slide change', async () => {
    renderWithProviders(<Harness />);
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));

    expect(viewport().classList.contains('touch-pan-y')).toBe(false);

    drag(-120, 0);
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));
  });

  test('drags to the next and previous slide when enabled', async () => {
    renderWithProviders(<Harness enableSwipe />);
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));

    expect(viewport().classList.contains('touch-pan-y')).toBe(true);

    drag(-120, 0);
    await vi.waitFor(() => expect(activeIndex()).toBe('1'));

    drag(120, 0);
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));
  });

  test('ignores a drag shorter than the distance threshold', async () => {
    renderWithProviders(<Harness enableSwipe />);
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));

    drag(-20, 0);
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));
  });

  test('leaves a vertical drag to the browser', async () => {
    renderWithProviders(<Harness enableSwipe />);
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));

    // Mostly-vertical with real horizontal travel: the axis lock must read this
    // as a page scroll, not a swipe.
    drag(-60, 140);
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));
  });

  test('swallows the click that follows a completed drag', async () => {
    const onLinkClick = vi.fn();
    renderWithProviders(<Harness enableSwipe onLinkClick={onLinkClick} />);
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));

    drag(-120, 0);
    await vi.waitFor(() => expect(activeIndex()).toBe('1'));

    click();
    expect(onLinkClick).not.toHaveBeenCalled();

    // The suppression is one-shot: the next tap still opens the link.
    click();
    expect(onLinkClick).toHaveBeenCalledTimes(1);
  });
});
