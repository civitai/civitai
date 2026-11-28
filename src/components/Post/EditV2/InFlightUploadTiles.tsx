import { Progress } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { TrackedFile } from '~/components/FileUpload/FileUploadProvider';
import { MEDIA_TYPE } from '~/shared/constants/mime-types';
import { uploadMimeType } from '~/utils/media-preprocessors';

/** Generator media not yet a File: it is still downloading, or being read for upload. */
export type PreparingMedia = { url: string; type?: 'image' | 'video' };

function useObjectUrl(file: File) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return url;
}

// Two picks can share a name and size; the File object is what tells them apart.
const fileKeys = new WeakMap<File, number>();
let nextFileKey = 0;
function keyOf(file: File) {
  let key = fileKeys.get(file);
  if (key === undefined) fileKeys.set(file, (key = nextFileKey++));
  return key;
}

const isVideo = (file: File) => MEDIA_TYPE[uploadMimeType(file)] === 'video';

const tileClass = 'relative aspect-square overflow-hidden rounded-md bg-gray-2 dark:bg-dark-6';

function TileMedia({ src, video, label }: { src: string; video: boolean; label: string }) {
  return video ? (
    // Still paints the first frame.
    <video
      src={src}
      preload="metadata"
      muted
      playsInline
      className="size-full object-cover"
      aria-label={label}
    />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={label} className="size-full object-cover" />
  );
}

function InFlightUploadTile({ tracked }: { tracked: TrackedFile }) {
  const { file, progress } = tracked;
  const src = useObjectUrl(file);
  return (
    <div className={tileClass}>
      {src && <TileMedia src={src} video={isVideo(file)} label={file.name} />}
      <Progress
        value={progress}
        animated
        size="sm"
        radius={0}
        className="absolute inset-x-0 bottom-0"
      />
    </div>
  );
}

function PreparingTile({ media }: { media: PreparingMedia }) {
  // The post button hands over a url without its type: try it as an image, then as a video.
  const [video, setVideo] = useState(media.type === 'video');
  return (
    <div className={tileClass}>
      {video ? (
        <TileMedia src={media.url} video label="Generated video" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={media.url}
          alt="Generated image"
          className="size-full object-cover"
          onError={media.type ? undefined : () => setVideo(true)}
        />
      )}
      <div className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-center text-xs text-white">
        Preparing…
      </div>
    </div>
  );
}

/**
 * A preview of each item still on its way to the post, until the post's own tile for it takes
 * over: generator media from its source url while it downloads and is read, then every file from a
 * local URL while it uploads.
 */
export function InFlightUploadTiles({
  files,
  preparing = [],
}: {
  files: TrackedFile[];
  preparing?: PreparingMedia[];
}) {
  const inFlight = files.filter((x) => x.status === 'pending' || x.status === 'uploading');
  if (!inFlight.length && !preparing.length) return null;
  return (
    <div className="grid grid-cols-4 gap-2 sm:grid-cols-6" aria-label="Uploading">
      {inFlight.map((tracked) => (
        <InFlightUploadTile key={keyOf(tracked.file)} tracked={tracked} />
      ))}
      {preparing.map((media, i) => (
        <PreparingTile key={`${i}-${media.url}`} media={media} />
      ))}
    </div>
  );
}
