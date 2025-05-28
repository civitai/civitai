import { CloseButton, Modal } from '@mantine/core';
import { useRouter } from 'next/router';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { LoginContent } from '~/components/Login/LoginContent';
import type { LoginRedirectReason } from '~/utils/login-helpers';

export default function LoginModal({
  message,
  returnUrl,
  reason,
}: {
  message?: React.ReactNode;
  returnUrl?: string;
  reason?: LoginRedirectReason;
}) {
  const dialog = useDialogContext();
  const router = useRouter();

  return (
    <Modal {...dialog} withCloseButton={false}>
      <CloseButton className="absolute right-1 top-1" onClick={dialog.onClose} />
      <LoginContent returnUrl={returnUrl ?? router.asPath} message={message} reason={reason} />
    </Modal>
  );
}
