import { PostEditLayout } from '~/components/Post/EditV2/PostEditLayout';
import { PostEdit } from '~/components/Post/EditV2/PostEdit';
import { createPage } from '~/components/AppLayout/createPage';
import { Container } from '@mantine/core';

export default createPage(
  function PostEditPage() {
    return (
      <Container size="lg">
        <PostEdit />
      </Container>
    );
  },
  { InnerLayout: PostEditLayout }
);
