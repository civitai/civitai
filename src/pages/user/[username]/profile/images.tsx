import { SidebarLayout } from '~/components/Profile/SidebarLayout';
import {
  Chip,
  createStyles,
  Group,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlProps,
  Stack,
} from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { constants } from '~/server/common/constants';
import { useState } from 'react';
import { shouldDisplayUserNullState } from '~/components/Profile/profile.utils';
import { ProfileHeader } from '~/components/Profile/ProfileHeader';
import ProfileLayout from '~/components/Profile/ProfileLayout';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { ImageSort, ModelSort } from '~/server/common/enums';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { UserDraftModels } from '~/components/User/UserDraftModels';
import UserTrainingModels from '~/components/User/UserTrainingModels';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { MetricTimeframe, ReviewReactions } from '@prisma/client';
import { postgresSlugify } from '~/utils/string-helpers';
import { useImageQueryParams } from '~/components/Image/image.utils';
import { ImageFiltersDropdown } from '~/components/Image/Filters/ImageFiltersDropdown';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { useCurrentUser } from '~/hooks/useCurrentUser';

const useChipStyles = createStyles((theme) => ({
  label: {
    fontSize: 12,
    fontWeight: 500,
    padding: `0 ${theme.spacing.xs * 0.75}px`,

    '&[data-variant="filled"]': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[1],

      '&[data-checked]': {
        backgroundColor:
          theme.colorScheme === 'dark'
            ? theme.fn.rgba(theme.colors.blue[theme.fn.primaryShade()], 0.5)
            : theme.fn.rgba(theme.colors.blue[theme.fn.primaryShade()], 0.2),
      },
    },

    [theme.fn.smallerThan('xs')]: {
      padding: `4px ${theme.spacing.sm}px !important`,
      fontSize: 18,
      height: 'auto',

      '&[data-checked]': {
        padding: `4px ${theme.spacing.sm}px`,
      },
    },
  },

  iconWrapper: {
    display: 'none',
  },

  chipGroup: {
    [theme.fn.smallerThan('xs')]: {
      width: '100%',
    },
  },
}));

const segments = [
  { label: 'My Images', value: 'images' },
  { label: 'My Reactions', value: 'reactions' },
] as const;

type Segment = (typeof segments)[number]['value'];

const availableReactions = Object.keys(constants.availableReactions) as ReviewReactions[];

export function UserProfileImages() {
  const currentUser = useCurrentUser();
  const { classes } = useChipStyles();

  const {
    replace,
    query: {
      period = MetricTimeframe.AllTime,
      sort = ImageSort.Newest,
      username = '',
      reactions,
      types = [],
      withMeta = false,
      followed = undefined,
      ...query
    },
  } = useImageQueryParams();

  const isSameUser =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);
  const section = isSameUser ? query.section ?? 'images' : 'images';

  const viewingReactions = section === 'reactions';

  // currently not showing any content if the username is undefined
  if (!username) return <NotFound />;

  return (
    <ProfileLayout username={username}>
      <ProfileHeader username={username} />
      <MasonryProvider
        columnWidth={constants.cardSizes.image}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          <Stack spacing="xs" mt="md">
            <Group spacing={8} position="apart">
              <Group spacing={8}>
                {isSameUser && (
                  <ContentToggle
                    size="xs"
                    value={section}
                    onChange={(section) => replace({ section })}
                  />
                )}
                {viewingReactions && (
                  <Chip.Group
                    spacing={4}
                    value={reactions ?? []}
                    onChange={(reactions: ReviewReactions[]) => replace({ reactions })}
                    className={classes.chipGroup}
                    multiple
                    noWrap
                  >
                    {availableReactions.map((reaction, index) => (
                      <Chip
                        key={index}
                        value={reaction}
                        classNames={classes}
                        variant="filled"
                        radius="sm"
                        size="xs"
                      >
                        {constants.availableReactions[reaction as ReviewReactions]}
                      </Chip>
                    ))}
                  </Chip.Group>
                )}
              </Group>
              <Group spacing={8} noWrap>
                <SortFilter
                  type="images"
                  variant="button"
                  value={sort}
                  onChange={(x) => replace({ sort: x as ImageSort })}
                />
                <ImageFiltersDropdown
                  query={{ ...query, period, types, withMeta, followed }}
                  onChange={(filters) => replace(filters)}
                />
              </Group>
            </Group>
            <ImagesInfinite
              filters={{
                ...query,
                period,
                sort,
                types,
                withMeta,
                reactions: viewingReactions ? reactions ?? availableReactions : undefined,
                username: viewingReactions ? undefined : username,
                followed,
              }}
            />
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
  value: Segment;
  onChange: (value: Segment) => void;
}) {
  return (
    <SegmentedControl
      {...props}
      value={value}
      onChange={onChange}
      data={segments as unknown as SegmentedControlItem[]}
      sx={(theme) => ({
        [theme.fn.smallerThan('sm')]: {
          width: '100%',
        },
      })}
    />
  );
}

UserProfileImages.getLayout = (page: React.ReactElement) => <SidebarLayout>{page}</SidebarLayout>;

export default UserProfileImages;
