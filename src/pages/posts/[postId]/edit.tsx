import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { PostEditLayout } from '~/components/Post/PostEditLayout';
import { usePostImagesContext } from '~/components/Post/PostImagesProvider';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { trpc } from '~/utils/trpc';

export default function PostEdit() {
  const router = useRouter();
  const postId = Number(router.query.postId);
  const { upload, items, handlers } = usePostImagesContext();
  const queryUtils = trpc.useContext();

  const { data, isLoading } = trpc.post.get.useQuery({ id: postId });

  useEffect(() => {
    // only allow syncing items with data when items haven't already been set
    if (!items.length && !!data) {
      handlers.setState(data.images.map((image) => ({ type: 'image', ...image })));
    }
  }, [data]); //eslint-disable-line

  const handleDrop = (files: File[]) => upload(postId, files);

  return (
    <>
      {/* Title input */}
      <ImageDropzone onDrop={handleDrop} count={items.length} />
      {/* List images */}
    </>
  );
}

PostEdit.getLayout = PostEditLayout;
