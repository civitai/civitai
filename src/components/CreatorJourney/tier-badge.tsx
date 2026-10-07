import { IconLock } from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { SCORE_TIERS, scoreTierKey } from '~/shared/constants/creator-journey.constants';

export type BadgeState = 'earned' | 'next' | 'locked';

export const HEXAGON = 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)';
export const DEFAULT_ACCENT = '#f59f00';

export const tierAccents: Record<string, string> = Object.fromEntries(
  SCORE_TIERS.map((tier) => [scoreTierKey(tier.slug), tier.accent])
);

export const accentVar = (accent: string) => ({ '--cj-accent': accent } as CSSProperties);

export function TierBadge({
  name,
  badgeUrl,
  state,
  size,
  fluid,
  className,
}: {
  name: string;
  badgeUrl?: string | null;
  state: BadgeState;
  size: number;
  /** Shrink to the container's width, up to `size`. */
  fluid?: boolean;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        'relative flex shrink-0 items-center justify-center transition-all',
        state === 'locked' && 'opacity-40 grayscale',
        state === 'next' && 'opacity-80 grayscale-[60%]',
        className
      )}
      style={{
        ...(fluid
          ? { width: '100%', maxWidth: size, aspectRatio: '1' }
          : { width: size, height: size }),
        filter:
          state === 'earned'
            ? 'drop-shadow(0 4px 10px color-mix(in srgb, var(--cj-accent) 55%, transparent))'
            : undefined,
      }}
    >
      {badgeUrl ? (
        <EdgeMedia
          src={badgeUrl}
          alt={name}
          // The source art is ~144px; two request widths let the page share cached images.
          width={size <= 44 ? 88 : 144}
          className="size-full object-contain"
          optimized
        />
      ) : (
        <div
          className="flex size-full items-center justify-center bg-gray-3 font-bold text-gray-7 dark:bg-dark-4 dark:text-dark-0"
          style={{ clipPath: HEXAGON, fontSize: size * 0.32 }}
        >
          {name.slice(0, 1)}
        </div>
      )}
      {state !== 'earned' && size >= 40 && (
        <span
          className={clsx(
            'absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-gray-6 text-white dark:bg-dark-3',
            fluid ? 'size-4' : 'size-5'
          )}
        >
          <IconLock size={fluid ? 10 : 12} />
        </span>
      )}
    </div>
  );
}
