import { Center, Loader, Stack, Tabs } from '@mantine/core';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import {
  useMutateCreatorShop,
  useQueryCreatorShopManage,
  useQueryCreatorShopResaleStats,
  useQueryCreatorShopSettings,
} from '~/components/CreatorShop/creator-shop.util';
import { ManageEmptyState } from '~/components/CreatorShop/Manage/ManageEmptyState';
import { ManageHeader } from '~/components/CreatorShop/Manage/ManageHeader';
import { ManageItemsTable } from '~/components/CreatorShop/Manage/ManageItemsTable';
import { ManageStats } from '~/components/CreatorShop/Manage/ManageStats';
import { ManageToolbar } from '~/components/CreatorShop/Manage/ManageToolbar';
import { PublishShopBanner } from '~/components/CreatorShop/Manage/PublishShopBanner';
import { useManageItems } from '~/components/CreatorShop/Manage/manage.util';
import { ManageServicesPanel } from '~/components/CreatorShop/Services/ManageServicesPanel';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: false,
  resolver: async ({ ctx, features }) => {
    const username = ctx.query.username as string;
    if (!features?.creatorShop)
      return { redirect: { destination: `/user/${username}`, permanent: false } };
  },
});

function ManageShopPage() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const username = (router.query.username as string) ?? '';
  const isOwner =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);
  const isModerator = currentUser?.isModerator ?? false;
  const canManage = isOwner || isModerator;
  const features = useFeatureFlags();
  // Services are managed by their seller only; a moderator managing someone else's shop sees cosmetics.
  const showServicesTab = features.creatorServices && isOwner;
  const tab = showServicesTab && router.query.tab === 'services' ? 'services' : 'cosmetics';
  const setTab = (value: string | null) =>
    router.replace(
      { query: { ...router.query, tab: value === 'services' ? 'services' : undefined } },
      undefined,
      { shallow: true }
    );

  const { data: user } = trpc.userProfile.get.useQuery({ username }, { enabled: !!username });
  // Moderators manage another creator's shop by passing that creator's userId;
  // owners omit it and the server uses their own id.
  const manageUserId = isOwner ? undefined : user?.id;
  const queriesEnabled = isOwner || (isModerator && !!user?.id);

  const { items, isLoading } = useQueryCreatorShopManage(queriesEnabled, manageUserId);
  const { settings } = useQueryCreatorShopSettings(queriesEnabled, manageUserId);
  const { resaleStats } = useQueryCreatorShopResaleStats(queriesEnabled, manageUserId);
  const { archiveItem, setItemListed, unarchiveItem, deleteItem, updateSettings } =
    useMutateCreatorShop();
  const { status, setStatus, search, setSearch, sort, setSort, filtered, stats } =
    useManageItems(items);

  if (!username) return <NotFound />;
  if (currentUser && !canManage) return <NotFound />;

  const showControls = !isLoading && items.length > 0;

  const cosmetics = (
    <Stack gap="lg">
      {showControls && <ManageStats stats={stats} resaleStats={resaleStats} />}

      {showControls && (
        <ManageToolbar
          status={status}
          onStatusChange={setStatus}
          search={search}
          onSearchChange={setSearch}
          sort={sort}
          onSortChange={setSort}
        />
      )}

      {isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : filtered.length === 0 ? (
        <ManageEmptyState hasItems={items.length > 0} />
      ) : (
        <ManageItemsTable
          items={filtered}
          archiveItem={archiveItem}
          setItemListed={setItemListed}
          unarchiveItem={unarchiveItem}
          deleteItem={deleteItem}
        />
      )}
    </Stack>
  );

  return (
    <Stack gap="lg" mt="md" pb="xl">
      <ManageHeader
        canAddItems={isOwner}
        targetUserId={manageUserId}
        backHref={`/user/${username}/shop`}
      />

      {settings && settings.enabled !== true && (
        <PublishShopBanner
          cosmeticCount={items.length}
          cosmeticsLoading={isLoading}
          servicesCount={showServicesTab}
          onEnable={() => updateSettings.mutate({ enabled: true, userId: manageUserId })}
          enabling={updateSettings.isPending}
        />
      )}

      {showServicesTab ? (
        <Tabs value={tab} onChange={setTab} keepMounted={false}>
          <Tabs.List mb="lg">
            <Tabs.Tab value="cosmetics">Cosmetics</Tabs.Tab>
            <Tabs.Tab value="services">Services</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="cosmetics">{cosmetics}</Tabs.Panel>
          <Tabs.Panel value="services">
            <ManageServicesPanel
              unpublishedShop={
                settings && settings.enabled !== true
                  ? {
                      onPublish: () =>
                        updateSettings.mutate({ enabled: true, userId: manageUserId }),
                      publishing: updateSettings.isPending,
                    }
                  : undefined
              }
            />
          </Tabs.Panel>
        </Tabs>
      ) : (
        cosmetics
      )}
    </Stack>
  );
}

export default Page(ManageShopPage, { getLayout: UserProfileLayout });
