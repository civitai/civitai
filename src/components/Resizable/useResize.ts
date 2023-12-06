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
  const [isResizing, setIsResizing] = useState(false);
  const frame = useRef(0);

  useEffect(() => {
    if (!ref) return;
    const width = useResizeStore.getState()[name] ?? defaultWidth;
    frame.current = requestAnimationFrame(() => {
      ref.style.width = `${width}px`;
    });
  }, [name, ref]) // eslint-disable-line

  const mouseMoveClient = orientation === 'horizontal' ? 'clientX' : 'clientY';

  const startResizing = useCallback((e: MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const stopResizing = useCallback(() => {
    setIsResizing(false);
    if (frame.current) cancelAnimationFrame(frame.current);
  }, []);

  const resize = useCallback(
    (mouseMoveEvent: MouseEvent) => {
      if (isResizing && ref) {
        const getWidth = () => {
          const clientPosition = mouseMoveEvent[mouseMoveClient];
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
    [isResizing] // eslint-disable-line
  );

  useEffect(() => {
    window.addEventListener('mousemove', resize);
    window.addEventListener('mouseup', stopResizing);
    resizerRef?.addEventListener('mousedown', startResizing);
    return () => {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stopResizing);
      resizerRef?.removeEventListener('mousedown', startResizing);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [resize, stopResizing, resizerRef, ref, startResizing]);

  return {
    containerRef: setRef,
    resizerRef: setResizerRef,
  };
};
