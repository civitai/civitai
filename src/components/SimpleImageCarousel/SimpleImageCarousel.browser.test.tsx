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
  onReactionClick,
}: {
  enableSwipe?: boolean;
  onLinkClick?: () => void;
  onReactionClick?: () => void;
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
              {/* Stands in for the reaction bar / meta button / chevrons, which
                  all live inside the swipe surface in the real card. */}
              <button data-testid="reaction" type="button" onClick={onReactionClick} />
            </SimpleImageCarousel.Slide>
          ))}
        </SimpleImageCarousel.Container>
      </SimpleImageCarousel.Viewport>
    </SimpleImageCarousel>
  );
}

const activeIndex = () =>
  document.querySelector('[data-testid="slide"]')?.getAttribute('data-index');

const viewport = () => document.querySelector('[data-carousel-viewport]')!;
const el = (testId: string) => document.querySelector(`[data-testid="${testId}"]`)!;

function pointer(
  type: string,
  x: number,
  y: number,
  { buttons = 1, button = 0 }: { buttons?: number; button?: number } = {}
) {
  return new PointerEvent(type, {
    pointerId: 1,
    isPrimary: true,
    clientX: x,
    clientY: y,
    button,
    buttons,
    bubbles: true,
    cancelable: true,
  });
}

/**
 * Drag from (0,0) by (dx, dy) in a few steps, as a real finger would. `from`
 * starts the gesture on a descendant so the events bubble up to the viewport the
 * way a tap on the reaction bar does.
 */
function drag(dx: number, dy: number, from: Element = viewport()) {
  from.dispatchEvent(pointer('pointerdown', 0, 0));
  for (const step of [0.34, 0.67, 1]) {
    from.dispatchEvent(pointer('pointermove', dx * step, dy * step));
  }
  from.dispatchEvent(pointer('pointerup', dx, dy, { buttons: 0 }));
}

function click(testId = 'link') {
  el(testId).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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

  test('a sloppy tap on a control inside the surface still registers', async () => {
    const onReactionClick = vi.fn();
    renderWithProviders(<Harness enableSwipe onReactionClick={onReactionClick} />);
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));

    // Between the axis lock (10px) and the swipe distance (45px): too far to be
    // a clean tap, too short to move the carousel. It must not eat the click.
    drag(-25, 4, el('reaction'));
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));

    click('reaction');
    expect(onReactionClick).toHaveBeenCalledTimes(1);
  });

  test('drops a gesture whose pointer was released outside the surface', async () => {
    const onLinkClick = vi.fn();
    renderWithProviders(<Harness enableSwipe onLinkClick={onLinkClick} />);
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));

    // Press, then leave and release elsewhere — no pointerup reaches us.
    viewport().dispatchEvent(pointer('pointerdown', 0, 0));

    // Hovering back across the surface with nothing pressed must not resurrect
    // the gesture against the stale origin (it would take pointer capture and
    // then swallow an unrelated click).
    viewport().dispatchEvent(pointer('pointermove', 200, 0, { buttons: 0 }));
    viewport().dispatchEvent(pointer('pointerup', 200, 0, { buttons: 0 }));
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));

    click();
    expect(onLinkClick).toHaveBeenCalledTimes(1);
  });

  test('a cancelled gesture changes nothing', async () => {
    renderWithProviders(<Harness enableSwipe />);
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));

    viewport().dispatchEvent(pointer('pointerdown', 0, 0));
    viewport().dispatchEvent(pointer('pointermove', -80, 0));
    viewport().dispatchEvent(pointer('pointercancel', -80, 0));
    viewport().dispatchEvent(pointer('pointerup', -120, 0, { buttons: 0 }));
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));
  });

  test('ignores a non-primary mouse button', async () => {
    renderWithProviders(<Harness enableSwipe />);
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));

    viewport().dispatchEvent(pointer('pointerdown', 0, 0, { button: 2, buttons: 2 }));
    viewport().dispatchEvent(pointer('pointermove', -120, 0, { buttons: 2 }));
    viewport().dispatchEvent(pointer('pointerup', -120, 0, { buttons: 0 }));
    await vi.waitFor(() => expect(activeIndex()).toBe('0'));
  });
});
