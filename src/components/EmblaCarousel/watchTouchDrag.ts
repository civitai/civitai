import type { EmblaCarouselType } from 'embla-carousel';

/**
 * Touch and pen drags navigate; mouse drags don't, so click-dragging an image on
 * desktop still opens it rather than being eaten as a swipe. At module scope so
 * the body is identical every render — embla compares function options by source
 * string, and a fresh closure per render would reinitialize the carousel.
 */
export function watchTouchDrag(
  _emblaApi: EmblaCarouselType,
  event: TouchEvent | MouseEvent | PointerEvent
) {
  // embla binds touchstart/mousedown today; the pointerType branch keeps this
  // correct if it ever moves to pointer events
  if ('pointerType' in event) return event.pointerType !== 'mouse';
  return event.type.startsWith('touch');
}
