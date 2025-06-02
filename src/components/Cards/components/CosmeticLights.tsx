import { useMemo } from 'react';
import type { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import clsx from 'clsx';
import styles from './CosmeticLights.module.scss';

type Props = {
  cosmetic?: ContentDecorationCosmetic['data'] | null;
};

export function CosmeticLights({ cosmetic }: Props) {
  const { lights, color, brightness } = cosmetic ?? {};
  if (!lights) return null;

  return (
    <div
      className={`${styles.light} ${
        !color ? '' : styles[color as 'red' | 'green' | 'blue' | 'yellow']
      } ${!brightness ? '' : styles['brightness-' + brightness * 100]}`}
    >
      {Array(lights)
        .fill(0)
        .map((_, index) => (
          <span key={index}></span>
        ))}
    </div>
  );
}
