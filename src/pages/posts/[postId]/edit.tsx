import { PostEditLayout } from '~/components/Post/EditV2/PostEditLayout';
import { PostEdit } from '~/components/Post/EditV2/PostEdit';
import { createPage } from '~/components/AppLayout/createPage';

export default createPage(PostEdit, { InnerLayout: PostEditLayout });
