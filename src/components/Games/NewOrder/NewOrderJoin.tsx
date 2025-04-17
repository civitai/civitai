import { Button, Modal, Text, ThemeIcon } from '@mantine/core';
import { IconShieldStar } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useJoinKnightsNewOrder } from '~/components/Games/KnightsNewOrder.utils';

export function NewOrderJoin() {
  const { join } = useJoinKnightsNewOrder();
  const [opened, setOpened] = useState(false);

  const joinButton = useMemo(
    () => (
      <Button color="orange.5" size="lg" onClick={() => join()} fullWidth>
        Join Game
      </Button>
    ),
    [join]
  );

  return (
    <div className="flex size-full items-center justify-center p-4">
      <div className="mx-auto flex w-full max-w-[448px] flex-col items-center gap-4 text-center">
        <ThemeIcon
          className="rounded-full border border-orange-5"
          size={128}
          color="orange"
          variant="light"
        >
          <IconShieldStar className="size-16" />
        </ThemeIcon>
        <h1 className="text-4xl font-bold tracking-tight text-orange-5 md:text-5xl">
          Knights of New Order
        </h1>
        <p>Forge your destiny in a realm of honor and glory</p>
        {joinButton}
        <Button
          className="text-orange-5"
          variant="white"
          size="lg"
          onClick={() => setOpened(true)}
          fullWidth
        >
          Learn More
        </Button>
      </div>
      <Modal
        size="lg"
        onClose={() => setOpened(false)}
        opened={opened}
        title={
          <Text color="orange.5" size="lg" weight={600}>
            What is Knights of New Order?
          </Text>
        }
        centered
      >
        <div className="flex flex-col gap-4">
          <p>
            Knights of New Order is a thrilling game where players take on the roles of knights in a
            fantastical world. Engage in epic battles, form alliances, and embark on quests to
            become the ultimate knight.
          </p>
          <p>
            Join us now and experience the excitement of Knights of New Order. Will you rise to the
            challenge and become a legendary knight?
          </p>
          {joinButton}
        </div>
      </Modal>
    </div>
  );
}
