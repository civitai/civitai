import { useCallback, useEffect, useState } from 'react';

type Props = {
  orientation?: 'horizontal' | 'vertical';
  resizePosition?: 'left' | 'right' | 'top' | 'bottom';
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
};

const clientRectDict = {
  left: 'right',
  right: 'left',
  top: 'bottom',
  bottom: 'top',
} as const;

export const useResize = (options?: Props) => {
  const {
    orientation = 'horizontal',
    resizePosition,
    minWidth,
    maxWidth,
    defaultWidth,
  } = options ?? {};
  const [ref, setRef] = useState<HTMLElement | null>(null);
  const [resizerRef, setResizerRef] = useState<HTMLElement | null>(null);
  const [contentRef, setContentRef] = useState<HTMLElement | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(defaultWidth);

  const mouseMoveClient = orientation === 'horizontal' ? 'clientX' : 'clientY';

  const startResizing = useCallback(() => {
    setIsResizing(true);
  }, []);

  const stopResizing = useCallback(() => {
    setIsResizing(false);
  }, []);

  const resize = useCallback(
    (mouseMoveEvent: MouseEvent) => {
      if (isResizing && ref) {
        setSidebarWidth(() => {
          const clientPosition = mouseMoveEvent[mouseMoveClient];
          const width = resizePosition
            ? clientPosition - ref.getBoundingClientRect()[clientRectDict[resizePosition]]
            : clientPosition;
          if (minWidth && width < minWidth) return minWidth;
          if (maxWidth && width > maxWidth) return maxWidth;
          return width;
        });
      }
    },
    [isResizing] // eslint-disable-line
  );

  useEffect(() => {
    if (ref) ref.style.width = `${sidebarWidth}px`;
    if (contentRef) contentRef.style.overflowX = 'auto';
  }, [sidebarWidth, ref, contentRef]);

  // useEffect(() => {
  //   if (resizerRef) {
  //     resizerRef.addEventListener('click', startResizing);
  //   }
  //   return () => resizerRef?.removeEventListener('click', startResizing);
  // }, [resizerRef, startResizing]);

  useEffect(() => {
    const handleContainerClick = (e: MouseEvent) => e.preventDefault();
    window.addEventListener('mousemove', resize);
    window.addEventListener('mouseup', stopResizing);
    resizerRef?.addEventListener('mousedown', startResizing);
    ref?.addEventListener('mousedown', handleContainerClick);
    return () => {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stopResizing);
      resizerRef?.removeEventListener('mousedown', startResizing);
      ref?.removeEventListener('mousedown', handleContainerClick);
    };
  }, [resize, stopResizing, resizerRef, ref, startResizing]);

  return {
    containerRef: setRef,
    resizerRef: setResizerRef,
    contentRef: setContentRef,
  };
};
