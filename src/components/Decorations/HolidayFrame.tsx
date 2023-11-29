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
    zIndex: 100,
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
    marginLeft: -24,
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
    width: 40,
    height: 40,
    marginLeft: -36,
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

export function HolidayFrame({ cosmetic, data, children }: Props) {
  const { lights = 0, upgradedLights = 0 } = data ?? {};
  const { classes, cx } = useStyles({ size: Math.max(Math.ceil(((32 - lights) / 31) * 32), 18) });
  const [showDecorations] = useLocalStorage({ key: 'showDecorations', defaultValue: false });

  if (!showDecorations || !cosmetic) return <>{children}</>;

  const { color, type } = cosmetic.data as { color: string; type: string };
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
              brightness={1}
            />
          ))}
        </div>
      )}
    </div>
  );

  if (!children) return decoration;

  return (
    <div className={classes.root}>
      {children}
      {/* Fixed className to reference it in other components easily */}
      <div className={cx('frame-decor', classes.wrapper)}>{decoration}</div>
    </div>
  );
}

type Props = {
  cosmetic?: UserWithCosmetics['cosmetics'][number]['cosmetic'];
  data?: { lights?: number; upgradedLights?: number } | null;
  children?: React.ReactNode;
};
