import type { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import clsx from 'clsx';
import styles from './CosmeticLights.module.scss';

type Props = {
  cosmetic?: ContentDecorationCosmetic['data'] | null;
};

export function CosmeticLights({ cosmetic }: Props) {
  const { lights, color, brightness } = cosmetic ?? {};
  if (!lights) return null;

  const brightnessClass = brightness ? (`brightness${brightness * 100}` as const) : '';

  return (
    <div
      className={clsx(
        styles.light,
        color && styles[color as 'red' | 'green' | 'blue' | 'yellow'],
        brightnessClass &&
          brightnessClass in styles &&
          styles[brightnessClass as keyof typeof styles]
      )}
    >
      {Array(lights)
        .fill(0)
        .map((_, index) => (
          <span key={index}></span>
        ))}
    </div>
  );
}
