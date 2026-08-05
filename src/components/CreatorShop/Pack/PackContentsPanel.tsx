import { Alert, Badge, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { CosmeticThumb } from '~/components/CreatorShop/CosmeticThumb';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

/**
 * A pack's members, for a moderator deciding whether to approve it.
 *
 * Approval is what makes every member sellable at the bundled price, and the
 * rights affirmation shown alongside it asserts rights over artwork — so a
 * review panel that shows only the cover is approving something it hasn't seen.
 */
export function PackContentsPanel({ shopItemId }: { shopItemId: number }) {
  const { data: pack, isLoading } = trpc.creatorShop.getPack.useQuery({ id: shopItemId });

  if (isLoading) return <Loader size="sm" />;
  if (!pack) return null;

  const partsTotal = pack.members.reduce((sum, m) => sum + m.listPrice, 0);
  const foreign = pack.members.filter((m) => !m.isOwn);

  return (
    <Stack gap="xs">
      <Group gap={8} align="baseline">
        <Text fw={600} size="sm">
          Contents ({pack.members.length})
        </Text>
        <Text size="xs" c="dimmed">
          {numberWithCommas(partsTotal)} Buzz bought separately ·{' '}
          {numberWithCommas(pack.unitAmount)} Buzz as a pack
        </Text>
      </Group>
      {!!foreign.length && (
        <Text size="xs" c="dimmed">
          {foreign.length} of these were made by other creators, who are paid at their own list
          price.
        </Text>
      )}
      {!!pack.unavailableCount && (
        <Alert color="yellow">
          {pack.unavailableCount} item(s) in this pack no longer have a published listing, so it
          cannot be bought.
        </Alert>
      )}
      {pack.members.map((member) => (
        <Paper key={member.cosmeticId} withBorder radius="md" p="xs">
          <Group gap="xs" wrap="nowrap" align="center">
            <CosmeticThumb data={member.data} name={member.name} />
            <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
              <Text size="sm" fw={600} lineClamp={1}>
                {member.name}
              </Text>
              <Text size="xs" c="dimmed" lineClamp={1}>
                {getDisplayName(member.type)}
                {member.creatorUsername ? ` · by @${member.creatorUsername}` : ''}
              </Text>
            </Stack>
            <Stack gap={2} align="flex-end">
              <Text size="xs">{numberWithCommas(member.listPrice)} Buzz</Text>
              {!member.acceptsBlueBuzz && (
                <Badge size="xs" color="gray" variant="light">
                  No Blue
                </Badge>
              )}
            </Stack>
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}
