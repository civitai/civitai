import { ActionIcon, Container, Group, Title } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons';
import { useRouter } from 'next/router';
import { BountyById } from '~/types/router';
import { trpc } from '~/utils/trpc';

export function BountyForm({ bounty }: Props) {
  const router = useRouter();

  return (
    <Container size="lg">
      <Group spacing="lg" mb="lg">
        <ActionIcon variant="outline" size="lg" onClick={() => router.back()}>
          <IconArrowLeft size={20} stroke={1.5} />
        </ActionIcon>
        <Title order={3}>{bounty ? 'Editing bounty' : 'Create bounty'}</Title>
      </Group>
    </Container>
  );
}

type Props = {
  bounty?: BountyById;
};
