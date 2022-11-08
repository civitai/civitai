import { BlurhashCanvas } from 'react-blurhash';
import { getClampedSize } from '~/utils/blurhash';

export type MediaHashProps = {
  hash?: string | null;
  width?: number | null;
  height?: number | null;
};

export function MediaHash({ hash, height, width }: MediaHashProps) {
  if (!hash || !width || !height) return null;

  const size = getClampedSize(width, height, 32);

  return (
    <BlurhashCanvas
      hash={hash}
      height={size.height}
      width={size.width}
      style={{
        width: '100%',
        height: '100%',
        position: 'absolute',
        top: 0,
        left: 0,
        objectFit: 'cover',
        objectPosition: 'center',
      }}
    />
  );
}
