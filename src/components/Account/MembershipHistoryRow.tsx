import { Badge, Group, Stack, Text } from '@mantine/core';
import type { UserMembershipHistory } from '~/server/services/subscriptions.service';
import {
  getMembershipHistoryState,
  membershipPaymentMethodLabels,
} from '~/shared/utils/membership-history';
import type { MembershipHistoryState } from '~/shared/utils/membership-history';
import { formatDate } from '~/utils/date-helpers';
import { capitalize } from '~/utils/string-helpers';

const slotLabels: Record<string, string> = { yellow: 'Yellow', green: 'Green' };

export function MembershipHistoryRow({
  membership,
}: {
  membership: UserMembershipHistory[number];
}) {
  const state = getMembershipHistoryState(membership);
  const slotLabel = slotLabels[membership.slot];
  const tokens = membership.prepaidTokens;

  return (
    <Stack gap={4}>
      <Group justify="space-between" gap="xs" wrap="wrap">
        <Group gap="xs" wrap="wrap">
          <Text fw={500} lh={1.2}>
            {membership.productName}
          </Text>
          <Badge size="sm" variant="light" color="gray">
            {membershipPaymentMethodLabels[membership.paymentMethod]}
          </Badge>
          {slotLabel && (
            <Badge
              size="sm"
              variant="light"
              color={membership.slot === 'green' ? 'green' : 'yellow'}
            >
              {slotLabel}
            </Badge>
          )}
        </Group>
        <MembershipStateLabel state={state} />
      </Group>
      <Text size="sm" c="dimmed" lh={1.3}>
        {capitalize(membership.tier)} · Started {formatDate(membership.startedAt)} ·{' '}
        {state.state === 'ended' ? 'Last period' : 'Current period'}{' '}
        {formatDate(membership.currentPeriodStart)} – {formatDate(membership.currentPeriodEnd)}
      </Text>
      {state.state === 'ended' && (
        <Text size="sm" c="dimmed" lh={1.3}>
          {state.reason}.
        </Text>
      )}
      {tokens && (
        <Text size="sm" c="dimmed" lh={1.3}>
          Monthly Buzz tokens: {tokens.claimed} of {tokens.total} claimed
          {tokens.readyToClaim > 0 && ` · ${tokens.readyToClaim} ready to claim`}
          {tokens.upcoming > 0 && ` · ${tokens.upcoming} still to unlock`}
        </Text>
      )}
    </Stack>
  );
}

function MembershipStateLabel({ state }: { state: MembershipHistoryState }) {
  switch (state.state) {
    case 'renews':
      return (
        <Text size="sm" c="green" fw={500}>
          Active · Renews {formatDate(state.date)}
        </Text>
      );
    case 'ends':
      return (
        <Text size="sm" c="yellow" fw={500}>
          Active · Ends {formatDate(state.date)}
        </Text>
      );
    case 'ended':
      return (
        <Text size="sm" c="dimmed" fw={500}>
          Ended {formatDate(state.date)}
        </Text>
      );
    case 'payment-failed':
      return (
        <Text size="sm" c="red" fw={500}>
          Payment failed
        </Text>
      );
  }
}
