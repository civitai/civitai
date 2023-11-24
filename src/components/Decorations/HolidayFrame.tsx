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
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
  },
}));

const cosmeticTypeImage = {
  'holiday-lights': '/images/holiday/wreath.png',
};

export function HolidayFrame({ cosmetic, lights, lightUpdgrades, children }: Props) {
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
        <div className={classes.overlay}>
          <Group spacing="xs" p={4}>
            {Array.from({ length: lights }).map((_, index) => (
              <Lightbulb key={index} color={color} size={18} />
            ))}
          </Group>
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
  lightUpdgrades?: number;
  children?: React.ReactNode;
};
