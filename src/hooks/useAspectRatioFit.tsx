import { useDebouncedState, useWindowEvent } from '@mantine/hooks';
import { useCallback, useEffect, useState } from 'react';

/**
 * Conserve aspect ratio of the original region. Useful when shrinking/enlarging
 * images to fit into a certain area.
 *
 * @param {Number} srcWidth width of source image
 * @param {Number} srcHeight height of source image
 * @param {Number} maxWidth maximum available width
 * @param {Number} maxHeight maximum available height
 * @return {Object} { width, height }
 */
function calculateAspectRatioFit(
  srcWidth: number,
  srcHeight: number,
  maxWidth: number,
  maxHeight: number
) {
  if (srcWidth > maxWidth || srcHeight > maxHeight) {
    const ratio = Math.min(maxWidth / srcWidth, maxHeight / srcHeight);

    return { width: srcWidth * ratio, height: srcHeight * ratio };
  } else {
    return { width: srcWidth, height: srcHeight };
  }
}

export function useAspectRatioFit<TElement extends HTMLElement = HTMLDivElement>({
  width,
  height,
}: {
  width: number;
  height: number;
}) {
  const [ref, setRef] = useState<TElement | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  // const containerRef = useRef<TElement>(null);

  // const container = {
  //   width: ref?.current?.clientWidth ?? 0,
  //   height: ref?.current?.clientHeight ?? 0,
  // };

  const handleSetDimensions = useCallback(() => {
    setDimensions(
      calculateAspectRatioFit(width, height, ref?.clientWidth ?? 0, ref?.clientHeight ?? 0)
    );
  }, [ref, width, height]);

  useEffect(() => {
    if (ref) handleSetDimensions();
  }, [ref, handleSetDimensions]);

  const [resized, setResized] = useDebouncedState(0, 200);
  const handleResize = () => setResized(resized + 1); // use this to reset component
  useWindowEvent('resize', handleResize);

  useEffect(() => {
    if (resized !== 0) {
      handleSetDimensions();
    }
  }, [resized, handleSetDimensions]);

  return { setRef, ...dimensions };
}
