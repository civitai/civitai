import type { CSSProperties } from 'react';
import { BlurhashCanvas } from 'react-blurhash';
import { getClampedSize } from '~/utils/blurhash';
import clsx from 'clsx';

export type MediaHashProps = {
  hash?: string | null;
  width?: number | null;
  height?: number | null;
  style?: CSSProperties;
  cropFocus?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  className?: string;
};

export function MediaHash({ hash, height, width, style, cropFocus, className }: MediaHashProps) {
  if (!hash || !width || !height) return null;

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
