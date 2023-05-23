import { Center, Group, SegmentedControl, SegmentedControlProps, Stack, Tabs } from '@mantine/core';
import { MetricTimeframe } from '@prisma/client';
import { IconInfoCircle } from '@tabler/icons-react';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NotFound } from '~/components/AppLayout/NotFound';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { ModelSort } from '~/server/common/enums';
import { postgresSlugify } from '~/utils/string-helpers';

import { UserProfileLayout } from './';
import { useState } from 'react';
import { UserDraftModels } from '~/components/User/UserDraftModels';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';

export default function UserModelsPage() {
  const currentUser = useCurrentUser();
  const { set, section: querySection, ...queryFilters } = useModelQueryParams();
  const period = queryFilters.period ?? MetricTimeframe.AllTime;
  const sort = queryFilters.sort ?? ModelSort.Newest;
  const username = queryFilters.username ?? '';
  const selfView =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);

  const [section, setSection] = useState<'published' | 'draft'>(
    selfView ? querySection ?? 'published' : 'published'
  );
  const viewingPublished = section === 'published';

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
            ) : (
              <UserDraftModels />
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
  value: 'published' | 'draft';
  onChange: (value: 'published' | 'draft') => void;
}) {
  return (
    <SegmentedControl
      {...props}
      value={value}
      onChange={onChange}
      data={[
        { label: 'Published', value: 'published' },
        { label: 'Draft', value: 'draft' },
      ]}
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
