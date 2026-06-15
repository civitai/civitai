import { trpc } from '~/utils/trpc';
import { ProfileSidebar } from '~/components/Profile/ProfileSidebar';

import React, { useCallback, useMemo, useRef } from 'react';

import { Box, Menu, Text } from '@mantine/core';
import { IconBan, IconDotsVertical, IconFlag } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { Meta } from '~/components/Meta/Meta';
import { abbreviateNumber } from '~/utils/number-helpers';
import { env } from '~/env/client';
import { TrackView } from '~/components/TrackView/TrackView';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { NoContent } from '~/components/NoContent/NoContent';
import { useRouter } from 'next/router';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { ProfileNavigation } from '~/components/Profile/ProfileNavigation';
import { ProfileHeader } from '~/components/Profile/ProfileHeader';
import { usePathname } from 'next/navigation';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { BlockUserButton } from '~/components/HideUserButton/BlockUserButton';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import { outerCardStyle } from '~/components/Buzz/CryptoDeposit/crypto-deposit.constants';
import { isBlobUrl } from '~/utils/type-guards';

export function ProfileLayout2({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { username } = router.query as { username: string };

  const { isInitialLoading, data: user } = trpc.userProfile.get.useQuery({ username });
  const blockedByThem = !!(user && 'blockedByThem' in user && user.blockedByThem);
  const { data: overview } = trpc.userProfile.overview.useQuery(
    { username },
    { enabled: !blockedByThem }
  );
  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.some((x) => x.id === user?.id);

  const stats = user?.stats;

  // SEO: deindex inactive accounts and empty subpages so they migrate from
  // "Crawled — currently not indexed" to "Excluded by noindex tag" and stop
  // dragging on site-wide quality. See docs/seo-thin-page-deindexing-plan.md.
  const deIndex = useMemo(() => {
    if (!user) return true;
    if (user.deletedAt || user.bannedAt) return true;

    const hasContent =
      (overview?.modelCount ?? 0) > 0 ||
      (overview?.postCount ?? 0) > 0 ||
      (overview?.imageCount ?? 0) > 0 ||
      (overview?.videoCount ?? 0) > 0 ||
      (overview?.articleCount ?? 0) > 0 ||
      (overview?.comicCount ?? 0) > 0;

    const isThin =
      !hasContent && (user.stats?.followerCountAllTime ?? 0) < 10 && !user.rank?.leaderboardRank;
    if (isThin) return true;

    const subpage = pathname?.match(/^\/user\/[^/]+\/([\w-]+)/)?.[1];
    if (subpage) {
      const subpageCounts: Record<string, number | undefined> = {
        models: overview?.modelCount,
        posts: overview?.postCount,
        images: overview?.imageCount,
        videos: overview?.videoCount,
        articles: overview?.articleCount,
        comics: overview?.comicCount,
        collections: overview?.collectionCount,
        '3d-models': overview?.model3dCount,
      };
      if (subpageCounts[subpage] === 0) return true;
    }

    return false;
  }, [user, overview, pathname]);
  // const { classes } = useStyles();

  const userMetaImage =
    user?.profilePicture && !isBlobUrl(user.profilePicture.url)
      ? getEdgeUrl(user.profilePicture.url, { width: 1200 })
      : user?.image && user.image.startsWith('http')
      ? user.image
      : undefined;
  const metaSchema =
    user && user.username
      ? {
          '@context': 'https://schema.org',
          '@type': 'ProfilePage',
          name: `${user.username} Creator Profile`,
          description: `Learn more about ${user.username} on Civitai.`,
          primaryImageOfPage: {
            '@type': 'ImageObject',
            contentUrl: userMetaImage,
          },
          mainEntity: {
            '@type': 'Person',
            name: user.username,
            image: userMetaImage,
            url: `${env.NEXT_PUBLIC_BASE_URL as string}/user/${username}`,
            interactionStatistic: stats
              ? [
                  {
                    '@type': 'InteractionCounter',
                    interactionType: 'http://schema.org/FollowAction',
                    userInteractionCount: stats.followerCountAllTime,
                  },
                  {
                    '@type': 'InteractionCounter',
                    interactionType: 'http://schema.org/LikeAction',
                    userInteractionCount: stats.thumbsUpCountAllTime,
                  },
                  {
                    '@type': 'InteractionCounter',
                    interactionType: 'http://schema.org/DownloadAction',
                    userInteractionCount: stats.downloadCountAllTime,
                  },
                ]
              : undefined,
          },
        }
      : undefined;

  return (
    <>
      {user && user.username && stats && !blockedByThem ? (
        <Meta
          title={`${user.username} Creator Profile | Civitai`}
          description={`Models Uploaded: ${abbreviateNumber(0)}, Followers: ${abbreviateNumber(
            stats.followerCountAllTime
          )}, Total Likes Received: ${abbreviateNumber(
            stats.thumbsUpCountAllTime
          )}, Total Downloads Received: ${abbreviateNumber(stats.downloadCountAllTime)}. `}
          images={user.profilePicture}
          canonical={pathname}
          schema={metaSchema}
          deIndex={deIndex}
        />
      ) : (
        <Meta
          title={`${user?.username ?? username} Creator Profile | Civitai`}
          description={`Learn more about ${user?.username ?? username} on Civitai.`}
          canonical={pathname}
          deIndex
        />
      )}
      {user && !blockedByThem && (
        <TrackView entityId={user.id} entityType="User" type="ProfileView" />
      )}
      <AppLayout
        loading={isInitialLoading}
        notFound={!user || !user.username}
        left={
          blockedByThem ? null : (
            <div className="scroll-area relative min-h-full w-[320px] border-r border-gray-3 bg-gray-0 @max-sm:hidden dark:border-dark-4 dark:bg-dark-6">
              <ProfileSidebar username={username} />
            </div>
          )
        }
        subNav={blockedByThem ? null : <ProfileNavigation username={username} />}
        announcements={false}
      >
        <div className="px-3">
          {blockedByThem && user ? (
            <BlockedByThemPanel user={user} />
          ) : isBlocked ? (
            <div className="mx-auto flex h-full items-center">
              <NoContent message="Unable to display content because you have blocked this user" />
            </div>
          ) : (
            <>
              <ProfileHeader username={username} />
              {children}
            </>
          )}
        </div>
      </AppLayout>
    </>
  );
}

function BlockedByThemPanel({ user }: { user: Partial<UserWithCosmetics> & { id: number } }) {
  const spotlightRef = useRef<HTMLDivElement>(null);
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = spotlightRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    el.style.background = `radial-gradient(250px circle at ${x}px ${y}px, rgba(239,68,68,0.18), transparent 70%)`;
    el.style.opacity = '1';
  }, []);
  const handleMouseLeave = useCallback(() => {
    const el = spotlightRef.current;
    if (el) el.style.opacity = '0';
  }, []);

  return (
    <div className="flex min-h-[calc(100vh-200px)] items-center justify-center">
      <div
        className="relative flex w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-dark-4 md:flex-row"
        style={outerCardStyle}
      >
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <LegacyActionIcon
              variant="subtle"
              color="gray"
              radius="xl"
              className="absolute right-3 top-3 z-20 text-gray-0/80 hover:bg-white/10 hover:text-white"
              aria-label="Blocked user actions"
            >
              <IconDotsVertical size={18} />
            </LegacyActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <LoginRedirect reason="report-user">
              <Menu.Item
                leftSection={<IconFlag size={14} stroke={1.5} />}
                onClick={() =>
                  openReportModal({ entityType: ReportEntity.User, entityId: user.id })
                }
              >
                Report user
              </Menu.Item>
            </LoginRedirect>
          </Menu.Dropdown>
        </Menu>
        <div
          className="relative flex w-full flex-col items-center justify-center gap-4 overflow-hidden bg-gradient-to-b from-red-9/30 via-red-9/15 to-red-9/5 px-10 py-12 md:w-2/5 md:bg-gradient-to-br"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          <div
            ref={spotlightRef}
            className="pointer-events-none absolute inset-0 transition-opacity duration-500"
            style={{ opacity: 0 }}
          />
          <div className="pointer-events-none absolute -bottom-16 -left-16 size-48 rounded-full bg-red-9/10 blur-3xl" />
          <div className="bg-orange-9/8 pointer-events-none absolute -right-12 -top-12 size-36 rounded-full blur-3xl" />

          <Box className="relative rounded-full shadow-lg shadow-red-9/40 ring-4 ring-red-9/40 ring-offset-2 ring-offset-transparent">
            <UserAvatar user={user} avatarSize={96} size="xl" radius={1000} />
          </Box>

          <Text
            fw={800}
            className="font-display relative text-center text-2xl leading-tight tracking-tight text-gray-0"
          >
            You&apos;ve been
            <br />
            blocked
          </Text>
        </div>

        <div className="flex w-full flex-1 flex-col gap-6 border-t border-gray-200 px-8 py-10 md:border-l md:border-t-0 md:px-10 dark:border-white/5">
          <div className="flex flex-col gap-1">
            <Text size="lg" fw={600} className="text-gray-1">
              <Text component="span" inherit fw={700} className="text-red-4">
                {user.username}
              </Text>{' '}
              has blocked you
            </Text>
            <Text size="sm" className="text-dimmed">
              Their profile and content are hidden from you. You can still block them on your end to
              prevent further interactions on your own posts.
            </Text>
          </div>

          <BlockUserButton
            userId={user.id}
            label="Block them"
            unblockLabel="Unblock them"
            variant="filled"
            color="red"
            size="lg"
            radius="md"
            leftSection={<IconBan size={18} />}
            className="mt-1 w-full shadow-md shadow-red-9/25 md:w-auto md:self-start"
          />
        </div>
      </div>
    </div>
  );
}

export const UserProfileLayout = (page: React.ReactElement) => (
  <ProfileLayout2>{page}</ProfileLayout2>
);
