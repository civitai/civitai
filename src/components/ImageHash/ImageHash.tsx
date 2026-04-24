import type { CSSProperties } from 'react';
import { BlurhashCanvas } from 'react-blurhash';
import { isBlurhashValid } from 'blurhash';
import { getClampedSize } from '~/utils/blurhash';
import clsx from 'clsx';

export type MediaHashProps = {
  /** Optional — used for diagnostic logging when the hash is malformed. */
  id?: number;
  hash?: string | null;
  width?: number | null;
  height?: number | null;
  style?: CSSProperties;
  cropFocus?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  className?: string;
};

export function MediaHash({
  id,
  hash,
  height,
  width,
  style,
  cropFocus,
  className,
}: MediaHashProps) {
  if (!hash || !width || !height) return null;

  // Guard against malformed blurhash data — BlurhashCanvas throws a
  // ValidationError during mount if the hash's encoded grid size doesn't match
  // the string length, which takes down the parent subtree.
  const validation = isBlurhashValid(hash);
  if (!validation.result) {
    console.warn(
      `[MediaHash] Invalid blurhash for image id=${id ?? '(unknown)'}: ${
        validation.errorReason ?? 'unknown reason'
      }`,
      { hash }
    );
    return null;
  }

  const size = getClampedSize(width, height, 32);
  if (!size.height) return null;

  return (
    <BlurhashCanvas
      hash={hash}
      height={size.height}
      width={size.width}
      className={clsx('absolute inset-0 size-full object-cover object-center', className)}
      style={{ objectPosition: cropFocus, ...style }}
    />
  );
}

export function MediaHash2() {
  return <></>;
}
