import { SegmentedControl, Stack, Title, Group, Text, Button, ThemeIcon } from '@mantine/core';
import { IconPlus, IconTrophy } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { ChallengesInfinite } from '~/components/Challenge/Infinite/ChallengesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client';
import { ChallengeSort } from '~/server/schema/challenge.schema';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';
import { useCurrentUser } from '~/hooks/useCurrentUser';

const sortOptions = [
  { value: ChallengeSort.Newest, label: 'Newest' },
  { value: ChallengeSort.EndingSoon, label: 'Ending Soon' },
  { value: ChallengeSort.HighestPrize, label: 'Highest Prize' },
  { value: ChallengeSort.MostEntries, label: 'Most Entries' },
];

const statusFilters = [
  { value: 'active', label: 'Active' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
];

function ChallengesPage() {
  const router = useRouter();
  const currentUser = useCurrentUser();

  // Parse query params
  const sort = (router.query.sort as ChallengeSort) || ChallengeSort.Newest;
  const statusFilter = (router.query.status as string) || 'active';

  // Convert status filter to API format
  const getStatusArray = () => {
    switch (statusFilter) {
      case 'active':
        return [ChallengeStatus.Active];
      case 'upcoming':
        return [ChallengeStatus.Scheduled];
      case 'completed':
        return [ChallengeStatus.Completed];
      case 'all':
        return undefined; // No filter
      default:
        return [ChallengeStatus.Active];
    }
  };

  const handleSortChange = (value: string) => {
    router.replace(
      { pathname: '/challenges', query: { ...router.query, sort: value } },
      undefined,
      { shallow: true }
    );
  };

  const handleStatusChange = (value: string) => {
    router.replace(
      { pathname: '/challenges', query: { ...router.query, status: value } },
      undefined,
      { shallow: true }
    );
  };

  return (
    <>
      <Meta
        title="AI Art Challenges | Civitai"
        description="Participate in AI art challenges, compete for prizes, and showcase your creative skills with the Civitai community"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL as string}/challenges`, rel: 'canonical' }]}
      />

      <MasonryContainer>
        <Stack gap="md">
          {/* Header */}
          <Group justify="space-between" wrap="nowrap">
            <Group gap="sm">
              <ThemeIcon size="xl" radius="xl" color="yellow" variant="light">
                <IconTrophy size={24} />
              </ThemeIcon>
              <div>
                <Title order={1}>Challenges</Title>
                <Text c="dimmed" size="sm">
                  Compete in AI art challenges and win prizes
                </Text>
              </div>
            </Group>
            {/* Future: Create challenge button for users */}
            {currentUser?.isModerator && (
              <Button
                component={Link}
                href="/moderator/challenges"
                leftSection={<IconPlus size={16} />}
                variant="light"
              >
                Manage
              </Button>
            )}
          </Group>

          {/* Filters */}
          <Group justify="space-between" wrap="wrap" gap="md">
            <SegmentedControl
              value={statusFilter}
              onChange={handleStatusChange}
              data={statusFilters}
              radius="xl"
            />
            <SegmentedControl
              value={sort}
              onChange={handleSortChange}
              data={sortOptions}
              radius="xl"
            />
          </Group>

          {/* Challenge Feed */}
          <ChallengesInfinite
            filters={{
              sort,
              status: getStatusArray(),
              includeEnded: statusFilter === 'completed' || statusFilter === 'all',
            }}
          />
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(ChallengesPage, { InnerLayout: FeedLayout, announcements: true });
