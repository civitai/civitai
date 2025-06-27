import { Card, Text } from '@mantine/core';
import clsx from 'clsx';
import classes from './LevelProgress.module.scss';
import dynamic from 'next/dynamic';

const LevelAnimation = dynamic(
  () => import('~/components/Animations/LevelAnimation').then((mod) => mod.LevelAnimation),
  { ssr: false }
);

export function LevelUp({ className }: { className?: string }) {
  return (
    <Card className={clsx(classes.levelUp, className)} p="md" radius="lg" shadow="xl" withBorder>
      <LevelAnimation
        lottieProps={{
          style: { marginTop: -210, height: 300 },
        }}
      />
      <Text fz={48} ta="center" fw={500} mt={-90} mb={10} lh={1}>
        Level up!
      </Text>
    </Card>
  );
}
