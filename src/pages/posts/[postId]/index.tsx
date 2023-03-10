import { useRouter } from 'next/router';
import { PostDetail } from '~/components/Post/Detail/PostDetail';

export default function PostDetailPage() {
  const router = useRouter();
  const postId = Number(router.query.postId);

  return (
    <>
      <PostDetail postId={postId} />
    </>
  );
}
