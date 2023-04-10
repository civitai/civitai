import { useRouter } from 'next/router';
import { useCurrentUser } from '~/hooks/useCurrentUser';

import { Container } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { userPageQuerySchema } from '~/server/schema/user.schema';

export default function UserPosts() {
  const router = useRouter();
  const { id, username } = userPageQuerySchema.parse(router.query);
  const currentUser = useCurrentUser();

  if (!username || (!currentUser?.isModerator && username !== currentUser?.username))
    return <NotFound />;

  return (
    <Container fluid style={{ maxWidth: 2500 }}>
      <PostsInfinite username={username} />
    </Container>
  );
}
