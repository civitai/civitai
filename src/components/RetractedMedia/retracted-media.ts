import { useCallback, useState } from 'react';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * Where a moderator's browser loads an image from: `/api/mod/retracted-media`, for a blocked image,
 * whose url the public CDN stops serving, and for a scanned one once the CDN has refused it
 * (`cdnFailed`), as after a moderator unpublishes someone else's post. `null` for everyone else and
 * every other image, who keep the CDN.
 */
export function retractedMediaUrl(
  image: { id: number; ingestion?: string | null },
  user: { isModerator?: boolean } | null | undefined,
  { cdnFailed = false } = {}
): string | null {
  if (!user?.isModerator) return null;
  const blocked = image.ingestion === ImageIngestionStatus.Blocked;
  if (!blocked && !(cdnFailed && image.ingestion === ImageIngestionStatus.Scanned)) return null;
  return `/api/mod/retracted-media/${image.id}`;
}

/**
 * Whether the CDN failed to load image `id`, and the `onError` that records it. Per id, so a tile
 * reused for another image starts on the CDN again. A video reports each failed `<source>`, and only
 * the last one means nothing played.
 */
export function useCdnFailed(id: number) {
  const [failedId, setFailedId] = useState<number | null>(null);
  const onCdnError = useCallback(
    (event: { target: EventTarget | null }) => {
      const target = event.target;
      if (target instanceof HTMLSourceElement && target.nextElementSibling) return;
      setFailedId(id);
    },
    [id]
  );
  return [failedId === id, onCdnError] as const;
}
