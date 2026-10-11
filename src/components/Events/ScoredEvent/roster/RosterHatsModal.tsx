import { Modal, SimpleGrid, Text } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { HatArt } from '~/components/Events/ScoredEvent/HatArt';

export type RosterModalHat = { cosmeticId: number; name: string; url: string; worn: boolean };

/** Every hat a roster member holds, worn first, for a card's "+N". */
export default function RosterHatsModal({
  username,
  hats,
  color,
  glow,
}: {
  username: string;
  hats: RosterModalHat[];
  color?: string;
  glow: string;
}) {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} title={`${username}'s hats`} size="lg" radius="md">
      <SimpleGrid cols={{ base: 3, xs: 4, sm: 5 }} spacing="sm">
        {hats.map((hat, i) => (
          <div key={`${hat.cosmeticId}-${i}`} className="flex flex-col gap-1">
            <HatArt url={hat.url} color={glow} width={192} />
            <Text
              size="xs"
              truncate
              ta="center"
              c={hat.worn ? color : 'dimmed'}
              fw={hat.worn ? 700 : 400}
            >
              {hat.worn ? `Wearing · ${hat.name}` : hat.name}
            </Text>
          </div>
        ))}
      </SimpleGrid>
    </Modal>
  );
}
