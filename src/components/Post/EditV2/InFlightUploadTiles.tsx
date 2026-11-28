import { Progress } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { TrackedFile } from '~/components/FileUpload/FileUploadProvider';
import { MEDIA_TYPE } from '~/shared/constants/mime-types';

/** A local URL for `file`, revoked when the file changes or the caller unmounts. */
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

// `preprocessFile` reads an untyped download as a video too.
const isVideo = (file: File) =>
  MEDIA_TYPE[file.type] === 'video' || file.type === 'application/octet-stream';

function InFlightUploadTile({ tracked }: { tracked: TrackedFile }) {
  const { file, progress } = tracked;
  const src = useObjectUrl(file);
  return (
    <div className="relative aspect-square overflow-hidden rounded-md bg-gray-2 dark:bg-dark-6">
      {src &&
        (isVideo(file) ? (
          // Metadata only: the browser paints the first frame without loading the whole video.
          <video
            src={src}
            preload="metadata"
            muted
            playsInline
            className="size-full object-cover"
            aria-label={file.name}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={file.name} className="size-full object-cover" />
        ))}
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

/**
 * A local preview of each file still on its way to the post, shown until the post's own tile for
 * it takes over. Without it, media imported from the generator, which downloads before it uploads,
 * shows nothing for minutes.
 */
export function InFlightUploadTiles({ files }: { files: TrackedFile[] }) {
  const inFlight = files.filter((x) => x.status === 'pending' || x.status === 'uploading');
  if (!inFlight.length) return null;
  return (
    <div className="grid grid-cols-4 gap-2 sm:grid-cols-6" aria-label="Uploading">
      {inFlight.map((tracked) => (
        <InFlightUploadTile key={keyOf(tracked.file)} tracked={tracked} />
      ))}
    </div>
  );
}
