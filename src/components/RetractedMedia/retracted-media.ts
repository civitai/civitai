import { useCallback, useMemo, useState } from 'react';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

type RetractableImage = { id: number; ingestion?: string | null };
type Viewer = { isModerator?: boolean } | null | undefined;

/**
 * Where a moderator's browser loads an image from: `/api/mod/retracted-media`, for a blocked image,
 * whose url the public CDN stops serving, and for a scanned one once the CDN has refused it
 * (`cdnFailed`), as after a moderator unpublishes someone else's post. `null` for everyone else and
 * every other image, who keep the CDN.
 */
export function retractedMediaUrl(
  image: RetractableImage,
  user: Viewer,
  { cdnFailed = false } = {}
): string | null {
  if (!user?.isModerator) return null;
  const blocked = image.ingestion === ImageIngestionStatus.Blocked;
  if (!blocked && !(cdnFailed && image.ingestion === ImageIngestionStatus.Scanned)) return null;
  return `/api/mod/retracted-media/${image.id}`;
}

/**
 * `mediaRef` catches an image that failed before hydration attached `onCdnError`, since that
 * error event is never replayed.
 * The failure is kept per id, so a tile reused for another image starts on the CDN again.
 */
export function useRetractedMedia(image: RetractableImage, user: Viewer) {
  const { id } = image;
  const [failedId, setFailedId] = useState<number | null>(null);
  const src = retractedMediaUrl(image, user, { cdnFailed: failedId === id });
  const fallback = !!retractedMediaUrl(image, user, { cdnFailed: true });

  // A video reports each failed `<source>`, and only the last one means nothing played.
  const onCdnError = useCallback(
    (event: { target: EventTarget | null }) => {
      const target = event.target;
      if (target instanceof HTMLSourceElement && target.nextElementSibling) return;
      setFailedId(id);
    },
    [id]
  );
  const mediaRef = useMemo(
    (): [HTMLImageElement | null, (img: HTMLImageElement | null) => void] => [
      null,
      (img) => {
        if (img?.complete && img.naturalWidth === 0) setFailedId(id);
      },
    ],
    [id]
  );
  return {
    src,
    onCdnError: fallback ? onCdnError : undefined,
    mediaRef: fallback ? mediaRef : undefined,
  };
}
