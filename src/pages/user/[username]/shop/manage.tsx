import { Center, Loader, Stack } from '@mantine/core';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import {
  useMutateCreatorShop,
  useQueryCreatorShopManage,
  useQueryCreatorShopSettings,
} from '~/components/CreatorShop/creator-shop.util';
import { ManageEmptyState } from '~/components/CreatorShop/Manage/ManageEmptyState';
import { ManageHeader } from '~/components/CreatorShop/Manage/ManageHeader';
import { ManageItemsTable } from '~/components/CreatorShop/Manage/ManageItemsTable';
import { ManageStats } from '~/components/CreatorShop/Manage/ManageStats';
import { ManageToolbar } from '~/components/CreatorShop/Manage/ManageToolbar';
import { ManageUpsell } from '~/components/CreatorShop/Manage/ManageUpsell';
import { ShopDraftBanner } from '~/components/CreatorShop/Manage/ShopDraftBanner';
import { useManageItems } from '~/components/CreatorShop/Manage/manage.util';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { useCurrentUser } from '~/hooks/useCurrentUser';
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

  const { data: requirements, isLoading: reqsLoading } =
    trpc.creatorProgram.getCreatorRequirements.useQuery(undefined, { enabled: isOwner });
  const eligible = !!requirements?.validMembership;

  const { items, isLoading } = useQueryCreatorShopManage(isOwner);
  const { settings } = useQueryCreatorShopSettings(isOwner);
  const { archiveItem, updateSettings } = useMutateCreatorShop();
  const { status, setStatus, search, setSearch, sort, setSort, filtered, stats } =
    useManageItems(items);

  if (!username) return <NotFound />;
  if (currentUser && !isOwner) return <NotFound />;

  // Creator Shop is a Creator Program member benefit — upsell everyone else.
  if (reqsLoading)
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  if (requirements && !eligible) return <ManageUpsell />;

  const showControls = !isLoading && items.length > 0;

  return (
    <Stack gap="lg" mt="md" pb="xl">
      <ManageHeader />

      {settings && settings.enabled !== true && (
        <ShopDraftBanner
          onEnable={() => updateSettings.mutate({ enabled: true })}
          enabling={updateSettings.isPending}
        />
      )}

      {showControls && <ManageStats stats={stats} />}

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
        <ManageItemsTable items={filtered} archiveItem={archiveItem} />
      )}
    </Stack>
  );
}

export default Page(ManageShopPage, { getLayout: UserProfileLayout });
