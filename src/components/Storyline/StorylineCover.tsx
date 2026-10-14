import { Skeleton } from '@mantine/core';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useQueryImages } from '~/components/Image/image.utils';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { StorylineThumbImage } from '~/components/Storyline/StorylineThumb';

/**
 * The first image of chapter 1, through the normal image read so the viewer's level applies.
 * `undefined` while it loads, `null` when there is none this viewer may see.
 */
export function useStorylineFirstImage(postId: number | null) {
  const { images, isLoading } = useQueryImages(
    { postId: postId ?? undefined, limit: 1, withMeta: false, include: [] },
    { enabled: !!postId }
  );
  if (!postId) return null;
  if (isLoading) return undefined;
  return (images[0] as StorylineThumbImage | undefined) ?? null;
}

/**
 * The page's wide banner, fading into the page at the bottom so the header card can sit over it.
 * The only wide crop of a storyline's art; `position` is the vertical focus, 0 to 100.
 */
export function StorylineHero({
  image,
  position = 35,
}: {
  image: StorylineThumbImage | null | undefined;
  position?: number;
}) {
  return (
    <div
      className="relative h-[220px] overflow-hidden bg-gray-1 sm:h-[340px] dark:bg-dark-6"
      data-testid="storyline-hero"
    >
      {image === undefined ? (
        <Skeleton className="absolute inset-0" radius={0} />
      ) : (
        image && (
          <ImageGuard2 image={image} explain={false}>
            {(safe) =>
              safe ? (
                <EdgeMedia
                  src={image.url}
                  type={image.type}
                  width={1600}
                  className="absolute inset-0 size-full object-cover"
                  style={{ objectPosition: `center ${position}%` }}
                />
              ) : (
                <MediaHash {...image} className="absolute inset-0" />
              )
            }
          </ImageGuard2>
        )
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent from-35% to-[var(--mantine-color-body)]" />
    </div>
  );
}
