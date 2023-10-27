import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SidebarLayout } from '~/components/Profile/SidebarLayout';
import { trpc } from '~/utils/trpc';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getInitials } from '~/utils/string-helpers';
import {
  ActionIcon,
  Avatar,
  Center,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { IconMapPin, IconRss } from '@tabler/icons-react';
import { sortDomainLinks } from '~/utils/domain-link';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { UserStats } from '~/components/Profile/UserStats';
import { TipBuzzButton } from '~/components/Buzz/TipBuzzButton';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useMemo } from 'react';
import { formatDate } from '~/utils/date-helpers';
import { ProfileSidebar } from '~/components/Profile/ProfileSidebar';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg, ctx, features }) => {
    const { username } = userPageQuerySchema.parse(ctx.params);

    console.log(features);

    if (username) {
      if (!features?.profileOverhaul) {
        return {
          notFound: true,
        };
      } else {
        await ssg?.userProfile.get.prefetch({ username });
      }
    }

    if (!username) {
      return {
        notFound: true,
      };
    }

    return {
      props: {
        username,
      },
    };
  },
});

export function UserProfileOverview({ username }: { username: string }) {
  const currentUser = useCurrentUser();
  const { isLoading, data: user } = trpc.userProfile.get.useQuery({
    username,
  });

  if (isLoading) {
    return (
      <Center>
        <Loader />
      </Center>
    );
  }

  if (!user) {
    return <NotFound />;
  }

  return (
    <>
      <SidebarLayout.Root>
        <SidebarLayout.Sidebar>
          <ProfileSidebar username={username} />
        </SidebarLayout.Sidebar>
        <SidebarLayout.Content>My profiles</SidebarLayout.Content>
      </SidebarLayout.Root>
    </>
  );
}

UserProfileOverview.getLayout = (page: React.ReactElement) => <SidebarLayout>{page}</SidebarLayout>;

export default UserProfileOverview;
