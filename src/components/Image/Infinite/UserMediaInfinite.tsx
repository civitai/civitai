import {
  Box,
  Center,
  Chip,
  createStyles,
  Group,
  Loader,
  SegmentedControl,
  SegmentedControlProps,
  Stack,
} from '@mantine/core';
import { MediaType, MetricTimeframe, ReviewReactions } from '~/shared/utils/prisma/enums';
import React from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { SortFilter } from '~/components/Filters';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import { ImageSections, useImageQueryParams } from '~/components/Image/image.utils';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { postgresSlugify, titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

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

export function UserMediaInfinite({ type = MediaType.image }: { type: MediaType }) {
  const currentUser = useCurrentUser();
  const { classes } = useChipStyles();

  const {
    replace,
    query: {
      period = MetricTimeframe.AllTime,
      sort = ImageSort.Newest,
      username = '',
      reactions,
      types = [type],
      withMeta = false,
      followed = undefined,
      fromPlatform = false,
      baseModels = undefined,
      tools = [],
      techniques = [],
      ...query
    },
  } = useImageQueryParams();

  const { data: user, isLoading: userLoading } = trpc.userProfile.get.useQuery(
    { username },
    { enabled: username !== constants.system.user.username }
  );

  // currently not showing any content if the username is undefined
  if (!username) return <NotFound />;

  const isSameUser =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);
  const section = isSameUser ? query.section ?? 'images' : 'images';
  const viewingReactions = section === 'reactions';

  const isVideo = type === 'video';

  return (
    <Box mt="md">
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
                    type={type}
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
                        <span>{constants.availableReactions[reaction as ReviewReactions]}</span>
                      </Chip>
                    ))}
                    {/* TODO add "hide owned" */}
                  </Chip.Group>
                )}
              </Group>
              <Group className={classes.filtersWrapper} spacing={8} noWrap>
                <SortFilter
                  type={isVideo ? 'videos' : 'images'}
                  value={sort}
                  onChange={(x) => replace({ sort: x as ImageSort })}
                />
                <MediaFiltersDropdown
                  query={{
                    ...query,
                    period,
                    types,
                    withMeta,
                    followed,
                    fromPlatform,
                    baseModels,
                    tools,
                    techniques,
                  }}
                  filterType={isVideo ? 'videos' : 'images'}
                  onChange={(filters) => replace(filters)}
                  size="sm"
                  compact
                  hideMediaTypes
                />
              </Group>
            </Group>
            <ImageCategories />
            {userLoading ? (
              <Center p="xl">
                <Loader />
              </Center>
            ) : !user ? (
              <NoContent />
            ) : (
              <ImagesInfinite
                filterType={isVideo ? 'videos' : 'images'}
                filters={{
                  ...query,
                  period,
                  sort,
                  types,
                  withMeta,
                  fromPlatform,
                  hidden: undefined,
                  reactions: viewingReactions ? reactions ?? availableReactions : undefined,
                  userId: viewingReactions ? undefined : user.id,
                  username: viewingReactions ? undefined : username,
                  followed,
                  baseModels,
                  tools,
                  techniques,
                  // pending: true,
                }}
                showEmptyCta={isSameUser}
                useIndex={!viewingReactions}
              />
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
  type,
  ...props
}: Omit<SegmentedControlProps, 'value' | 'onChange' | 'data'> & {
  value: ImageSections;
  onChange: (value: ImageSections) => void;
  type: MediaType;
}) {
  return (
    <SegmentedControl
      {...props}
      value={value}
      onChange={onChange}
      data={[
        { label: `My ${titleCase(type)}s`, value: 'images' }, // will need to fix for "Audios"
        { label: 'My Reactions', value: 'reactions' },
      ]}
      sx={() => ({
        [containerQuery.smallerThan('sm')]: {
          width: '100%',
        },
      })}
    />
  );
}
