import { HoverCard, Badge } from '@mantine/core';
import { IconStarFilled } from '@tabler/icons-react';
import clsx from 'clsx';

import classes from './LevelProgress.module.scss';
import { numberWithCommas } from '~/utils/number-helpers';

export function LevelProgress({
  level,
  progress,
  total,
  currentExp,
  nextLevelExp,
  icon,
  className,
}: Props) {
  return (
    <HoverCard position="bottom" withArrow withinPortal>
      <HoverCard.Target>
        <Badge size="lg" className={clsx(classes.raterBadge, className)}>
          {icon ?? <IconStarFilled strokeWidth={2.5} size={15} />}
          Level {level}
          <div style={{ width: progress + '%' }} />
        </Badge>
      </HoverCard.Target>
      <HoverCard.Dropdown px="xs" py={3} color="gray">
        <div className="flex flex-col">
          <div className="flex flex-nowrap gap-1">
            <p className="text-xs font-bold uppercase text-blue-4">Next level</p>
            <p className="text-xs font-medium">
              {numberWithCommas(currentExp)} / {numberWithCommas(nextLevelExp)}
            </p>
          </div>
          <div className="flex flex-nowrap gap-1">
            <p className="text-xs font-bold uppercase text-blue-4">Total exp</p>
            <p className="text-xs font-medium">{numberWithCommas(total)}</p>
          </div>
        </div>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

type Props = {
  level: number;
  progress: number;
  currentExp: number;
  nextLevelExp: number;
  total: number;
  icon?: React.ReactNode;
  className?: string;
};
