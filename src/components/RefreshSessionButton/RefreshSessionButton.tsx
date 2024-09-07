import { Anchor } from '@mantine/core';
import { useRefreshSession } from '../Stripe/memberships.util';

export function RefreshSessionButton() {
  const { refreshSession, refreshing } = useRefreshSession();

  return (
    <Anchor onClick={refreshSession}>
      {refreshing ? 'refreshing your session...' : 'refresh your session'}
    </Anchor>
  );
}
