import { MediaType } from '@prisma/client';
import { MAX_ANIMATION_DURATION_SECONDS } from '~/server/common/constants';
import { videoMetadataSchema } from '~/server/schema/media.schema';

export function shouldAnimateByDefault({
  type,
  metadata,
}: {
  type: MediaType;
  metadata?: MixedObject | null;
}) {
  const parsed = videoMetadataSchema.safeParse(metadata);
  if (!parsed.success) return undefined;

  const meta = parsed.data;

  if (type !== 'video' || !meta || !meta.duration) return undefined;

  return meta.duration <= MAX_ANIMATION_DURATION_SECONDS;
}

export const shouldDisplayHtmlControls = ({
  type,
  metadata,
}: {
  type: MediaType;
  metadata?: MixedObject | null;
}) => {
  const parsed = videoMetadataSchema.safeParse(metadata);
  if (!parsed.success) return false;

  const meta = parsed.data;

  if (type !== 'video' || !meta || !meta.duration) return false;

  return meta.duration > MAX_ANIMATION_DURATION_SECONDS;
};
