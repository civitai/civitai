import { IconHierarchy } from '@tabler/icons-react';
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
      {isRemix && <IconHierarchy size={18} />}
    </div>
  );
}
