import { Card, Text } from '@mantine/core';
import clsx from 'clsx';
import { LevelAnimation } from '~/components/Animations/LevelAnimation';
import styles from './LevelProgress.module.scss';

export function LevelUp({ className }: { className?: string }) {
  return (
    <Card className={clsx(styles.levelUp, className)} p="md" radius="lg" shadow="xl" withBorder>
      <LevelAnimation
        lottieProps={{
          height: 300,
          style: { marginTop: -210 },
        }}
      />
      <Text fz={48} ta="center" fw={500} mt={-90} mb={10} lh={1}>
        Level up!
      </Text>
    </Card>
  );
}
