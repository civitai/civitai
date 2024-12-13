import { useMemo } from 'react';
import { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import clsx from 'clsx';
import styles from './CosmeticLights.module.scss';

type Props = {
  cosmetic?: ContentDecorationCosmetic['data'] | null;
};

export function CosmeticLights({ cosmetic }: Props) {
  const { brightness, color, lights } = { brightness: 1, color: 'yellow', lights: 12 }; // For testing purposes
  // const { lights, color, brightness } = frameDecoration?.data ?? {};
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
