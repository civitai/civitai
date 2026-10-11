import { Anchor, Center, Loader, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import React, { useMemo } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { useMilestoneLanding } from '~/components/CreatorJourney/useMilestoneLanding';
import {
  getAllAvailableProfileSections,
  ProfileSectionComponent,
  shouldDisplayUserNullState,
} from '~/components/Profile/profile.utils';

import type { ProfileSectionSchema, ProfileSectionType } from '~/server/schema/user-profile.schema';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { parseScoreTierSlug } from '~/shared/constants/creator-journey.constants';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg, ctx }) => {
    const { username, id } = userPageQuerySchema.parse(ctx.params);
    if (username) {
      // Prefetch under the route's own spelling, not the slugified `username`: the layout queries
      // `router.query.username` as-is, and a lowercased key misses for `/user/JustMaier`, so the
      // server render (and every crawler's og:image) falls back to the empty profile meta.
      const routeUsername = ctx.params?.username as string;
      const milestone = parseScoreTierSlug(ctx.query.milestone);
      const [, profile] = await Promise.all([
        ssg?.user.getCreator.prefetch({ username: routeUsername }),
        milestone
          ? ssg?.userProfile.get.fetch({ username: routeUsername }).catch(() => null)
          : ssg?.userProfile.get.prefetch({ username: routeUsername }).then(() => null),
        ssg?.userProfile.overview.prefetch({ username: routeUsername }),
      ]);
      // Crawlers read og:image from the server render, so whether `?milestone=` swaps it is decided here.
      if (ssg && milestone && profile)
        await ssg.creatorJourney.isMilestoneShareable.prefetch({
          userId: profile.id,
          slug: milestone,
        });
    }

    return {
      props: removeEmpty({ id, username }),
    };
  },
});

function ProfileOverview() {
  const router = useRouter();
  const { username } = router.query as { username: string };

  const { isLoading, data: user } = trpc.userProfile.get.useQuery({
    username,
  });
  const { data: userOverview } = trpc.userProfile.overview.useQuery({ username });

  useMilestoneLanding(user);

  const sections = useMemo(
    () =>
      !user
        ? []
        : getAllAvailableProfileSections(
            user.profile?.profileSectionsSettings as ProfileSectionSchema[]
          ).filter((section) => section.enabled),
    [user]
  );

  if (isLoading) {
    return (
      <Center mt="md">
        <Loader />
      </Center>
    );
  }

  if (!user) {
    return <NotFound />;
  }

  const shouldDisplayUserNullStateBool = shouldDisplayUserNullState({
    overview: userOverview,
    userWithProfile: user,
  });

  return (
    <>
      {shouldDisplayUserNullStateBool ? (
        <Stack>
          <Stack align="center" py="lg">
            <ThemeIcon size={128} radius={100}>
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Text size="lg" maw={600} align="center">
              {user.bannedAt ? (
                <Text span>
                  This user account has been banned due to a violation of Civitai&apos;s Terms of
                  Service. For more details on our policies, please refer to the{' '}
                  <Link href="/content/tos" legacyBehavior passHref>
                    <Anchor>Terms of Service</Anchor>
                  </Link>{' '}
                  and{' '}
                  <Link href="/safety" legacyBehavior passHref>
                    <Anchor>Safety Center</Anchor>
                  </Link>{' '}
                  pages.
                </Text>
              ) : (
                "This user hasn't posted any content, or has chosen not to display anything at the moment. Check back later to see if they've shared something new!"
              )}
            </Text>
          </Stack>
        </Stack>
      ) : (
        <Stack gap={0}>
          {sections.map((section) => {
            const Section = ProfileSectionComponent[section.key as ProfileSectionType];

            if (!Section) {
              // Useful if we remove a section :)
              return null;
            }

            return (
              <Section
                key={section.key}
                // Keep typescript happy.
                user={{ ...user, username: user.username as string }}
              />
            );
          })}
        </Stack>
      )}
    </>
  );
}

export default Page(ProfileOverview, {
  getLayout: UserProfileLayout,
});
