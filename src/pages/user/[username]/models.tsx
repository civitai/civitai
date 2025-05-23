import { Box, Group, SegmentedControl, SegmentedControlProps, Stack } from '@mantine/core';
import { useState } from 'react';

import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { UserProfileLayout } from '~/components/Profile/old/OldProfileLayout';
import { UserDraftModels } from '~/components/User/UserDraftModels';
import UserTrainingModels from '~/components/User/UserTrainingModels';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { ModelSort } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Availability, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import styles from './models.module.scss';

type SectionTypes = 'published' | 'private' | 'draft' | 'training';

export const getServerSideProps = createServerSideProps({
  resolver: async ({ ctx }) => {
    const username = ctx.query.username as string;
    const user = await dbRead.user.findUnique({ where: { username }, select: { bannedAt: true } });

    if (user?.bannedAt)
      return {
        redirect: { destination: `/user/${username}`, permanent: true },
      };
  },
});

function UserModelsPage() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { set, section: querySection, ...queryFilters } = useModelQueryParams();
  const period = queryFilters.period ?? MetricTimeframe.AllTime;
  const sort = queryFilters.sort ?? ModelSort.Newest;
  const hidden = queryFilters.hidden ?? false;
  const followed = queryFilters.followed ?? false;
  const earlyAccess = queryFilters.earlyAccess ?? false;
  const types = queryFilters.types ?? undefined;
  const checkpointType = queryFilters.checkpointType ?? undefined;
  const status = queryFilters.status ?? undefined;
  const fileFormats = queryFilters.fileFormats ?? undefined;
  const fromPlatform = queryFilters.fromPlatform ?? false;
  const baseModels = queryFilters.baseModels ?? undefined;
  const supportsGeneration = queryFilters.supportsGeneration ?? false;
  const isFeatured = queryFilters.isFeatured ?? false;
  const username = queryFilters.username ?? '';
  const selfView =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);

  const [section, setSection] = useState<SectionTypes>(
    selfView ? querySection ?? 'published' : 'published'
  );
  const viewingPublished = section === 'published';
  const viewingPrivate = section === 'private';
  const viewingDraft = section === 'draft';
  const viewingTraining = section === 'training' && features.imageTrainingResults;

  // currently not showing any content if the username is undefined
  if (!username) return <NotFound />;

  return (
    <Box mt="md">
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer p={0}>
          <Stack gap="xs">
            <Group gap={8}>
              {selfView && (
                <ContentToggle
                  size="xs"
                  value={section}
                  onChange={(section) => {
                    setSection(section);
                    set({ section });
                  }}
                />
              )}
              {viewingPublished && (
                <>
                  <Group className={styles.filtersWrapper} gap="xs" ml="auto">
                    <SortFilter
                      type="models"
                      value={sort}
                      onChange={(x) => set({ sort: x as ModelSort })}
                    />
                    <ModelFiltersDropdown filterMode="query" position="left" size="compact-sm" />
                  </Group>
                </>
              )}
            </Group>
            {viewingPublished ? (
              <>
                <CategoryTags />
                <ModelsInfinite
                  filters={{
                    ...queryFilters,
                    sort,
                    period,
                    pending: true,
                    hidden,
                    followed,
                    earlyAccess,
                    types,
                    checkpointType,
                    status,
                    fileFormats,
                    fromPlatform,
                    baseModels,
                    supportsGeneration,
                    isFeatured,
                  }}
                  showEmptyCta={selfView}
                  disableStoreFilters
                />
              </>
            ) : viewingPrivate ? (
              <>
                <CategoryTags />
                <ModelsInfinite
                  filters={{
                    ...queryFilters,
                    sort,
                    period,
                    pending: true,
                    hidden,
                    followed,
                    earlyAccess,
                    types,
                    checkpointType,
                    status,
                    fileFormats,
                    fromPlatform,
                    baseModels,
                    supportsGeneration,
                    availability: Availability.Private,
                    isFeatured,
                  }}
                  showEmptyCta={selfView}
                  disableStoreFilters
                />
              </>
            ) : viewingDraft ? (
              <UserDraftModels />
            ) : viewingTraining ? (
              <UserTrainingModels />
            ) : (
              <NotFound />
            )}
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Box>
  );
}

function ContentToggle({
  value,
  onChange,
  ...props
}: Omit<SegmentedControlProps, 'value' | 'onChange' | 'data'> & {
  value: SectionTypes;
  onChange: (value: SectionTypes) => void;
}) {
  const features = useFeatureFlags();
  const tabs = [
    { label: 'Published', value: 'published' },
    { label: 'Draft', value: 'draft' },
  ];

  if (features.privateModels) tabs.push({ label: 'Private', value: 'private' });
  if (features.imageTrainingResults) tabs.push({ label: 'Training', value: 'training' });

  return (
    <SegmentedControl
      {...props}
      value={value}
      onChange={(value: string) => onChange(value as SectionTypes)}
      data={tabs}
      className="sm:w-full md:w-auto"
    />
  );
}

export default Page(UserModelsPage, { getLayout: UserProfileLayout });
