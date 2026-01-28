import { Alert, Button, Group, Text } from '@mantine/core';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { NextLink } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useAppContext } from '~/providers/AppProvider';

/**
 * Hook to check if membership upsell should be shown.
 */
export function useMembershipUpsell() {
  const currentUser = useCurrentUser();
  const { domain } = useAppContext();

  return {
    canShow: !!domain.blue && !currentUser?.isPaidMember,
  };
}

export function MembershipUpsell() {
  const { canShow } = useMembershipUpsell();

  if (!canShow) return null;

  return (
    <Alert p="sm">
      <div className="flex flex-col gap-3">
        <Group gap="xs" wrap="nowrap">
          <Text size="sm" fw={500}>
            Generate mature content with Blue Buzz
          </Text>
          <InfoPopover size="sm" withinPortal>
            <Text size="sm">
              Did you know that members can generate mature content using their Blue Buzz? Get a{' '}
              <Text component="span" c="yellow">
                yellow
              </Text>{' '}
              membership now to use your Blue Buzz to keep generating
            </Text>
            <Button
              component={NextLink}
              href="/pricing?buzzType=yellow"
              size="sm"
              fullWidth
              mt="sm"
            >
              Purchase Membership
            </Button>
          </InfoPopover>
        </Group>
      </div>
    </Alert>
  );
}
