import { Alert, Center, Loader, Stack } from '@mantine/core';
import { IconEye } from '@tabler/icons-react';
import { useState } from 'react';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import {
  useMutateCreatorShop,
  useQueryCreatorShop,
} from '~/components/CreatorShop/creator-shop.util';
import { ManageUpsell } from '~/components/CreatorShop/Manage/ManageUpsell';
import { ShopDraftBanner } from '~/components/CreatorShop/Manage/ShopDraftBanner';
import { EmptyShopState } from '~/components/CreatorShop/Storefront/EmptyShopState';
import { ShopHeader } from '~/components/CreatorShop/Storefront/ShopHeader';
import { StorefrontSections } from '~/components/CreatorShop/Storefront/StorefrontSections';
import { useOwnedCosmeticIds } from '~/components/CreatorShop/Storefront/storefront.util';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { OnboardingSteps } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { Flags } from '~/shared/utils/flags';
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
  const isModerator = currentUser?.isModerator ?? false;
  const username = (router.query.username as string) ?? '';
  const { data: user } = trpc.userProfile.get.useQuery({ username }, { enabled: !!username });
  // Moderator-only preview: fill every section with site-wide sample data for
  // design work, regardless of whether this creator has set their shop up.
  const [preview, setPreview] = useState(false);
  const { shop, isLoading, isError } = useQueryCreatorShop(user?.id, isModerator && preview);
  const { updateSettings } = useMutateCreatorShop();
  const ownedCosmeticIds = useOwnedCosmeticIds();

  const isOwner =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);
  const canManage = isOwner || isModerator;

  // The Creator Shop is a Creator Program benefit — an owner who hasn't joined
  // the program (a valid subscription alone isn't enough) sees the upsell here
  // on their storefront rather than on the manage page.
  const isCreatorProgramMember =
    !!currentUser && Flags.hasFlag(currentUser.onboarding ?? 0, OnboardingSteps.CreatorProgram);

  if (!username) return <NotFound />;
  // A disabled shop returns NOT_FOUND to visitors — stay quiet about it.
  // Moderators bypass the gates below so they can view/manage any creator's shop.
  if (isError && !isModerator) return <NotFound />;
  if (!isModerator) {
    if (isOwner && !isCreatorProgramMember) return <ManageUpsell />;
    if (!isOwner && !isCreatorProgramMember) return <NotFound />;
  }

  const baseUrl = `/user/${username}`;
  const displayName = user?.username ?? username;
  const isEmpty = !isLoading && (shop?.cosmetics.length ?? 0) === 0;

  // The header/banners and non-Featured sections are constrained to a max width
  // and centered; the outer wrapper stays full-width so the Featured section can
  // bleed its background to the page edges.
  const constrained = 'mx-auto w-full max-w-[1600px]';

  return (
    <div className="mt-4 w-full pb-12">
      <Stack gap="xl">
        <div className={constrained}>
          <Stack gap="xl">
            <ShopHeader
              displayName={displayName}
              description={shop?.settings.description}
              isOwner={isOwner}
              canManage={canManage}
              baseUrl={baseUrl}
              isModerator={isModerator}
              preview={preview}
              onTogglePreview={() => setPreview((v) => !v)}
            />

            {isModerator && preview && (
              <Alert color="yellow" variant="light" icon={<IconEye size={16} />}>
                Preview mode — sections are filled with site-wide sample cosmetics and models for
                design work. This is not {displayName}&apos;s real shop; don&apos;t purchase from
                preview, as buys would resolve against these sample items.
              </Alert>
            )}

            {isOwner && shop && shop.settings.enabled !== true && (
              <ShopDraftBanner
                onEnable={() => updateSettings.mutate({ enabled: true })}
                enabling={updateSettings.isPending}
              />
            )}
          </Stack>
        </div>

        {isLoading ? (
          <div className={constrained}>
            <Center py="xl">
              <Loader />
            </Center>
          </div>
        ) : !shop || isEmpty ? (
          <div className={constrained}>
            <EmptyShopState isOwner={isOwner} displayName={displayName} baseUrl={baseUrl} />
          </div>
        ) : (
          <StorefrontSections
            shop={shop}
            ownedCosmeticIds={ownedCosmeticIds}
            username={username}
            ownerUserId={user?.id ?? 0}
            preview={isModerator && preview}
          />
        )}
      </Stack>
    </div>
  );
}

export default Page(UserShopPage, { getLayout: UserProfileLayout });
