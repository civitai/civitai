import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

type HatLayerState = {
  layer: HTMLElement | null;
  /**
   * A carousel inside moved its slides (`settled` once they stop). Hats read their slide's place
   * again on the spot, so they ride it frame by frame.
   */
  moved: (settled: boolean) => void;
  /** Called with each `moved`; returns the way to stop listening. */
  onMoved: (listener: (settled: boolean) => void) => () => void;
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
  const [version, setVersion] = useState(0);
  const listeners = useRef(new Set<(settled: boolean) => void>());
  const value = useMemo(
    () => ({
      layer,
      version,
      remeasure: () => setVersion((v) => v + 1),
      moved: (settled: boolean) => listeners.current.forEach((listener) => listener(settled)),
      onMoved: (listener: (settled: boolean) => void) => {
        listeners.current.add(listener);
        return () => void listeners.current.delete(listener);
      },
    }),
    [layer, version]
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
 * While a carousel inside moves, the hat's place is read on each of its frames and written straight
 * to its element, so it rides the slide instead of waiting for React.
 */
export function LayeredHat({
  layer,
  version,
  children,
}: {
  layer: HTMLElement;
  version: number;
  children: (box: Box) => ReactNode;
}) {
  const hat = useHatLayer();
  const onMoved = hat?.onMoved;
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<Box | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const read = (): Box | null => {
      const at = host.getBoundingClientRect();
      const around = layer.getBoundingClientRect();
      // A slide peeking in from the side wears no hat until its middle is in view.
      const inView =
        at.left >= around.left - 1 &&
        at.left + at.width / 2 < around.right &&
        at.top < around.bottom;
      return inView
        ? {
            left: at.left - around.left,
            top: at.top - around.top,
            width: at.width,
            height: at.height,
          }
        : null;
    };
    const measure = () => {
      const next = read();
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
    const stopListening = onMoved?.((settled) => {
      const next = read();
      const el = boxRef.current;
      if (next && el) {
        el.style.left = `${next.left}px`;
        el.style.top = `${next.top}px`;
      }
      // Mounts or unmounts the hat as its slide enters or leaves the view, and brings React's
      // copy of the place up to date once the slide stops.
      if (settled || !!next !== !!el) measure();
    });
    return () => {
      stopListening?.();
      observer.disconnect();
    };
  }, [layer, version, onMoved]);

  return (
    <>
      <span ref={hostRef} aria-hidden className="pointer-events-none absolute inset-0" />
      {box &&
        createPortal(
          <div ref={boxRef} className="pointer-events-none absolute" style={box}>
            {children(box)}
          </div>,
          layer
        )}
    </>
  );
}
