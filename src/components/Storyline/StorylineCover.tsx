import { Skeleton } from '@mantine/core';
import clsx from 'clsx';
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
 * A picked banner shows sharp at its focus (`position`, 0 to 100). Without one the art is a
 * portrait, which a wide crop turns into a torso, so it shows as a blurred backdrop instead and
 * the sharp picture is the card cover beside it.
 */
export function StorylineHero({
  image,
  position = 50,
  backdrop,
}: {
  image: StorylineThumbImage | null | undefined;
  position?: number;
  backdrop?: boolean;
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
                  width={backdrop ? 450 : 1600}
                  className={clsx(
                    'absolute inset-0 size-full object-cover',
                    backdrop && 'scale-[1.15] blur-[28px] saturate-[1.2]'
                  )}
                  style={{ objectPosition: `center ${position}%` }}
                  data-testid={backdrop ? 'storyline-hero-backdrop' : 'storyline-hero-image'}
                />
              ) : (
                <MediaHash {...image} className="absolute inset-0" />
              )
            }
          </ImageGuard2>
        )
      )}
      {backdrop && (
        <div className="pointer-events-none absolute inset-0 bg-[var(--mantine-color-body)] opacity-40" />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent from-35% to-[var(--mantine-color-body)]" />
    </div>
  );
}
