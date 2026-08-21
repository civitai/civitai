import { Center, Group, Loader, Menu, Text, Title } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconDotsVertical, IconPencil, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { HubsLayout } from '~/components/Hubs/HubsLayout';
import HubUpsertModal from '~/components/Hubs/HubUpsertModal';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { ImageSort } from '~/server/common/enums';
import { hubSortSchema } from '~/server/schema/user-hub.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features }) => {
    if (!features?.userHubs) return { notFound: true };
    if (!session?.user) return { redirect: { destination: '/login', permanent: false } };
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

    const deleteMutation = trpc.userHub.delete.useMutation({
      onSuccess: async () => {
        const remaining = await utils.userHub.getAll.fetch(undefined, { staleTime: 0 });
        await router.replace(remaining.length ? `/hubs/${remaining[0].id}` : '/hubs');
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

    const sort = hubSortSchema.catch(ImageSort.Newest).parse(hub.sort);
    const hasSources = hub.sources.some((s) => s.enabled);

    return (
      <>
        <Meta title={`${hub.name} | Civitai`} deIndex />
        {/* Same container the feed itself renders in, so the title lines up with
            the first card instead of hugging the rail. */}
        <MasonryContainer className="min-h-full">
          <div className="flex flex-col gap-3 py-3">
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <div className="min-w-0">
                <Title order={1} lineClamp={2}>
                  {hub.name}
                </Title>
                {!!hub.description && (
                  <Text c="dimmed" size="sm">
                    {hub.description}
                  </Text>
                )}
              </div>
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
                            Its sources go with it and this cannot be undone. The images stay where
                            they are.
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
            </Group>

            {!hasSources ? (
              <Text c="dimmed">
                {hub.sources.length === 0
                  ? 'This hub is empty. Add a creator or a model from the rail to start filling it.'
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
                  // Named key by key rather than spread: `hubId` may only be
                  // combined with filters the search index can serve, and a
                  // spread of stored JSON is how a DB-forcing key gets back in.
                  baseModels: hub.filters.baseModels,
                  tools: hub.filters.tools,
                  techniques: hub.filters.techniques,
                  withMeta: hub.filters.withMeta,
                  fromPlatform: hub.filters.fromPlatform,
                  remixesOnly: hub.filters.remixesOnly,
                  nonRemixesOnly: hub.filters.nonRemixesOnly,
                  hideChallenges: hub.filters.hideChallenges,
                  // Stored on the hub and empty by default; an empty list means
                  // "every type", which is what omitting the filter does.
                  types: hub.mediaTypes.length ? hub.mediaTypes : undefined,
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
