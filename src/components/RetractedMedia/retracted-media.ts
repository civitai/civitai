import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * Where a moderator's browser loads a blocked image from: `/api/mod/retracted-media`, since the
 * public CDN stops serving a blocked image's url. `null` for everyone else and every other image, who
 * keep the CDN.
 */
export function retractedMediaUrl(
  image: { id: number; ingestion?: string | null },
  user: { isModerator?: boolean } | null | undefined
): string | null {
  if (!user?.isModerator || image.ingestion !== ImageIngestionStatus.Blocked) return null;
  return `/api/mod/retracted-media/${image.id}`;
}
