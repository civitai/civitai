import { Center, Loader, Text } from '@mantine/core';
import { useRouter } from 'next/router';
import { Page } from '~/components/AppLayout/Page';
import {
  ProfileAchievementsList,
  useProfileAchievements,
} from '~/components/CreatorJourney/ProfileAchievements';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, features, ssg }) => {
    const username = ctx.query.username as string;

    // The nav hides the tab; this closes the URL.
    if (!features?.creatorJourney)
      return { redirect: { destination: `/user/${username}`, permanent: false } };
    const user = await dbRead.user.findUnique({ where: { username }, select: { bannedAt: true } });
    if (user?.bannedAt) return { redirect: { destination: `/user/${username}`, permanent: false } };

    // Not prefetched: an owner sees their secret achievements by name, and an SSG prefetch has no viewer.
    await Promise.all([
      ssg?.userProfile.get.prefetch({ username }),
      ssg?.userProfile.overview.prefetch({ username }),
    ]);
  },
});

function AchievementsPage() {
  const router = useRouter();
  const username = router.query.username as string;
  const { data: user } = trpc.userProfile.get.useQuery({ username }, { enabled: !!username });
  const { data, count, isLoading } = useProfileAchievements(user?.id);

  if (!user || isLoading)
    return (
      <Center mt="md">
        <Loader />
      </Center>
    );

  if (!data || count === 0)
    return (
      <Text c="dimmed" ta="center" py="xl">
        No Creator Journey achievements yet.
      </Text>
    );

  return (
    <div className="py-6">
      <ProfileAchievementsList data={data} />
    </div>
  );
}

export default Page(AchievementsPage, { getLayout: UserProfileLayout });
