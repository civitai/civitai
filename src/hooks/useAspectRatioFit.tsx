import { useWindowEvent } from '@mantine/hooks';
import { useEffect, useRef, useState } from 'react';
import { useDebouncer } from '~/utils/debouncer';

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
export function calculateAspectRatioFit(
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
  const ref = useRef<TElement | null>(null);
  const debouncer = useDebouncer(200);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>(getDimensions());

  function getDimensions() {
    return calculateAspectRatioFit(
      width,
      height,
      ref.current?.clientWidth ?? 0,
      ref.current?.clientHeight ?? 0
    );
  }

  function handleResize() {
    debouncer(() => setDimensions(getDimensions()));
  }

  useWindowEvent('resize', handleResize);
  useEffect(() => setDimensions(getDimensions()), []);

  return { setRef: ref, ...dimensions };
}

export function useAspectRatioFit2<TElement extends HTMLElement = HTMLDivElement>({
  width,
  height,
}: {
  width: number;
  height: number;
}) {
  const ref = useRef<TElement | null>(null);
  const debouncer = useDebouncer(200);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>(getDimensions());

  function getDimensions() {
    return calculateAspectRatioFit(
      width,
      height,
      ref.current?.clientWidth ?? 0,
      ref.current?.clientHeight ?? 0
    );
  }

  function handleResize() {
    debouncer(() => setDimensions(getDimensions()));
  }

  useWindowEvent('resize', handleResize);
  useEffect(() => setDimensions(getDimensions()), []);

  return { setRef: ref, ...dimensions };
}
