import { IconHierarchy, IconSitemap } from '@tabler/icons-react';
import clsx from 'clsx';

import styles from './OnsiteIndicatore.module.scss';

export function OnsiteIndicator({ isRemix }: { isRemix?: boolean }) {
  return (
    <div
      className={clsx(styles.indicator, {
        [styles.remix]: isRemix,
      })}
      title={isRemix ? 'Remixed from another image' : 'Created on Civitai'}
    >
      {!isRemix && <IconSitemap size={14} strokeWidth={2} />}
      {isRemix && <IconHierarchy size={14} strokeWidth={2} />}
    </div>
  );
}
