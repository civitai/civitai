import { Container } from '@mantine/core';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { postgresSlugify } from '~/utils/string-helpers';

export default function UserPosts() {
  const router = useRouter();
  const { id, username } = userPageQuerySchema.parse(router.query);
  const currentUser = useCurrentUser();

  if (
    !username ||
    !currentUser?.username ||
    (!currentUser.isModerator && username !== postgresSlugify(currentUser.username))
  )
    return <NotFound />;

  return (
    <Container fluid style={{ maxWidth: 2500 }}>
      <PostsInfinite username={username} />
    </Container>
  );
}
