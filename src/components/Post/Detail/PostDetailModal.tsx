import { Box, Modal } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { PostDetail } from '~/components/Post/Detail/PostDetail';

export default function PostDetailModal(props: { postId: number }) {
  const dialog = useDialogContext();

  return (
    <Modal {...dialog} withCloseButton={false} closeOnClickOutside={false} fullScreen padding={0}>
      <Box pt="md" pb="xl">
        <PostDetail {...props} />
      </Box>
    </Modal>
  );
}
