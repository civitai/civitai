import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

type HatLayerState = {
  layer: HTMLElement | null;
  /** A carousel inside is moving its slides, so a hat drawn here would be left behind. */
  moving: boolean;
  setMoving: (moving: boolean) => void;
  /** Bumped when the carousel re-initialises: its slides moved without a resize, so hats re-measure. */
  version: number;
  remeasure: () => void;
};

const HatLayerContext = createContext<HatLayerState | null>(null);

/** The layer a worn hat is drawn into, if an ancestor provides one. */
export const useHatLayer = () => useContext(HatLayerContext);

/**
 * An unclipped layer over the nearest positioned ancestor that worn hats draw into. Put it
 * OUTSIDE the element that clips, or the hats are clipped with it.
 */
export function HatLayerHost({ children }: { children: ReactNode }) {
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [moving, setMoving] = useState(false);
  const [version, setVersion] = useState(0);
  const value = useMemo(
    () => ({ layer, moving, setMoving, version, remeasure: () => setVersion((v) => v + 1) }),
    [layer, moving, version]
  );
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
 * Draws children into the hat layer at the size of the positioned parent this sits in. Kept
 * separate from DrawnMediaHat, which measures the letterboxed picture and sizes its own room.
 */
export function LayeredHat({
  layer,
  hidden,
  version,
  children,
}: {
  layer: HTMLElement;
  hidden: boolean;
  version: number;
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
      // A slide peeking in from the side wears no hat until its middle is in view.
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
  }, [layer, hidden, version]);

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
