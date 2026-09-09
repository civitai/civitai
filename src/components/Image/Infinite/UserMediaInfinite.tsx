import type { SegmentedControlProps } from '@mantine/core';
import { Box, Center, Chip, Group, Loader, SegmentedControl, Stack } from '@mantine/core';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import React from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { SortFilter } from '~/components/Filters';
import { FeedContentToggle } from '~/components/FeedContentToggle/FeedContentToggle';
import type { MediaFilterKey } from '~/components/Image/Filters/media-filter-keys';
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

// Module constant, not an inline literal. It is a dep of `excluded`'s useMemo in
// MediaFiltersDropdown, which feeds `shows`, which this PR made a dep of
// `handleClear` — so a fresh array each render un-memoises `handleClear`,
// `showResources` and `showModerator`. `HubFeedFilters` already hoists its own
// for the same reason.
const PROFILE_EXCLUDED_FILTERS: MediaFilterKey[] = ['notPublished'];

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
      scheduled = undefined,
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
  const isModerator = currentUser?.isModerator ?? false;
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
                    // Clears `notPublished` on the way into Reactions. `replace`
                    // merges, and the Draft toggle hides itself there — so for a
                    // moderator, whose grant needs no creator scope, the tab
                    // silently became "unpublished images I reacted to" with the
                    // only control that could undo it no longer on screen.
                    onChange={(section) =>
                      replace(
                        section === 'reactions' ? { section, notPublished: undefined } : { section }
                      )
                    }
                  />
                )}
                {/* Drafts are the creator's own unpublished work, so the toggle
                    belongs to whoever may see it: the creator on their own
                    profile, and a moderator on anyone's. The server decides that
                    independently in `canRequestUnpublished` — this only decides
                    whether to offer the control. Hidden under Reactions, which is
                    a view of other people's posts. */}
                {(isSameUser || isModerator) && !viewingReactions && (
                  <FeedContentToggle
                    size="xs"
                    value={notPublished ? 'draft' : 'published'}
                    onChange={(value) =>
                      replace({ notPublished: value === 'draft' ? true : undefined })
                    }
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
                    notPublished,
                    scheduled,
                  }}
                  filterType={isVideo ? 'videos' : 'images'}
                  onChange={(filters) => replace(filters)}
                  size="compact-sm"
                  className="w-full justify-center"
                  hideMediaTypes
                  // The Published/Draft toggle above owns this on these two tabs,
                  // so the moderator chip would be a second control for the same
                  // state. Dropped HERE only — the chip is the sole way to reach
                  // unpublished content on /images, /videos, collections, tool
                  // feeds and model galleries, none of which have a toggle.
                  exclude={PROFILE_EXCLUDED_FILTERS}
                  isSameUser={isSameUser}
                />
              </Group>
            </Group>
            {userLoading ? (
              <Center p="xl">
                <Loader />
              </Center>
            ) : !user ? (
              <NoContent />
            ) : (
              <ImagesInfinite
                filterType={isVideo ? 'videos' : 'images'}
                // The store merge keeps any key these overrides don't mention, and
                // every one of them ANDs against this tab's single user.
                disableStoreFilters
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
                  notPublished: viewingReactions ? undefined : notPublished,
                  scheduled,
                  followed,
                  baseModels,
                  tools,
                  techniques,
                  requiringMeta,
                  // pending: true,
                }}
                showEmptyCta={isSameUser}
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
