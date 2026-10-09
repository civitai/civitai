import type { BadgeProps } from '@mantine/core';
import { Badge } from '@mantine/core';
import clsx from 'clsx';
import {
  browsingLevelLabels,
  nsfwLevelColors,
  parseBitwiseBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';
import { getContentLevelRange } from '~/utils/crucible-helpers';

type Props = {
  nsfwLevel: number;
  /** One range badge ("PG–XXX") instead of one per level, when the levels run unbroken. */
  compact?: boolean;
  className?: string;
} & Omit<BadgeProps, 'color' | 'children'>;

export function CrucibleContentLevelBadges({
  nsfwLevel,
  compact,
  className,
  size = 'sm',
  variant = 'filled',
  ...badgeProps
}: Props) {
  const range = compact ? getContentLevelRange(nsfwLevel) : null;
  if (range)
    return (
      <div className={clsx('flex flex-wrap gap-1', className)}>
        <Badge color={nsfwLevelColors[range.level]} variant={variant} size={size} {...badgeProps}>
          {range.label}
        </Badge>
      </div>
    );

  const levels = parseBitwiseBrowsingLevel(nsfwLevel).filter((level) => level in nsfwLevelColors);
  if (!levels.length) return null;

  return (
    <div className={clsx('flex flex-wrap gap-1', className)}>
      {levels.map((level) => (
        <Badge
          key={level}
          color={nsfwLevelColors[level]}
          variant={variant}
          size={size}
          {...badgeProps}
        >
          {browsingLevelLabels[level as keyof typeof browsingLevelLabels]}
        </Badge>
      ))}
    </div>
  );
}
