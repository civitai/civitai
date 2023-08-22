import { Center, Group, SegmentedControl, SegmentedControlProps, Stack, Tabs } from '@mantine/core';
import { MetricTimeframe } from '@prisma/client';
import { IconInfoCircle } from '@tabler/icons-react';
import { useState } from 'react';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NotFound } from '~/components/AppLayout/NotFound';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { UserDraftModels } from '~/components/User/UserDraftModels';
import UserTrainingModels from '~/components/User/UserTrainingModels';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { ModelSort } from '~/server/common/enums';
import { postgresSlugify } from '~/utils/string-helpers';

import { UserProfileLayout } from './';

type SectionTypes = 'published' | 'draft' | 'training';

export default function UserModelsPage() {
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
  const viewingTraining = section === 'training' && features.imageTraining;

  // currently not showing any content if the username is undefined
  if (!username) return <NotFound />;

  return (
    <Tabs.Panel value="/models">
      {selfView && (
        <Center>
          <AlertWithIcon maw={600} mb="sm" icon={<IconInfoCircle />} title="Metric Period Mode">
            Since you are viewing your own profile, we show all of your creations and the period
            filter instead only adjusts the timeframe for the metrics that are displayed.
          </AlertWithIcon>
        </Center>
      )}
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          <Stack spacing="xs">
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
                      hideMode={selfView}
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
                    periodMode: selfView ? 'stats' : undefined,
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
    </Tabs.Panel>
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
  if (features.imageTraining) tabs.push({ label: 'Training', value: 'training' });
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

UserModelsPage.getLayout = UserProfileLayout;
