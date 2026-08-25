import { Badge, Button, Center, Group, Loader, Menu, Stack, Text, Title } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconCopy, IconDotsVertical, IconPencil, IconShare3, IconTrash } from '@tabler/icons-react';
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
  useHubSessionIncludePG13,
} from '~/components/Hubs/hub-session.store';
import { buildDuplicateHubInput, hubUrl } from '~/components/Hubs/hub.utils';
import { useHubSort } from '~/components/Hubs/useHubSort';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Flags } from '~/shared/utils/flags';
import { env } from '~/env/client';
import { getUserHubForRoute } from '~/server/services/user-hub.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Availability } from '~/shared/utils/prisma/enums';
import { getCanonicalSlugDestination } from '~/utils/canonical-slug';
import { showErrorNotification } from '~/utils/notifications';
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
    });
    if (destination) return { redirect: { destination, permanent: false } };
  },
});

export default Page(
  function HubFeedPage() {
    const router = useRouter();
    const hubId = Number(router.query.id);
    const utils = trpc.useUtils();

    const { data: hub, isLoading } = trpc.userHub.getById.useQuery(
      { id: hubId },
      { enabled: Number.isInteger(hubId) }
    );

    const sort = useHubSort(hub?.sort);
    const excludedSources = useHubExcludedSources(hubId);
    const sessionBrowsingLevel = useHubSessionBrowsingLevel(hubId);
    const sessionIncludePG13 = useHubSessionIncludePG13(hubId);
    const currentUser = useCurrentUser();
    // What this viewer is actually allowed, after their account setting and the
    // domain cap. Compared against the hub's own cap below so a viewer who would see
    // an empty feed is told why rather than shown nothing.
    const viewerAllowedLevel = useBrowsingLevelDebounced();

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
    // Only on a hub you do not own. The owner's own level is their account setting,
    // and the hub's stored cap is applied server-side for everyone regardless.
    const viewerBrowsingLevel = hub.isOwner ? undefined : sessionBrowsingLevel;
    // The hub allows only levels this viewer cannot see. The feed would come back
    // empty and read as broken, so say what is actually happening.
    const levelLocksViewerOut =
      !!hub.forcedBrowsingLevel && !Flags.intersects(hub.forcedBrowsingLevel, viewerAllowedLevel);

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
                  <div className="mt-1">
                    <UserAvatar user={hub.user} withUsername linkToProfile size="sm" />
                  </div>
                )}
              </div>

              <Group gap={4} wrap="nowrap">
                {isPublic && (
                  <ShareButton url={`${env.NEXT_PUBLIC_BASE_URL}${hubUrl(hub)}`} title={hub.name}>
                    <Button
                      size="compact-sm"
                      variant="default"
                      leftSection={<IconShare3 size={16} />}
                    >
                      Share
                    </Button>
                  </ShareButton>
                )}

                {/* Not on a private hub a moderator opened to look at it: copying
                    someone's curation into your own account is a write, and 868kwp5kc
                    scopes moderator access to viewing. */}
                {!hub.isOwner && isPublic && (
                  <LoginRedirect reason="duplicate-hub">
                    <Button
                      size="compact-sm"
                      variant="default"
                      leftSection={<IconCopy size={16} />}
                      onClick={() =>
                        dialogStore.trigger({
                          component: HubUpsertModal,
                          props: {
                            duplicateOf: buildDuplicateHubInput(hub),
                          },
                        })
                      }
                    >
                      Duplicate
                    </Button>
                  </LoginRedirect>
                )}

                {hub.isOwner && (
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
              <Stack gap="xs" align="flex-start">
                <Text c="dimmed">
                  Nothing in this hub matches your content settings — its owner limited it to
                  ratings you have not enabled.
                </Text>
                {!currentUser && (
                  <LoginRedirect reason="view-content">
                    <Button size="compact-sm">Sign in to change your content settings</Button>
                  </LoginRedirect>
                )}
              </Stack>
            ) : !hasSources ? (
              <Text c="dimmed">
                {hub.sources.length === 0
                  ? hub.isOwner
                    ? 'This hub is empty. Add a creator or a model from the rail to start filling it.'
                    : 'This hub has no sources yet.'
                  : 'Every source in this hub is switched off.'}
              </Text>
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
                    period: hub.period,
                    // Enumerated so a key added to `hubFeedFiltersSchema` is a
                    // deliberate addition here too — `hubId` may only be combined
                    // with filters the index can serve (`requiresImageDbPath`).
                    baseModels: hub.filters.baseModels,
                    tools: hub.filters.tools,
                    techniques: hub.filters.techniques,
                    withMeta: hub.filters.withMeta,
                    fromPlatform: hub.filters.fromPlatform,
                    remixesOnly: hub.filters.remixesOnly,
                    nonRemixesOnly: hub.filters.nonRemixesOnly,
                    hideChallenges: hub.filters.hideChallenges,
                    // The owner's PG-13 opt-in is theirs. Handing it to a viewer lifts
                    // that viewer's own green-domain cap on the owner's say-so, so a
                    // viewer brings their own.
                    includePG13: hub.isOwner ? hub.filters.includePG13 : sessionIncludePG13,
                    // Omitted rather than sent empty: the hub stores [] to mean
                    // "no restriction", and the feed's filter does not.
                    types: hub.mediaTypes.length ? hub.mediaTypes : undefined,
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
