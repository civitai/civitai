import { Card, Text } from '@mantine/core';
import { LevelAnimation } from '~/components/Animations/LevelAnimation';
import styles from './LevelProgress.module.scss';

export function LevelUp() {
  return (
    <Card className={styles.levelUp} p="md" radius="lg" shadow="xl" withBorder>
      <LevelAnimation
        lottieProps={{
          height: 300,
          style: { marginTop: -210 },
        }}
      />
      <Text size={48} ta="center" weight={500} mt={-90} mb={10} lh={1}>
        Level up!
      </Text>
    </Card>
  );
}
