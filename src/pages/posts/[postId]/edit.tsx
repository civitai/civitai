import { PostEditLayout } from '~/components/Post/EditV2/PostEditLayout';
import { PostEdit } from '~/components/Post/EditV2/PostEdit';
import { createPage } from '~/components/AppLayout/createPage';

export default createPage(
  function PostEditPage() {
    return (
      <div className="container max-w-lg">
        <PostEdit />
      </div>
    );
  },
  { InnerLayout: PostEditLayout }
);
