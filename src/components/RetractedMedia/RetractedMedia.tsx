import { useState } from 'react';

/** A blocked image or video for a moderator, from `src` (`retractedMediaUrl`), never the CDN. A file
 *  the route will not serve is described instead. */
export function RetractedMedia({
  src,
  type,
  alt,
  className,
  controls = false,
}: {
  src: string;
  type: string;
  alt?: string;
  className?: string;
  controls?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <div className="text-dimmed flex size-full items-center justify-center p-4 text-center text-xs">
        Not viewable here
      </div>
    );
  if (type === 'video')
    return (
      <video
        src={src}
        className={className}
        muted
        playsInline
        controls={controls}
        preload="metadata"
        onError={() => setFailed(true)}
      />
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element -- same-origin route, not an optimisable asset
    <img
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      decoding="async"
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
