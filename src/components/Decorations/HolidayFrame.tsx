import { createStyles } from '@mantine/core';
import { Lightbulb } from './Lightbulb';
import { useLocalStorage } from '@mantine/hooks';
import { UserWithCosmetics } from '~/server/selectors/user.selector';

const useStyles = createStyles<string, { size: number }>((_, params) => ({
  root: {
    position: 'relative',
  },
  wrapper: {
    position: 'absolute',
    bottom: '-10px',
    width: '100%',
    zIndex: 10,
    maxWidth: 360,
  },
  decoration: {
    position: 'relative',
  },
  lights: {
    position: 'absolute',
    top: '50%',
    left: 0,
    flexWrap: 'wrap',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    height: 44,
    transform: 'translateY(-50%)',
    padding: '0 10px',
  },
  light: {
    width: params.size,
    height: params.size,
    marginLeft: -(params.size * 0.75),
    transform: 'translateY(50%) rotate(6deg)',
    transformOrigin: 'top center',
    '&:first-of-type': {
      marginLeft: 0,
    },
    '&:nth-of-type(4n-2)': {
      transform: 'rotate(186deg) translateY(-60%)',
    },
    '&:nth-of-type(4n-1)': {
      transform: 'translateY(40%) rotate(-6deg)',
    },
    '&:nth-of-type(4n)': {
      transform: 'rotate(174deg) translateY(-55%)',
    },
  },
  upgradedLight: {
    width: Math.floor(params.size * 1.2),
    height: params.size * 1.2,
    marginLeft: -Math.floor(params.size * 1.2 * 0.85),
    transformOrigin: 'top center',
    transform: 'translateY(45%) rotate(6deg)',
    '&:first-of-type': {
      marginLeft: '0',
    },
    '&:nth-of-type(4n-2)': {
      transform: 'rotate(186deg) translateY(-70%)',
    },
    '&:nth-of-type(4n-1)': {
      transform: 'translateY(50%) rotate(-6deg)',
    },
    '&:nth-of-type(4n)': {
      transform: 'rotate(174deg) translateY(-75%)',
    },
  },
}));

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
  const { classes, cx } = useStyles({
    size: Math.max(Math.ceil(((MAX_SIZE - lights) / 31) * MAX_SIZE), MIN_SIZE),
  });
  const [showDecorations] = useLocalStorage({ key: 'showDecorations', defaultValue: true });

  if ((!force && !showDecorations) || !cosmetic) return <>{children}</>;

  const { color, type, brightness } = cosmetic.data as HolidayGarlandData;

  const decoration = (
    <div className={classes.decoration}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={cosmeticTypeImage[type as keyof typeof cosmeticTypeImage]}
        style={{ width: '100%', height: 'auto', objectFit: 'contain' }}
        alt={cosmetic.name}
      />
      {lights > 0 && (
        <div className={classes.lights}>
          {Array.from({ length: lights }).map((_, index) => (
            <Lightbulb
              key={index}
              variant={upgradedLights && index < upgradedLights ? 'star' : 'default'}
              className={
                upgradedLights && index < upgradedLights ? classes.upgradedLight : classes.light
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
    <div className={cx('frame-decor', classes.root)}>
      {children}
      {/* Fixed className to reference it in other components easily */}
      <a href="/events/holiday2023" target="_blank" className={cx(classes.wrapper)}>
        {decoration}
      </a>
    </div>
  );
}

export function CardDecoration({ cosmetic, data, className, animated }: Props2) {
  const { lights = 0, upgradedLights = 0 } = data ?? {};
  const { classes, cx } = useStyles({
    size: Math.max(Math.ceil(((MAX_SIZE - lights) / 31) * MAX_SIZE), MIN_SIZE),
  });
  const [showDecorations] = useLocalStorage({ key: 'showDecorations', defaultValue: true });

  if (!showDecorations || !cosmetic) return null;

  const { color, type, brightness } = cosmetic.data as HolidayGarlandData;

  return (
    <a
      href="/events/holiday2023"
      target="_blank"
      className={cx('frame-decor', classes.wrapper, className)}
    >
      <div className={classes.decoration}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={cosmeticTypeImage[type as keyof typeof cosmeticTypeImage]}
          style={{ width: '100%', height: 'auto', objectFit: 'contain' }}
          alt={cosmetic.name}
        />
        {lights > 0 && (
          <div className={classes.lights}>
            {Array.from({ length: lights }).map((_, index) => (
              <Lightbulb
                key={index}
                variant={upgradedLights && index < upgradedLights ? 'star' : 'default'}
                className={
                  upgradedLights && index < upgradedLights ? classes.upgradedLight : classes.light
                }
                color={color}
                brightness={brightness}
                animated={animated}
              />
            ))}
          </div>
        )}
      </div>
    </a>
  );
}

type Props = {
  cosmetic?: UserWithCosmetics['cosmetics'][number]['cosmetic'];
  data?: { lights?: number; upgradedLights?: number } | null;
  children?: React.ReactNode;
  force?: boolean;
  animated?: boolean;
};

type Props2 = {
  cosmetic?: UserWithCosmetics['cosmetics'][number]['cosmetic'];
  data?: { lights?: number; upgradedLights?: number } | null;
  className?: string;
  animated?: boolean;
};
