import { Card, Text } from '@mantine/core';
import clsx from 'clsx';
import styles from './LevelProgress.module.scss';
import dynamic from 'next/dynamic';

const LevelAnimation = dynamic(
  () => import('~/components/Animations/LevelAnimation').then((mod) => mod.LevelAnimation),
  { ssr: false }
);

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
