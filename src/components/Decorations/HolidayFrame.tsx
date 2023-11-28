import { Group, createStyles } from '@mantine/core';
import { Lightbulb } from './Lightbulb';
import { useLocalStorage } from '@mantine/hooks';
import { UserWithCosmetics } from '~/server/selectors/user.selector';

const useStyles = createStyles(() => ({
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
    width: 32,
    height: 32,
    marginLeft: -24,
    transform: 'translateY(50%) rotate(6deg)',
    transformOrigin: 'top center',
    '&:first-child': {
      marginLeft: 0,
    },
    '&:nth-child(4n-2)': {
      transform: 'rotate(186deg) translateY(-60%)',
    },
    '&:nth-child(4n-1)': {
      transform: 'translateY(40%) rotate(-6deg)',
    },
    '&:nth-child(4n)': {
      transform: 'rotate(174deg) translateY(-55%)',
    },
  },
  upgradedLight: {
    width: 40,
    height: 40,
    marginLeft: -36,
    transformOrigin: 'top center',
    transform: 'translateY(45%) rotate(6deg)',
    '&:first-child': {
      marginLeft: '0',
    },
    '&:nth-child(4n-2)': {
      transform: 'rotate(186deg) translateY(-70%)',
    },
    '&:nth-child(4n-1)': {
      transform: 'translateY(50%) rotate(-6deg)',
    },
    '&:nth-child(4n)': {
      transform: 'rotate(174deg) translateY(-75%)',
    },
  },
}));

const cosmeticTypeImage = {
  'holiday-lights': '/images/holiday/wreath.png',
};

export function HolidayFrame({ cosmetic, lights, lightUpgrades, children }: Props) {
  const { classes } = useStyles();
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
              variant={lightUpgrades && index < lightUpgrades ? 'star' : 'default'}
              className={
                lightUpgrades && index < lightUpgrades ? classes.upgradedLight : classes.light
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
      <div className={classes.wrapper}>{decoration}</div>
    </div>
  );
}

type Props = {
  cosmetic?: UserWithCosmetics['cosmetics'][number]['cosmetic'];
  lights: number;
  lightUpgrades?: number;
  children?: React.ReactNode;
};
