import { HoverCard, Badge } from '@mantine/core';
import { IconStarFilled } from '@tabler/icons-react';
import clsx from 'clsx';

import styles from './LevelProgress.module.scss';

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
    <HoverCard withArrow>
      <HoverCard.Target>
        <Badge size="lg" className={clsx(styles.raterBadge, className)}>
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
              {currentExp} / {nextLevelExp}
            </p>
          </div>
          {total ? (
            <div className="flex flex-nowrap gap-1">
              <p className="text-xs font-bold uppercase text-blue-4">Total ratings</p>
              <p className="text-xs font-medium">{total}</p>
            </div>
          ) : null}
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
  total?: number;
  icon?: React.ReactNode;
  className?: string;
};
