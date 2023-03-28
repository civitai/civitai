import { useMemo } from 'react';
import { trpc } from '~/utils/trpc';

type Props = {
  postId?: number;
  modelId?: number;
  modelVersionId?: number;
  username?: string;
  limit?: number;
  prioritizedUserIds?: number[];
} & Record<string, unknown>;

export function useInfiniteImagesQuery({
  postId,
  modelId,
  modelVersionId,
  username,
  limit,
  prioritizedUserIds,
  ...rest
}: Props) {
  const filters = useMemo(() => ({}), []);

  return trpc.image.getInfinite.useInfiniteQuery(filters);
}
