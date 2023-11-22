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

export function HolidayFrame({ cosmetic, lights, lightUpdgrades, children }: Props) {
  const { classes } = useStyles();
  const [showDecorations] = useLocalStorage({ key: 'showDecorations', defaultValue: false });

  if (!showDecorations || !cosmetic) return <>{children}</>;

  return (
    <div className={classes.root}>
      {children}
      <div className={classes.wrapper}>
        <div className={classes.decoration}>
          <img
            src="/images/holiday/wreath.png"
            style={{ width: '100%', height: 'auto', objectFit: 'contain' }}
          />
          <div className={classes.overlay}>
            <Group spacing="xs" p={4}>
              {Array.from({ length: lights }).map((_, index) => (
                <Lightbulb key={index} color="red" size={18} />
              ))}
            </Group>
          </div>
        </div>
      </div>
    </div>
  );
}

type Props = {
  cosmetic?: UserWithCosmetics['cosmetics'][number]['cosmetic'];
  lights: number;
  lightUpdgrades?: number;
  children: React.ReactNode;
};
