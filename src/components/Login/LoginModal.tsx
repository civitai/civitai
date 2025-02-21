import { CloseButton, Modal } from '@mantine/core';
import { useRouter } from 'next/router';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

import { LoginContent } from '~/components/Login/LoginContent';

export function LoginModal({ message }: { message?: string }) {
  const dialog = useDialogContext();
  const router = useRouter();

  return (
    <Modal {...dialog} withCloseButton={false}>
      <CloseButton className="absolute right-1 top-1" onClick={dialog.onClose} />
      <LoginContent returnUrl={router.pathname} message={message} />
    </Modal>
  );
}
