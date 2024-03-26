import {
  Box,
  Group,
  SegmentedControl,
  SegmentedControlProps,
  Stack,
  Tabs,
  createStyles,
} from '@mantine/core';
import { MetricTimeframe } from '@prisma/client';
import React, { useMemo, useState } from 'react';

import { NotFound } from '~/components/AppLayout/NotFound';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { SortFilter } from '~/components/Filters';
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
import { UserProfileLayout } from '~/components/Profile/old/OldProfileLayout';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { setPageOptions } from '~/components/AppLayout/AppLayout';

type SectionTypes = 'published' | 'draft' | 'training';

const useStyles = createStyles(() => ({
  filtersWrapper: {
    [containerQuery.smallerThan('sm')]: {
      width: '100%',

      '> *': { flexGrow: 1 },
    },
  },
}));

export default function UserModelsPage() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { classes } = useStyles();
  const { set, section: querySection, ...queryFilters } = useModelQueryParams();
  const period = queryFilters.period ?? MetricTimeframe.AllTime;
  const sort = queryFilters.sort ?? ModelSort.Newest;
  const hidden = queryFilters.hidden ?? false;
  const followed = queryFilters.followed ?? false;
  const username = queryFilters.username ?? '';
  const selfView =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);

  const [section, setSection] = useState<SectionTypes>(
    selfView ? querySection ?? 'published' : 'published'
  );
  const viewingPublished = section === 'published';
  const viewingDraft = section === 'draft';
  const viewingTraining = section === 'training' && features.imageTrainingResults;
  const Wrapper = useMemo(
    () =>
      function Wrapper({ children }: { children: React.ReactNode }) {
        return features.profileOverhaul ? (
          <Box mt="md">{children}</Box>
        ) : (
          <Tabs.Panel value="/models">{children}</Tabs.Panel>
        );
      },
    [features.profileOverhaul]
  );

  // currently not showing any content if the username is undefined
  if (!username) return <NotFound />;

  return (
    <Wrapper>
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer p={0}>
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
                  <Group className={classes.filtersWrapper} spacing="xs" ml="auto">
                    <SortFilter
                      type="models"
                      variant="button"
                      value={sort}
                      onChange={(x) => set({ sort: x as ModelSort })}
                    />
                    <ModelFiltersDropdown filterMode="query" position="left" size="sm" compact />
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
                  }}
                  showEmptyCta={selfView}
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
    </Wrapper>
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
      sx={() => ({
        [containerQuery.smallerThan('sm')]: {
          // flex: 1,
          width: '100%',
        },
      })}
    />
  );
}

setPageOptions(UserModelsPage, { innerLayout: UserProfileLayout });
