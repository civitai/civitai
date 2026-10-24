import type { EmblaCarouselType } from 'embla-carousel';
import type { DragEvent } from 'react';

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

/**
 * `watchTouchDrag` alone does not restore the native HTML5 drag: embla's
 * DragHandler.init binds `dragstart -> preventDefault()` on the viewport for as
 * long as `watchDrag` is truthy, and never consults `watchDrag` for that event —
 * only for mousedown/touchstart. Stopping dragstart in React's capture phase
 * keeps it from reaching that listener, so the drag survives. (embla-carousel 8.6.0)
 *
 * The stop lands on the native event at React's root container, so the dragged
 * element's own `onDragStart` never runs either — a caller that needs a payload
 * has to set it here, as `ImageDetailCarousel` does.
 */
export function allowNativeDragStart(event: DragEvent) {
  event.stopPropagation();
}
