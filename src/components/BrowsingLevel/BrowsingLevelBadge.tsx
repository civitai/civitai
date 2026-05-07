import type { BadgeProps } from '@mantine/core';
import { Badge } from '@mantine/core';
import {
  getBrowsingLevelLabel,
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
  // Use `intersects` instead of `hasFlag` so composite levels (e.g. comic
  // projects with `nsfwLevel = PG | R`) still flag as NSFW. `hasFlag` would
  // require every bit of the input to be in the NSFW mask — a sfw bit like
  // PG would short-circuit it to false even when an NSFW bit was also set.
  const nsfw = Flags.intersects(nsfwBrowsingLevelsFlag, browsingLevel ?? NsfwLevel.XXX);

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
      {getBrowsingLevelLabel(browsingLevel ?? 0)}
    </Badge>
  );
}

function getBrowsingLevelClass(className?: string, browsingLevel?: number) {
  return clsx(className, { [classes.red]: !getIsSafeBrowsingLevel(browsingLevel ?? 0) });
}
