import { Container, Tabs } from '@mantine/core';
import { InferGetServerSidePropsType } from 'next';

import { NotFound } from '~/components/AppLayout/NotFound';
import { UserDraftModels } from '~/components/User/UserDraftModels';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { postgresSlugify } from '~/utils/string-helpers';

import { UserProfileLayout } from './';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx, session }) => {
    const { username } = userPageQuerySchema.parse(ctx.query);
    // if there's no session and is not the same user, return not found
    if (!session?.user || postgresSlugify(session.user.username) !== username)
      return { notFound: true };

    return {
      props: { username },
    };
  },
});

export default function UserDraftsPage({
  username,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const currentUser = useCurrentUser();
  if (!username || !currentUser) return <NotFound />;

  return (
    <Tabs.Panel value="/drafts">
      <Container size="xl">
        <UserDraftModels enabled={!!currentUser} />
      </Container>
    </Tabs.Panel>
  );
}

UserDraftsPage.getLayout = UserProfileLayout;
