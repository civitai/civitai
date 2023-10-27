import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SidebarLayout } from '~/components/Profile/SidebarLayout';
import { trpc } from '~/utils/trpc';

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

  console.log(user);

  return (
    <>
      <SidebarLayout.Root>
        <SidebarLayout.Sidebar>Sidsebar</SidebarLayout.Sidebar>
        <SidebarLayout.Content>My profiles</SidebarLayout.Content>
      </SidebarLayout.Root>
    </>
  );
}

UserProfileOverview.getLayout = (page: React.ReactElement) => <SidebarLayout>{page}</SidebarLayout>;

export default UserProfileOverview;
