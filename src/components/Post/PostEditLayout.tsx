import { AppLayout } from '~/components/AppLayout/AppLayout';
import { PostImagesProvider } from '~/components/Post/PostImagesProvider';

export function PostEditLayout(page: any) {
  return (
    <AppLayout>
      <PostImagesProvider>{page}</PostImagesProvider>
    </AppLayout>
  );
}
