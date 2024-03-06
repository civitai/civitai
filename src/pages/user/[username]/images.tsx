import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { MediaType, MetricTimeframe, ReviewReactions } from '@prisma/client';
import { ImageSort } from '~/server/common/enums';
import { useImageQueryParams } from '~/components/Image/image.utils';
import { postgresSlugify } from '~/utils/string-helpers';
import { NotFound } from '~/components/AppLayout/NotFound';
import React, { useMemo } from 'react';
import {
  Box,
  Chip,
  createStyles,
  Group,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlProps,
  Stack,
  Tabs,
} from '@mantine/core';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { constants } from '~/server/common/constants';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { SortFilter } from '~/components/Filters';
import { ImageFiltersDropdown } from '~/components/Image/Filters/ImageFiltersDropdown';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { UserProfileLayout } from '~/components/Profile/old/OldProfileLayout';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { setPageOptions } from '~/components/AppLayout/AppLayout';

const segments = [
  { label: 'My Images', value: 'images' },
  { label: 'My Reactions', value: 'reactions' },
] as const;
type Segment = (typeof segments)[number]['value'];

const availableReactions = Object.keys(constants.availableReactions) as ReviewReactions[];

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

    [containerQuery.smallerThan('xs')]: {
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
    [containerQuery.smallerThan('xs')]: {
      width: '100%',
    },
  },

  filtersWrapper: {
    [containerQuery.smallerThan('sm')]: {
      width: '100%',

      '> *': { flexGrow: 1 },
    },
  },
}));
export function UserImagesPage() {
  const currentUser = useCurrentUser();
  const { classes } = useChipStyles();
  const features = useFeatureFlags();

  const {
    replace,
    query: {
      period = MetricTimeframe.AllTime,
      sort = ImageSort.Newest,
      username = '',
      reactions,
      types = [MediaType.image],
      withMeta = false,
      followed = undefined,
      fromPlatform = false,
      ...query
    },
  } = useImageQueryParams();

  const isSameUser =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);
  const section = isSameUser ? query.section ?? 'images' : 'images';

  const viewingReactions = section === 'reactions';

  const Wrapper = useMemo(
    () =>
      function Wrapper({ children }: { children: React.ReactNode }) {
        return features.profileOverhaul ? (
          <Box mt="md">{children}</Box>
        ) : (
          <Tabs.Panel value="/images">{children}</Tabs.Panel>
        );
      },
    [features.profileOverhaul]
  );

  // currently not showing any content if the username is undefined
  if (!username) return <NotFound />;

  return (
    <Wrapper>
      <MasonryProvider
        columnWidth={constants.cardSizes.image}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer p={0}>
          <Stack spacing="xs">
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
              <Group className={classes.filtersWrapper} spacing={8} noWrap>
                <SortFilter
                  type="images"
                  variant="button"
                  value={sort}
                  onChange={(x) => replace({ sort: x as ImageSort })}
                />
                <ImageFiltersDropdown
                  query={{ ...query, period, types, withMeta, followed }}
                  onChange={(filters) => replace(filters)}
                  size="sm"
                  compact
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
                fromPlatform,
                hidden: undefined,
                reactions: viewingReactions ? reactions ?? availableReactions : undefined,
                username: viewingReactions ? undefined : username,
                followed,
                pending: true,
              }}
              showEmptyCta={isSameUser}
            />
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
  value: Segment;
  onChange: (value: Segment) => void;
}) {
  return (
    <SegmentedControl
      {...props}
      value={value}
      onChange={onChange}
      data={segments as unknown as SegmentedControlItem[]}
      sx={() => ({
        [containerQuery.smallerThan('sm')]: {
          width: '100%',
        },
      })}
    />
  );
}

// We re-use the component above in the index for old profile. Hence, we need to wrap it and export it here too.
const UserImagesPageWrap = () => <UserImagesPage />;
setPageOptions(UserImagesPageWrap, { innerLayout: UserProfileLayout });

export default UserImagesPageWrap;
