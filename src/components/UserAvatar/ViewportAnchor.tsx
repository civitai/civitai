import { forwardRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * A zero-chrome box for a Popover to anchor to, positioned from viewport coordinates.
 *
 * Portaled so `fixed` is measured from the viewport: left in place, a transformed ancestor
 * (a virtualized row, a transformed scroller) re-bases it and the card lands as
 * far from its trigger as that ancestor is scrolled. `Popover.Target` clones its child, so the
 * portal has to sit behind a component that forwards the props and ref it injects.
 */
export const ViewportAnchor = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function ViewportAnchor({ style, ...props }, ref) {
    return createPortal(
      <div ref={ref} {...props} style={{ ...style, position: 'fixed', pointerEvents: 'none' }} />,
      document.body
    );
  }
);
