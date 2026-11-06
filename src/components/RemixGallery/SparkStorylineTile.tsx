import { useReducedMotion } from '@mantine/hooks';
import { IconBook2, IconEyeOff } from '@tabler/icons-react';
import clsx from 'clsx';
import { useRouter } from 'next/router';
import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import type { SparkStorylineCardEntry } from '~/server/services/remix-gallery.service';
import { Flags } from '~/shared/utils/flags';

/** How long each chapter image shows before the tile pages to the next. */
export const SPARK_TILE_PAGE_MS = 1200;

/**
 * A storyline started from the host image: a book badge over its chapter images, paging through
 * them while `paging` is on, opening the story on click.
 *
 * A blurred preview is a placeholder, never a blurred image, for the reason the remix tile gives:
 * a hover preview has no reveal gesture. Paging stops for a viewer who asked for reduced motion.
 */
export function SparkStorylineTile({
  entry,
  blurLevels,
  paging,
  className,
  style,
  onOpen,
}: {
  entry: SparkStorylineCardEntry;
  blurLevels: number;
  paging: boolean;
  className?: string;
  style?: CSSProperties;
  onOpen?: () => void;
}) {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [index, setIndex] = useState(0);
  const pages = entry.previews.length;

  useEffect(() => {
    if (!paging || reduceMotion || pages < 2) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % pages), SPARK_TILE_PAGE_MS);
    return () => clearInterval(timer);
  }, [paging, reduceMotion, pages]);

  const preview = entry.previews[index % Math.max(1, pages)];
  const blurred = !preview || Flags.hasFlag(blurLevels, preview.nsfwLevel);
  const label = entry.username
    ? `Open ${entry.username}'s story "${entry.title}"`
    : `Open the story "${entry.title}"`;

  return (
    <button
      className={clsx('relative', className)}
      style={style}
      aria-label={label}
      title={entry.title}
      data-preview-index={index % Math.max(1, pages)}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen?.();
        void router.push(storylineUrl(entry.storylineId));
      }}
    >
      {blurred ? (
        <div className="flex aspect-square w-full items-center justify-center rounded bg-gray-3 ring-1 ring-gray-3 dark:bg-dark-5 dark:ring-dark-4">
          <IconEyeOff size={16} className="text-gray-6 dark:text-dark-2" />
        </div>
      ) : (
        <EdgeMedia
          src={preview.url}
          type={preview.type}
          width={128}
          className="aspect-square w-full rounded object-cover ring-1 ring-gray-3 transition hover:opacity-80 dark:ring-dark-4"
        />
      )}
      <span
        className="absolute bottom-0.5 left-0.5 flex items-center justify-center rounded bg-dark-9/75 p-0.5 text-white"
        data-testid="storyline-badge"
        aria-hidden
      >
        <IconBook2 size={12} stroke={2} />
      </span>
    </button>
  );
}
