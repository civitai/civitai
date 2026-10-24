import { Alert, Button, Group, Text } from '@mantine/core';
import { IconTrophy } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { PrizeSourceType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

export function PrizeClaimBanner({
  sourceType,
  sourceId,
}: {
  sourceType: PrizeSourceType;
  sourceId: number;
}) {
  const currentUser = useCurrentUser();
  const { data: prizes } = trpc.prize.getMine.useQuery(
    { sourceType, sourceId },
    { enabled: !!currentUser }
  );
  const unclaimed = prizes?.filter((prize) => !prize.claimedAt) ?? [];
  if (!unclaimed.length) return null;

  return (
    <Alert color="yellow" icon={<IconTrophy />}>
      <Group justify="space-between" wrap="nowrap">
        <Text>You have a prize to claim!</Text>
        <Button
          component={Link}
          href={unclaimed.length === 1 ? `/prizes/${unclaimed[0].id}` : '/prizes'}
          size="xs"
        >
          Claim prize
        </Button>
      </Group>
    </Alert>
  );
}
