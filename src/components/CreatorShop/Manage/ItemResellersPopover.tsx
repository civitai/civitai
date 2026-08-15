import { Anchor, Group, Loader, Popover, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

/**
 * Who resells one of the creator's items, and on what terms. Each reseller keeps
 * the share they listed under, so this is also the list of people a change to the
 * item's resale terms would NOT affect.
 */
export function ItemResellersPopover({ shopItemId, count }: { shopItemId: number; count: number }) {
  const [opened, setOpened] = useState(false);
  const { data = [], isLoading } = trpc.creatorShop.getItemResellers.useQuery(
    { shopItemId },
    { enabled: opened }
  );

  // The theme defaults every Popover to withinPortal={false}, and this one opens
  // inside the manage table's scroll container (overflow: hidden), which clips the
  // dropdown. Portalling is the only escape — no z-index can leave that clip.
  return (
    <Popover
      width={280}
      position="bottom-start"
      withArrow
      withinPortal
      opened={opened}
      onChange={setOpened}
    >
      <Popover.Target>
        <Anchor component="button" type="button" size="xs" onClick={() => setOpened((o) => !o)}>
          {count} {count === 1 ? 'creator resells' : 'creators resell'} this
        </Anchor>
      </Popover.Target>
      <Popover.Dropdown>
        {isLoading ? (
          <Loader size="xs" />
        ) : (
          <Stack gap="xs">
            <Text size="xs" c="dimmed">
              Each keeps the share they listed under, even if you change it.
            </Text>
            {data.map(({ user, sellerShare, listedAt }) => (
              <Group key={user.id} justify="space-between" wrap="nowrap" gap="xs">
                <UserAvatar user={user} size="xs" withUsername linkToProfile />
                <Text size="xs" fw={600} c="green" style={{ whiteSpace: 'nowrap' }}>
                  {sellerShare}%
                  <Text span c="dimmed" fw={400}>
                    {' '}
                    · {formatDate(listedAt)}
                  </Text>
                </Text>
              </Group>
            ))}
          </Stack>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
