import { Center, Loader, Stack } from '@mantine/core';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
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
import { ShopDraftBanner } from '~/components/CreatorShop/Manage/ShopDraftBanner';
import { useManageItems } from '~/components/CreatorShop/Manage/manage.util';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { OnboardingSteps } from '~/server/common/enums';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Flags } from '~/shared/utils/flags';
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

  const { data: user } = trpc.userProfile.get.useQuery({ username }, { enabled: !!username });
  // Moderators manage another creator's shop by passing that creator's userId;
  // owners omit it and the server uses their own id.
  const manageUserId = isOwner ? undefined : user?.id;
  const queriesEnabled = isOwner || (isModerator && !!user?.id);

  // Membership = the creator has joined the program (a valid subscription alone
  // isn't enough). The upsell lives on the storefront — send a non-member owner
  // there instead of showing them the (unusable) manage page.
  const isCreatorProgramMember =
    !!currentUser && Flags.hasFlag(currentUser.onboarding ?? 0, OnboardingSteps.CreatorProgram);

  useEffect(() => {
    if (isOwner && !isCreatorProgramMember) router.replace(`/user/${username}/shop`);
  }, [isOwner, isCreatorProgramMember, username, router]);

  const { items, isLoading } = useQueryCreatorShopManage(queriesEnabled, manageUserId);
  const { settings } = useQueryCreatorShopSettings(queriesEnabled, manageUserId);
  const { archiveItem, unarchiveItem, deleteItem, updateSettings } = useMutateCreatorShop();
  const { status, setStatus, search, setSearch, sort, setSort, filtered, stats } =
    useManageItems(items);

  if (!username) return <NotFound />;
  if (currentUser && !canManage) return <NotFound />;

  // Creator Shop is a Creator Program member benefit — a non-member owner is
  // redirected to the storefront (see the effect above); moderators may manage
  // any shop regardless.
  if (isOwner && !isCreatorProgramMember)
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );

  const showControls = !isLoading && items.length > 0;

  return (
    <Stack gap="lg" mt="md" pb="xl">
      <ManageHeader
        canAddItems={isOwner}
        targetUserId={manageUserId}
        backHref={`/user/${username}/shop`}
      />

      {settings && settings.enabled !== true && (
        <ShopDraftBanner
          onEnable={() => updateSettings.mutate({ enabled: true, userId: manageUserId })}
          enabling={updateSettings.isPending}
          disabledReason={
            !isLoading && items.length === 0
              ? 'Add at least one item before publishing your shop.'
              : undefined
          }
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
        <ManageItemsTable
          items={filtered}
          archiveItem={archiveItem}
          unarchiveItem={unarchiveItem}
          deleteItem={deleteItem}
        />
      )}
    </Stack>
  );
}

export default Page(ManageShopPage, { getLayout: UserProfileLayout });
