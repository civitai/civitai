import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Props = {
  orientation?: 'horizontal' | 'vertical';
  resizePosition?: 'left' | 'right' | 'top' | 'bottom';
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
  name: string;
};

const clientRectDict = {
  left: 'right',
  right: 'left',
  top: 'bottom',
  bottom: 'top',
} as const;

export const useResizeStore = create<Record<string, number>>()(
  persist(() => ({}), { name: 'resizable' })
);

export const useResize = (options: Props) => {
  const {
    orientation = 'horizontal',
    resizePosition,
    minWidth,
    maxWidth,
    defaultWidth,
    name,
  } = options ?? {};
  const [ref, setRef] = useState<HTMLElement | null>(null);
  const [resizerRef, setResizerRef] = useState<HTMLElement | null>(null);
  const isResizing = useRef(false);
  const frame = useRef(0);

  useEffect(() => {
    if (!ref) return;
    const width = useResizeStore.getState()[name] ?? defaultWidth;
    frame.current = requestAnimationFrame(() => {
      ref.style.width = `${width}px`;
    });
  }, [name, ref]); // eslint-disable-line

  const mouseMoveClient = orientation === 'horizontal' ? 'clientX' : 'clientY';

  const startResizing = useCallback((e: MouseEvent | TouchEvent) => {
    e.preventDefault();
    isResizing.current = true;
  }, []);

  const stopResizing = useCallback(() => {
    isResizing.current = false;
    if (frame.current) cancelAnimationFrame(frame.current);
  }, []);

  const getClientPosition = (e: MouseEvent | TouchEvent) => {
    if ('touches' in e) {
      return orientation === 'horizontal' ? e.touches[0].clientX : e.touches[0].clientY;
    }
    return e[mouseMoveClient];
  };

  const resize = useCallback(
    (moveEvent: MouseEvent | TouchEvent) => {
      if (isResizing.current && ref) {
        const getWidth = () => {
          const clientPosition = getClientPosition(moveEvent);
          const width = resizePosition
            ? clientPosition - ref.getBoundingClientRect()[clientRectDict[resizePosition]]
            : clientPosition;

          if (minWidth && width < minWidth) return minWidth;
          if (maxWidth && width > maxWidth) return maxWidth;

          return width;
        };
        const width = getWidth();
        useResizeStore.setState(() => ({ [name]: width }));
        frame.current = requestAnimationFrame(() => {
          ref.style.width = `${width}px`;
        });
      }
    },
    [ref, mouseMoveClient, resizePosition, minWidth, maxWidth, name] // eslint-disable-line
  );

  useEffect(() => {
    window.addEventListener('mousemove', resize);
    window.addEventListener('mouseup', stopResizing);
    window.addEventListener('touchmove', resize, { passive: false });
    window.addEventListener('touchend', stopResizing);
    resizerRef?.addEventListener('mousedown', startResizing);
    resizerRef?.addEventListener('touchstart', startResizing, { passive: false });
    return () => {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stopResizing);
      window.removeEventListener('touchmove', resize);
      window.removeEventListener('touchend', stopResizing);
      resizerRef?.removeEventListener('mousedown', startResizing);
      resizerRef?.removeEventListener('touchstart', startResizing);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [resize, stopResizing, resizerRef, ref, startResizing]);

  return {
    containerRef: setRef,
    resizerRef: setResizerRef,
  };
};
