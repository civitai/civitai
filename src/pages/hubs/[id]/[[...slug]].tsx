import {
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Menu,
  Popover,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { IconDotsVertical, IconPencil, IconShare3, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import {
  BrowsingLevelProviderOptional,
  useBrowsingLevelDebounced,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { Page } from '~/components/AppLayout/Page';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { HubsLayout } from '~/components/Hubs/HubsLayout';
import HubUpsertModal from '~/components/Hubs/HubUpsertModal';
import {
  useHubExcludedSources,
  useHubSessionBrowsingLevel,
  useHubSessionFeedFilters,
  useHubSessionIncludePG13,
} from '~/components/Hubs/hub-session.store';
import { FollowHubButton } from '~/components/Hubs/FollowHubButton';
import {
  canPublishHub,
  hubEffectiveLevel,
  hubLocksViewerOut,
  hubUrl,
  useInvalidateHub,
} from '~/components/Hubs/hub.utils';
import { useHubSort } from '~/components/Hubs/useHubSort';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { BrowsingModeMenu } from '~/components/BrowsingMode/BrowsingMode';
import { NoContent } from '~/components/NoContent/NoContent';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getUserHubForRoute } from '~/server/services/user-hub.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Availability } from '~/shared/utils/prisma/enums';
import { getCanonicalSlugDestination } from '~/utils/canonical-slug';
import { buildPassthroughQuery } from '~/utils/query-string-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx, session, features }) => {
    if (!features?.userHubs) return { notFound: true };

    // No session check: a public hub opens for anyone holding the link, signed out
    // included. The visibility check is the same one the tRPC read uses, done here
    // so that a link whose hub went back to private is a real 404 rather than a 200
    // carrying a not-found component. A private hub and a hub that never existed
    // are the same answer, so this confirms nothing to a stranger.
    const id = Number(ctx.params?.id);
    if (!Number.isInteger(id)) return { notFound: true };

    const hub = await getUserHubForRoute({
      id,
      userId: session?.user?.id,
      isModerator: session?.user?.isModerator,
    });
    if (!hub) return { notFound: true };

    // Same canonicalisation both other `[[...slug]]` routes use, including its
    // empty-slug redirect-loop guard. Without it a hub renders at any slug and the
    // links people share never converge on one URL.
    const slug = ctx.params?.slug;
    const destination = getCanonicalSlugDestination({
      basePath: '/hubs',
      id,
      title: hub.name,
      currentSlug: Array.isArray(slug) ? slug.join('/') : slug,
      // Every other `[[...slug]]` route passes this. Without it the redirect strips
      // whatever a share surface appended to the link it just handed out.
      queryString: buildPassthroughQuery(ctx.query),
    });
    if (destination) return { redirect: { destination, permanent: false } };
  },
});

// Centred in the feed's own column and only as wide as it needs to be, so an empty
// hub reads as a state rather than as a page that failed to load.
function HubEmptyState({ message, children }: { message: string; children?: React.ReactNode }) {
  return (
    <div className="my-6 flex justify-center">
      <Card withBorder radius="md" p="xl" className="max-w-md">
        <NoContent message={message} iconSize={72}>
          {children}
        </NoContent>
      </Card>
    </div>
  );
}

/**
 * The way out of a hub whose cap you cannot see past. It opens the browsing-level
 * menu rather than linking to account settings — that page is enormous and the level
 * picker is one control on it.
 *
 * Offered only when that menu would actually contain the picker: `BrowsingModeMenu`
 * renders it under `showNsfw && canViewNsfw`, so on green, or with mature content
 * switched off, the button would open a menu that cannot change the answer. Those
 * viewers get the explanation and nothing to press.
 */
function AdjustBrowsingLevelButton() {
  const features = useFeatureFlags();
  const showNsfw = useBrowsingSettings((state) => state.showNsfw);
  if (!features.canViewNsfw || !showNsfw) return null;

  return (
    // No `width`: the menu carries its own `sm:min-w-96`, so any fixed width below
    // that overflows the dropdown. Same configuration the header's browsing-mode
    // popover uses to render this menu.
    <Popover withArrow withinPortal position="top">
      <Popover.Target>
        <Button variant="light">Adjust your browsing level</Button>
      </Popover.Target>
      <Popover.Dropdown p="md">
        <BrowsingModeMenu />
      </Popover.Dropdown>
    </Popover>
  );
}

