import { Center, Divider, Loader, Stack, Text } from '@mantine/core';
import { Fragment } from 'react';
import { CardOrSection } from '~/components/Account/SettingsLayout';
import { MembershipHistoryRow } from '~/components/Account/MembershipHistoryRow';
import { trpc } from '~/utils/trpc';

export function MembershipHistoryCard({ flat }: { flat?: boolean }) {
  const {
    data: memberships = [],
    isLoading,
    isError,
  } = trpc.subscriptions.getMembershipHistory.useQuery();

  if (!isLoading && !isError && memberships.length === 0) return null;

  return (
    <CardOrSection
      flat={flat}
      title="Membership history"
      description="Your current and past memberships. Memberships that ended before we started keeping this history may not appear."
      id="membership-history"
    >
      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : isError ? (
        <Text size="sm" c="red">
          We couldn&apos;t load your membership history. Please refresh the page to try again.
        </Text>
      ) : (
        <Stack gap="md">
          {memberships.map((membership, index) => (
            <Fragment key={membership.id}>
              {index > 0 && <Divider />}
              <MembershipHistoryRow membership={membership} />
            </Fragment>
          ))}
        </Stack>
      )}
    </CardOrSection>
  );
}
