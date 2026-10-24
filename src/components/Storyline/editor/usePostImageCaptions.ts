import { useMemo } from 'react';
import { useStorylinesEnabled } from '~/components/Storyline/storyline.queries';
import { trpc } from '~/utils/trpc';

/** The captions the author has saved on this post's images, by image id. */
export function usePostImageCaptions(postId: number) {
  const enabled = useStorylinesEnabled() && postId > 0;
  const { data, isLoading } = trpc.storyline.getPostImageCaptions.useQuery({ postId }, { enabled });
  const captions = useMemo(
    () => new Map((data ?? []).map(({ imageId, content }) => [imageId, content])),
    [data]
  );
  return { captions, isLoading: enabled && isLoading };
}
