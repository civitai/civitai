import type { MantineColor, MantineNumberSize } from '@mantine/core';
import styles from './Burger.module.scss';
import clsx from 'clsx';

export interface BurgerStylesParams {
  size: MantineSize | number;
  color?: MantineColor;
  transitionDuration: number;
}

export interface BurgerProps {
  opened: boolean;
  className?: string;
}

export function Burger({ opened, className }: BurgerProps) {
  return (
    <div className={clsx(styles.root, className)}>
      <div data-opened={opened || undefined} className={styles.burger} />
    </div>
  );
}
