import type { SegmentedControlProps } from '@mantine/core';
import { Box, Center, Chip, Group, Loader, SegmentedControl, Stack } from '@mantine/core';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import React from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { SortFilter } from '~/components/Filters';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import type { ImageSections } from '~/components/Image/image.utils';
import { useImageQueryParams } from '~/components/Image/image.utils';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import { postgresSlugify, titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import classes from './UserMediaInfinite.module.css';

const availableReactions = Object.keys(constants.availableReactions) as ReviewReactions[];

export function UserMediaInfinite({ type = MediaType.image }: { type: MediaType }) {
  const currentUser = useCurrentUser();

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
      requiringMeta = false,
      notPublished = undefined,
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
          <Stack gap="xs">
            <Group gap={8} justify="space-between">
              <Group gap={8}>
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
                    value={reactions ?? []}
                    onChange={(reactions) => replace({ reactions: reactions as ReviewReactions[] })}
                    multiple
                  >
                    <Group gap={4} wrap="nowrap" className={classes.chipGroup}>
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
                    </Group>
                    {/* TODO add "hide owned" */}
                  </Chip.Group>
                )}
              </Group>
              <Group className={classes.filtersWrapper} gap={8} wrap="nowrap">
                <SortFilter
                  className="justify-center"
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
                    requiringMeta,
                  }}
                  filterType={isVideo ? 'videos' : 'images'}
                  onChange={(filters) => replace(filters)}
                  size="compact-sm"
                  className="w-full justify-center"
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
                  notPublished,
                  followed,
                  baseModels,
                  tools,
                  techniques,
                  requiringMeta,
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
      onChange={(v) => onChange(v as ImageSections)}
      data={[
        { label: `My ${titleCase(type)}s`, value: 'images' }, // will need to fix for "Audios"
        { label: 'My Reactions', value: 'reactions' },
      ]}
      className="w-full sm:w-auto"
    />
  );
}
