import { useDialogContext } from '~/components/Dialog/DialogContext';
import { PageModal } from '~/components/Dialog/Templates/PageModal';
import { PostDetail } from '~/components/Post/Detail/PostDetail';

export default function PostDetailModal(props: { postId: number }) {
  const dialog = useDialogContext();

  return (
    <PageModal
      {...dialog}
      withCloseButton={false}
      closeOnClickOutside={false}
      fullScreen
      padding={0}
    >
      <PostDetail {...props} />
    </PageModal>
  );
}
