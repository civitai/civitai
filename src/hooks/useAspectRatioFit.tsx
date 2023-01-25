import { useDebouncedState, useWindowEvent } from '@mantine/hooks';
import { useRef } from 'react';

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

export function useAspectRatioFit<TElement extends HTMLElement = HTMLDivElement>(srcDimensions: {
  width: number;
  height: number;
}) {
  const containerRef = useRef<TElement>(null);
  const container = {
    width: containerRef.current?.clientWidth ?? 0,
    height: containerRef.current?.clientHeight ?? 0,
  };

  const aspectRatio = calculateAspectRatioFit(
    srcDimensions.width,
    srcDimensions.height,
    container.width,
    container.height
  );

  const [resized, setResized] = useDebouncedState(0, 200);
  const handleResize = () => setResized(resized + 1); // use this to reset component
  useWindowEvent('resize', handleResize);

  return { ref: containerRef, ...aspectRatio };
}
