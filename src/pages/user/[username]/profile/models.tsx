import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SidebarLayout } from '~/components/Profile/SidebarLayout';
import { Group, SegmentedControl, SegmentedControlProps, Stack } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { constants } from '~/server/common/constants';
import { useState } from 'react';
import { shouldDisplayUserNullState } from '~/components/Profile/profile.utils';
import { ProfileHeader } from '~/components/Profile/ProfileHeader';
import ProfileLayout from '~/components/Profile/ProfileLayout';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { ModelSort } from '~/server/common/enums';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { UserDraftModels } from '~/components/User/UserDraftModels';
import UserTrainingModels from '~/components/User/UserTrainingModels';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { MetricTimeframe } from '@prisma/client';
import { postgresSlugify } from '~/utils/string-helpers';

type SectionTypes = 'published' | 'draft' | 'training';
export function UserProfileModels() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { set, section: querySection, ...queryFilters } = useModelQueryParams();
  const period = queryFilters.period ?? MetricTimeframe.AllTime;
  const sort = queryFilters.sort ?? ModelSort.Newest;
  const username = queryFilters.username ?? '';
  const selfView =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);

  const [section, setSection] = useState<SectionTypes>(
    selfView ? querySection ?? 'published' : 'published'
  );
  const viewingPublished = section === 'published';
  const viewingDraft = section === 'draft';
  const viewingTraining = section === 'training' && features.imageTrainingResults;

  // currently not showing any content if the username is undefined
  if (!username) return <NotFound />;

  return (
    <ProfileLayout username={username}>
      <ProfileHeader username={username} />
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid p={0}>
          <Stack spacing="xs" mt="md">
            <Group spacing={8}>
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
                  <SortFilter
                    type="models"
                    value={sort}
                    onChange={(x) => set({ sort: x as ModelSort })}
                  />
                  <Group spacing="xs" ml="auto">
                    <PeriodFilter
                      type="models"
                      value={period}
                      onChange={(x) => set({ period: x })}
                    />
                    <ModelFiltersDropdown />
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
                  }}
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
    </ProfileLayout>
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
  if (features.imageTrainingResults) tabs.push({ label: 'Training', value: 'training' });
  return (
    <SegmentedControl
      {...props}
      value={value}
      onChange={onChange}
      data={tabs}
      sx={(theme) => ({
        [theme.fn.smallerThan('sm')]: {
          // flex: 1,
          width: '100%',
        },
      })}
    />
  );
}

UserProfileModels.getLayout = (page: React.ReactElement) => <SidebarLayout>{page}</SidebarLayout>;

export default UserProfileModels;
