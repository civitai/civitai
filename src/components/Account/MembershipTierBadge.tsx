import { Badge } from '@mantine/core';
import type { UserTier } from '~/server/schema/user.schema';

export function MembershipTierBadge({ tier }: { tier?: UserTier }) {
  return (
    <Badge size="xs" color={tier ? 'yellow' : 'gray'} tt="capitalize">
      {tier ?? 'Free'}
    </Badge>
  );
}
