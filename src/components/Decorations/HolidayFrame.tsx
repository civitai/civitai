import { Lightbulb } from './Lightbulb';
import { useLocalStorage } from '@mantine/hooks';
import { UserWithCosmetics } from '~/server/selectors/user.selector';
import styles from './HolidayFrame.module.scss';

const cosmeticTypeImage = {
  'holiday-lights': '/images/holiday/wreath.png',
};

type HolidayGarlandData = {
  color: string;
  type: string;
  brightness: number;
};

const MAX_SIZE = 32;
const MIN_SIZE = 24;

export function HolidayFrame({ cosmetic, data, force, children, animated }: Props) {
  const { lights = 0, upgradedLights = 0 } = data ?? {};
  const size = Math.max(Math.ceil(((MAX_SIZE - lights) / 31) * MAX_SIZE), MIN_SIZE);
  const [showDecorations] = useLocalStorage({ key: 'showDecorations', defaultValue: true });

  if ((!force && !showDecorations) || !cosmetic) return <>{children}</>;

  const { color, type, brightness } = cosmetic.data as HolidayGarlandData;

  const decoration = (
    <div className={styles.decoration}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={cosmeticTypeImage[type as keyof typeof cosmeticTypeImage]}
        style={{ width: '100%', height: 'auto', objectFit: 'contain' }}
        alt={cosmetic.name}
      />
      {lights > 0 && (
        <div className={styles.lights} style={{ '--size': `${size}px` } as React.CSSProperties}>
          {Array.from({ length: lights }).map((_, index) => (
            <Lightbulb
              key={index}
              variant={upgradedLights && index < upgradedLights ? 'star' : 'default'}
              className={
                upgradedLights && index < upgradedLights ? styles.upgradedLight : styles.light
              }
              color={color}
              brightness={brightness}
              animated={animated}
            />
          ))}
        </div>
      )}
    </div>
  );

  if (!children) return decoration;

  return (
    <div className={styles.root}>
      {children}
      {/* Fixed className to reference it in other components easily */}
      <a href="/events/holiday2023" target="_blank" className={styles.wrapper}>
        {decoration}
      </a>
    </div>
  );
}

type Props = {
  cosmetic?: UserWithCosmetics['cosmetics'][number]['cosmetic'];
  data?: { lights?: number; upgradedLights?: number } | null;
  children?: React.ReactNode;
  force?: boolean;
  animated?: boolean;
};

