import type { BadgeProps } from '@mantine/core';
import { Badge } from '@mantine/core';
import {
  browsingLevelLabels,
  getIsSafeBrowsingLevel,
  nsfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { NsfwLevel } from '~/server/common/enums';
import clsx from 'clsx';
import classes from './BrowsingLevelBadge.module.css';

export function BrowsingLevelBadge({
  browsingLevel,
  className,
  sfwClassName,
  nsfwClassName,
  ...badgeProps
}: {
  browsingLevel?: number;
} & BadgeProps & { onClick?: () => void; sfwClassName?: string; nsfwClassName?: string }) {
  const nsfw = Flags.hasFlag(nsfwBrowsingLevelsFlag, browsingLevel ?? NsfwLevel.XXX);

  const badgeClass = clsx(className, {
    [sfwClassName ? sfwClassName : '']: !nsfw,
    [nsfwClassName ? nsfwClassName : '']: nsfw,
  });

  return (
    <Badge
      classNames={{ root: getBrowsingLevelClass(classes.root, browsingLevel) }}
      className={badgeClass}
      {...badgeProps}
    >
      {browsingLevelLabels[browsingLevel as NsfwLevel] ?? '?'}
    </Badge>
  );
}

function getBrowsingLevelClass(className?: string, browsingLevel?: number) {
  return clsx(className, { [classes.red]: !getIsSafeBrowsingLevel(browsingLevel ?? 0) });
}
