import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

type HatLayerState = {
  layer: HTMLElement | null;
  /** A carousel inside is moving its slides, so a hat drawn here would be left behind. */
  moving: boolean;
  setMoving: (moving: boolean) => void;
};

const HatLayerContext = createContext<HatLayerState | null>(null);

/** The layer a worn hat is drawn into, if an ancestor provides one. */
export const useHatLayer = () => useContext(HatLayerContext);

/**
 * An unclipped layer over the nearest positioned ancestor, for hats whose card sits inside a
 * clipping container (a carousel viewport, a rounded `overflow-hidden` card). Put it OUTSIDE the
 * element that clips. Hats under it draw into the layer instead of beside their card, so they
 * hang past the card's corner as in the feed. The room past the layer's edge is the container's
 * `--event-decoration-allowance`, as everywhere else.
 */
export function HatLayerHost({ children }: { children: ReactNode }) {
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [moving, setMoving] = useState(false);
  const value = useMemo(() => ({ layer, moving, setMoving }), [layer, moving]);
  return (
    <HatLayerContext.Provider value={value}>
      {children}
      <div
        ref={setLayer}
        data-testid="hat-layer"
        className="pointer-events-none absolute inset-0 isolate z-[2] [--event-decoration-grow:1]"
      />
    </HatLayerContext.Provider>
  );
}

type Box = { left: number; top: number; width: number; height: number };

/**
 * Draws `children` into the hat layer over the card this is placed in (a positioned parent), at
 * the card's size. Nothing is drawn while the layer's carousel moves, or for a card whose corner
 * or middle is outside the layer (a slide out of view).
 */
export function LayeredHat({
  layer,
  hidden,
  children,
}: {
  layer: HTMLElement;
  hidden: boolean;
  children: (box: Box) => ReactNode;
}) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [box, setBox] = useState<Box | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || hidden) {
      setBox(null);
      return;
    }
    const measure = () => {
      const at = host.getBoundingClientRect();
      const around = layer.getBoundingClientRect();
      // Its corner is in view and most of it: a slide peeking in from the side wears no hat yet.
      const inView =
        at.left >= around.left - 1 &&
        at.left + at.width / 2 < around.right &&
        at.top < around.bottom;
      const next = inView
        ? {
            left: at.left - around.left,
            top: at.top - around.top,
            width: at.width,
            height: at.height,
          }
        : null;
      setBox((current) =>
        current === next ||
        (current &&
          next &&
          current.left === next.left &&
          current.top === next.top &&
          current.width === next.width &&
          current.height === next.height)
          ? current
          : next
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    observer.observe(host);
    return () => observer.disconnect();
  }, [layer, hidden]);

  return (
    <>
      <span ref={hostRef} aria-hidden className="pointer-events-none absolute inset-0" />
      {box &&
        createPortal(
          <div className="pointer-events-none absolute" style={box}>
            {children(box)}
          </div>,
          layer
        )}
    </>
  );
}
