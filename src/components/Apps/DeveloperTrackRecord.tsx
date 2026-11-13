import { Anchor, Group, Text } from '@mantine/core';
import Link from 'next/link';
import { AppListingOfficialBadge } from '~/components/Apps/AppListingOfficialBadge';
import { developerTrackRecordView } from '~/components/Apps/developer-track-record';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';
import { trpc } from '~/utils/trpc';

/**
 * The line under the creator card on a listing page: "4 apps · 12 reviews", linking to the
 * developer's profile Apps tab, or the Official badge on an Official listing (no query then).
 * Renders nothing while the record loads, when the store is dark for this viewer, or when the
 * record counts no visible app.
 */
export function DeveloperTrackRecord({
  creator,
  isOfficial,
}: {
  creator: { id: number; username: string | null };
  isOfficial: boolean;
}) {
  const features = useFeatureFlags();
  const { data: record } = trpc.appListings.getDeveloperTrackRecord.useQuery(
    { userId: creator.id },
    { enabled: !isOfficial && hasAppsStoreAccess(features) }
  );
  const view = developerTrackRecordView({ isOfficial, record });
  if (!view) return null;

  if (view.kind === 'official') {
    return (
      <Group gap="xs" data-testid="apps-listing-track-record">
        <AppListingOfficialBadge testId="apps-listing-track-record-official" />
      </Group>
    );
  }

  const text = (
    <Text size="sm" c="dimmed" span>
      {view.text}
    </Text>
  );
  return (
    <Group gap="xs" data-testid="apps-listing-track-record">
      {creator.username ? (
        <Anchor
          component={Link}
          href={`/user/${encodeURIComponent(creator.username)}/apps`}
          size="sm"
          c="dimmed"
          underline="hover"
        >
          {view.text}
        </Anchor>
      ) : (
        text
      )}
    </Group>
  );
}
