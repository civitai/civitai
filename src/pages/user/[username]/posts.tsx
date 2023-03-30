import { useRouter } from 'next/router';
import { useCurrentUser } from '~/hooks/useCurrentUser';

import { Container } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';

export default function UserPosts() {
  const router = useRouter();
  const username = router.query.username as string;
  const currentUser = useCurrentUser();

  if (!currentUser?.isModerator && username !== currentUser?.username) return <NotFound />;

  return (
    <Container fluid style={{ maxWidth: 2500 }}>
      <PostsInfinite username={username} />
    </Container>
  );
}
