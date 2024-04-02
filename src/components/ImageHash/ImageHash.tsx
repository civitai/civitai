import { CSSProperties } from 'react';
import { BlurhashCanvas } from 'react-blurhash';
import { getClampedSize } from '~/utils/blurhash';

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
      className={className}
      style={{
        width: '100%',
        height: '100%',
        position: 'absolute',
        top: 0,
        left: 0,
        objectFit: 'cover',
        objectPosition: cropFocus ?? 'center',
        ...style,
      }}
    />
  );
}

export function MediaHash2() {
  return <></>;
}
