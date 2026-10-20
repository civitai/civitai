import { Skeleton } from '@mantine/core';
import clsx from 'clsx';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { StorylineThumbImage } from '~/components/Storyline/StorylineThumb';

/**
 * The page's wide banner. `backdrop` blurs the art instead of cropping it: without a picked banner
 * the art is a portrait, which a wide crop turns into a torso.
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
                  // EdgeImage caps its width at the requested size; the hero fills the page width.
                  style={{ objectPosition: `center ${position}%`, maxWidth: 'none' }}
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
