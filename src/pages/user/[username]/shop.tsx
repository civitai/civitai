import { Center, Loader, Stack } from '@mantine/core';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { constants } from '~/server/common/constants';
import {
  useMutateCreatorShop,
  useQueryCreatorShop,
} from '~/components/CreatorShop/creator-shop.util';
import { ShopDraftBanner } from '~/components/CreatorShop/Manage/ShopDraftBanner';
import { EmptyShopState } from '~/components/CreatorShop/Storefront/EmptyShopState';
import { ShopHeader } from '~/components/CreatorShop/Storefront/ShopHeader';
import { StorefrontSections } from '~/components/CreatorShop/Storefront/StorefrontSections';
import { useOwnedCosmeticIds } from '~/components/CreatorShop/Storefront/storefront.util';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, features, ssg }) => {
    const username = ctx.query.username as string;
    if (!features?.creatorShop)
      return { redirect: { destination: `/user/${username}`, permanent: false } };

    const user = await dbRead.user.findUnique({ where: { username }, select: { bannedAt: true } });
    if (user?.bannedAt) return { redirect: { destination: `/user/${username}`, permanent: true } };

    await Promise.all([
      ssg?.userProfile.get.prefetch({ username }),
      ssg?.userProfile.overview.prefetch({ username }),
    ]);
  },
});

function UserShopPage() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const username = (router.query.username as string) ?? '';
  const { data: user } = trpc.userProfile.get.useQuery({ username }, { enabled: !!username });
  const { shop, isLoading, isError } = useQueryCreatorShop(user?.id);
  const { updateSettings } = useMutateCreatorShop();
  const ownedCosmeticIds = useOwnedCosmeticIds();

  const isOwner =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);

  if (!username) return <NotFound />;
  // A disabled shop returns NOT_FOUND to visitors — stay quiet about it.
  if (isError) return <NotFound />;

  const baseUrl = `/user/${username}`;
  const displayName = user?.username ?? username;
  const isEmpty = !isLoading && (shop?.cosmetics.length ?? 0) === 0;

  return (
    <MasonryProvider
      columnWidth={constants.cardSizes.model}
      maxColumnCount={7}
      maxSingleColumnWidth={450}
    >
      <MasonryContainer p={0} mt="md" pb="xl">
        <Stack gap="xl">
          <ShopHeader
            displayName={displayName}
            description={shop?.settings.description}
            isOwner={isOwner}
            baseUrl={baseUrl}
          />

          {isOwner && shop && shop.settings.enabled !== true && (
            <ShopDraftBanner
              onEnable={() => updateSettings.mutate({ enabled: true })}
              enabling={updateSettings.isPending}
            />
          )}

          {isLoading ? (
            <Center py="xl">
              <Loader />
            </Center>
          ) : !shop || isEmpty ? (
            <EmptyShopState isOwner={isOwner} displayName={displayName} baseUrl={baseUrl} />
          ) : (
            <StorefrontSections
              shop={shop}
              ownedCosmeticIds={ownedCosmeticIds}
              displayName={displayName}
              username={username}
              ownerUserId={user?.id ?? 0}
              baseUrl={baseUrl}
            />
          )}
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}

export default Page(UserShopPage, { getLayout: UserProfileLayout });
