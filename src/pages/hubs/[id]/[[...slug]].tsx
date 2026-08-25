import { Badge, Button, Center, Group, Loader, Menu, Text, Title } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconCopy, IconDotsVertical, IconPencil, IconShare3, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { HubsLayout } from '~/components/Hubs/HubsLayout';
import HubUpsertModal from '~/components/Hubs/HubUpsertModal';
import {
  useHubExcludedSources,
  useHubSessionBrowsingLevel,
} from '~/components/Hubs/hub-session.store';
import { buildDuplicateHubInput, hubUrl } from '~/components/Hubs/hub.utils';
import { useHubSort } from '~/components/Hubs/useHubSort';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { env } from '~/env/client';
import { userHubIsViewable } from '~/server/services/user-hub.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Availability } from '~/shared/utils/prisma/enums';
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

    const viewable = await userHubIsViewable({
      id,
      userId: session?.user?.id,
      isModerator: session?.user?.isModerator,
    });
    if (!viewable) return { notFound: true };
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

                {!hub.isOwner && (
                  <LoginRedirect reason="duplicate-hub">
                    <Button
                      size="compact-sm"
                      variant="default"
                      leftSection={<IconCopy size={16} />}
                      onClick={() =>
                        dialogStore.trigger({
                          component: HubUpsertModal,
                          props: {
                            duplicateOf: buildDuplicateHubInput({
                              name: hub.name,
                              sources: hub.sources,
                            }),
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

            {!hasSources ? (
              <Text c="dimmed">
                {hub.sources.length === 0
                  ? hub.isOwner
                    ? 'This hub is empty. Add a creator or a model from the rail to start filling it.'
                    : 'This hub has no sources yet.'
                  : 'Every source in this hub is switched off.'}
              </Text>
            ) : (
              // disableStoreFilters keeps the global image-filter store out of a hub:
              // the hub's own sort and period are what the user configured for it.
              <ImagesInfinite
                showEof
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
                  includePG13: hub.filters.includePG13,
                  // Omitted rather than sent empty: the hub stores [] to mean
                  // "no restriction", and the feed's filter does not.
                  types: hub.mediaTypes.length ? hub.mediaTypes : undefined,
                  // Both are this viewer's session state on a hub they do not own,
                  // and neither reaches the owner's row. Omitted for the owner,
                  // whose toggles are writes.
                  ...(hub.isOwner
                    ? {}
                    : {
                        ...(excludedSources.length ? { hubExcludedSources: excludedSources } : {}),
                        ...(sessionBrowsingLevel ? { browsingLevel: sessionBrowsingLevel } : {}),
                      }),
                }}
              />
            )}
          </div>
        </MasonryContainer>
      </>
    );
  },
  { InnerLayout: HubsLayout }
);
