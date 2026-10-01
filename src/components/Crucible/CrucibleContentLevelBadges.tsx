import type { BadgeProps } from '@mantine/core';
import { Badge } from '@mantine/core';
import clsx from 'clsx';
import {
  browsingLevelLabels,
  nsfwLevelColors,
  parseBitwiseBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';

type Props = {
  nsfwLevel: number;
  className?: string;
} & Omit<BadgeProps, 'color' | 'children'>;

export function CrucibleContentLevelBadges({
  nsfwLevel,
  className,
  size = 'sm',
  variant = 'filled',
  ...badgeProps
}: Props) {
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