export default Page(
  function HubFeedPage() {
    const router = useRouter();
    const hubId = Number(router.query.id);
    const utils = trpc.useUtils();

    const { data: hub, isLoading } = trpc.userHub.getById.useQuery(
      { id: hubId },
      { enabled: Number.isInteger(hubId) }
    );

    const excludedSources = useHubExcludedSources(hubId);
    const sessionBrowsingLevel = useHubSessionBrowsingLevel(hubId);
    const sessionIncludePG13 = useHubSessionIncludePG13(hubId);
    const sessionFilters = useHubSessionFeedFilters(hubId);
    const currentUser = useCurrentUser();
    const invalidateHub = useInvalidateHub();

    // A viewer's sort and filter choices are session state; the owner's are the row.
    const isOwner = !!hub?.isOwner;
    const feed = {
      sort: isOwner ? hub?.sort : sessionFilters.sort ?? hub?.sort,
      period: isOwner ? hub?.period : sessionFilters.period ?? hub?.period,
      types: isOwner ? hub?.mediaTypes : sessionFilters.types ?? hub?.mediaTypes,
      filters: isOwner ? hub?.filters : sessionFilters.filters ?? hub?.filters,
    };
    const sort = useHubSort(feed.sort);
    // What this viewer is actually allowed, after their account setting and the
    // domain cap. Compared against the hub's own cap below so a viewer who would see
    // an empty feed is told why rather than shown nothing.
    const viewerAllowedLevel = useBrowsingLevelDebounced();

    const clipboard = useClipboard();
    const shareMutation = trpc.userHub.upsert.useMutation({
      onSuccess: async (saved) => {
        await invalidateHub(saved.id);
        // Copied on the spot: the reason to press this was to hand someone a link,
        // and making them press Share again for it is a second step for nothing.
        clipboard.copy(`${window.location.origin}${hubUrl(saved)}`);
        showSuccessNotification({
          title: 'Sharing is on',
          message: 'The link is on your clipboard. Anyone you give it to can view this hub.',
        });
      },
      onError: (error) =>
        showErrorNotification({ title: 'Could not share hub', error: new Error(error.message) }),
    });

    const deleteMutation = trpc.userHub.delete.useMutation({
      onSuccess: async () => {
        const remaining = await utils.userHub.getAll.fetch(undefined, { staleTime: 0 });
        await router.replace(remaining.length ? hubUrl(remaining[0]) : '/hubs');
      },
      onError: (error) =>
        showErrorNotification({ title: 'Could not delete hub', error: new Error(error.message) }),
    });

    if (isLoading)
      return (
        <Center py="xl">
          <Loader />
        </Center>
      );
    if (!hub) return <NotFound />;

    const hasSources = hub.sources.some((s) => s.enabled);
    const isPublic = hub.availability === Availability.Public;
    const canManage = hub.isOwner || !!currentUser?.isModerator;
    // Only on a hub you do not own. The owner's own level is their account setting,
    // and the hub's stored cap is applied server-side for everyone regardless.
    const viewerBrowsingLevel = hub.isOwner ? undefined : sessionBrowsingLevel;
    // The hub allows only levels this viewer cannot see. The feed would come back
    // empty and read as broken, so say what is actually happening.
    // The level the FEED will actually run at — session override if the viewer set
    // one, otherwise their own. Computing the banner from a different number than
    // the query is how it ends up disagreeing with what is on screen.
    const effectiveLevel = hubEffectiveLevel(viewerBrowsingLevel, viewerAllowedLevel);
    const levelLocksViewerOut = hubLocksViewerOut(hub.forcedBrowsingLevel, effectiveLevel);

    return (
      <>
        <Meta title={`${hub.name} | Civitai`} deIndex />
        {/* Same container the feed itself renders in, so the title lines up with
            the first card instead of hugging the rail. */}
        <MasonryContainer className="min-h-full">
          <div className="flex flex-col gap-3 py-3">
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <div className="min-w-0">
                <Group gap="xs" wrap="nowrap">
                  <Title order={1} lineClamp={2}>
                    {hub.name}
                  </Title>
                  {hub.isOwner && isPublic && (
                    <Badge variant="light" color="green">
                      Public
                    </Badge>
                  )}
                </Group>
                {!!hub.description && (
                  <Text c="dimmed" size="sm">
                    {hub.description}
                  </Text>
                )}
                {!hub.isOwner && !!hub.user && (
                  <Group gap={8} wrap="nowrap" mt={4}>
                    <UserAvatar user={hub.user} withUsername linkToProfile size="sm" />
                  </Group>
                )}
              </div>

              <Group gap={4} wrap="nowrap">
                {/* ShareButton is given a PATH, not an absolute URL: it prefixes
                    `location.protocol//location.host` itself. */}
                {isPublic ? (
                  <ShareButton url={hubUrl(hub)} title={hub.name}>
                    <Tooltip label="Share" withinPortal>
                      <LegacyActionIcon variant="subtle" aria-label="Share hub">
                        <IconShare3 size={18} />
                      </LegacyActionIcon>
                    </Tooltip>
                  </ShareButton>
                ) : (
                  // Sharing is the point of the button, so it is here rather than
                  // behind Edit. On a private hub it asks first, because pressing it
                  // is what makes the hub readable by anyone holding the link.
                  canPublishHub(hub) && (
                    <Tooltip label="Share" withinPortal>
                      <LegacyActionIcon
                        variant="subtle"
                        aria-label="Share hub"
                        loading={shareMutation.isPending}
                        onClick={() =>
                          openConfirmModal({
                            title: 'Share this hub?',
                            children: (
                              <Text size="sm">
                                This hub is private. Sharing it makes it viewable by anyone you give
                                the link to. You can turn sharing back off at any time, and every
                                link you handed out stops working.
                              </Text>
                            ),
                            labels: { cancel: 'Cancel', confirm: 'Turn on sharing' },
                            onConfirm: () =>
                              shareMutation.mutate({
                                id: hub.id,
                                availability: Availability.Public,
                              }),
                          })
                        }
                      >
                        <IconShare3 size={18} />
                      </LegacyActionIcon>
                    </Tooltip>
                  )
                )}

                {/* Not on a private hub a moderator opened to look at it: copying
                    someone's curation into your own account is a write, and 868kwp5kc
                    scopes moderator access to viewing. */}
                {/* Following is the alternative to keeping the link somewhere: it
                    puts the hub in your own sidebar. Hidden for the owner, whose hubs
                    are already listed above it. */}
                <FollowHubButton hub={hub} iconOnly />

                {/* Moderators get the context menu on any hub — Justin's call, and it
                    answers the question 868kwp5kc parked. Deliberate acts only: their
                    source toggles and level picks stay session state, so opening a
                    hub to look at it cannot quietly rewrite it. */}
                {canManage && (
                  <Menu withinPortal position="bottom-end">
                    <Menu.Target>
                      <LegacyActionIcon variant="subtle" aria-label="Hub options">
                        <IconDotsVertical size={20} />
                      </LegacyActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconPencil size={16} />}
                        onClick={() =>
                          dialogStore.trigger({ component: HubUpsertModal, props: { hub } })
                        }
                      >
                        Edit hub
                      </Menu.Item>
                      <Menu.Item
                        color="red"
                        leftSection={<IconTrash size={16} />}
                        onClick={() =>
                          openConfirmModal({
                            title: `Delete "${hub.name}"?`,
                            children: (
                              <Text size="sm">
                                Its sources go with it and this cannot be undone. The images stay
                                where they are.
                              </Text>
                            ),
                            labels: { cancel: 'Cancel', confirm: 'Delete hub' },
                            confirmProps: { color: 'red' },
                            onConfirm: () => deleteMutation.mutate({ id: hub.id }),
                          })
                        }
                      >
                        Delete hub
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                )}
              </Group>
            </Group>

            {levelLocksViewerOut ? (
              <HubEmptyState message="Its owner limited this hub to content ratings you have not enabled.">
                {currentUser ? (
                  <AdjustBrowsingLevelButton />
                ) : (
                  <LoginRedirect reason="view-content">
                    <Button>Sign in to change your content settings</Button>
                  </LoginRedirect>
                )}
              </HubEmptyState>
            ) : !hasSources ? (
              <HubEmptyState
                message={
                  hub.sources.length === 0
                    ? hub.isOwner
                      ? 'This hub is empty. Add a creator or a model from the sidebar to start filling it.'
                      : 'This hub has no sources yet.'
                    : 'Every source in this hub is switched off.'
                }
              />
            ) : (
              // The same mechanism a collection uses for its forced level
              // (Collection.tsx) — an entity carrying a content level for its own feed
              // and nowhere else. Passing it as a feed filter does NOT work:
              // `ImagesInfinite` spreads its own computed level over the caller's.
              <BrowsingLevelProviderOptional browsingLevel={viewerBrowsingLevel}>
                <ImagesInfinite
                  showEof
                  // Keeps the global image-filter store out of a hub: the hub's own
                  // sort and period are what the user configured for it.
                  disableStoreFilters
                  filters={{
                    hubId: hub.id,
                    sort,
                    period: feed.period,
                    // Enumerated so a key added to `hubFeedFiltersSchema` is a
                    // deliberate addition here too — `hubId` may only be combined
                    // with filters the index can serve (`requiresImageDbPath`).
                    baseModels: feed.filters?.baseModels,
                    tools: feed.filters?.tools,
                    techniques: feed.filters?.techniques,
                    withMeta: feed.filters?.withMeta,
                    fromPlatform: feed.filters?.fromPlatform,
                    remixesOnly: feed.filters?.remixesOnly,
                    nonRemixesOnly: feed.filters?.nonRemixesOnly,
                    hideChallenges: feed.filters?.hideChallenges,
                    // The owner's PG-13 opt-in is theirs. Handing it to a viewer lifts
                    // that viewer's own green-domain cap on the owner's say-so, so a
                    // viewer brings their own.
                    includePG13: hub.isOwner ? hub.filters.includePG13 : sessionIncludePG13,
                    // Omitted rather than sent empty: the hub stores [] to mean
                    // "no restriction", and the feed's filter does not.
                    types: feed.types?.length ? feed.types : undefined,
                    // This viewer's session state on a hub they do not own, which never
                    // reaches the owner's row. Omitted for the owner, whose toggles are
                    // writes. The session LEVEL is not here — `ImagesInfinite` computes
                    // its own and spreads it over whatever a caller passes, so it goes
                    // through `BrowsingLevelProvider` below instead.
                    ...(hub.isOwner || !excludedSources.length
                      ? {}
                      : { hubExcludedSources: excludedSources }),
                  }}
                />
              </BrowsingLevelProviderOptional>
            )}
          </div>
        </MasonryContainer>
      </>
    );
  },
  { InnerLayout: HubsLayout }
);
