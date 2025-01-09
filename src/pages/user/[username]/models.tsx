import {
  Box,
  Group,
  SegmentedControl,
  SegmentedControlProps,
  Stack,
  createStyles,
} from '@mantine/core';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import React, { useState } from 'react';

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
import { Page } from '~/components/AppLayout/Page';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { dbRead } from '~/server/db/client';

type SectionTypes = 'published' | 'draft' | 'training';

const useStyles = createStyles(() => ({
  filtersWrapper: {
    [containerQuery.smallerThan('sm')]: {
      width: '100%',

      '> *': { flexGrow: 1 },
    },
  },
}));

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
  const { classes } = useStyles();
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
    <Box mt="md">
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
                    earlyAccess,
                    types,
                    checkpointType,
                    status,
                    fileFormats,
                    fromPlatform,
                    baseModels,
                    supportsGeneration,
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

export default Page(UserModelsPage, { getLayout: UserProfileLayout });
