import { Button, Loader } from '@mantine/core';
import { IconCheck, IconMailExclamation } from '@tabler/icons-react';
import { useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { requiresEmailVerification } from '~/server/common/email-verification-gate';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function VerifyEmailBanner() {
  const currentUser = useCurrentUser();
  const [sent, setSent] = useState(false);

  const resend = trpc.user.resendEmailVerification.useMutation({
    onSuccess: () => setSent(true),
    onError: (error) =>
      showErrorNotification({
        title: 'Could not send the verification email',
        error: new Error(error.message),
      }),
  });

  // Same predicate the server gates on, not a re-derivation of it: a banner that disagrees with the
  // refusal either nags a user who can post or hides the reason from one who cannot.
  if (!requiresEmailVerification(currentUser)) return null;

  return (
    <div className="flex w-full flex-wrap items-center justify-center gap-2 bg-yellow-7 px-4 py-1.5 text-sm font-medium text-dark-9">
      <IconMailExclamation size={18} />
      {sent ? (
        <span className="flex items-center gap-1">
          <IconCheck size={16} />
          Verification email sent to {currentUser?.email}. Check your inbox.
        </span>
      ) : (
        <>
          <span>
            Verify{' '}
            {currentUser?.email ? <strong>{currentUser.email}</strong> : 'your email address'} to
            post, comment and generate.
          </span>
          <Button
            size="compact-xs"
            variant="white"
            onClick={() => resend.mutate()}
            disabled={resend.isPending}
            leftSection={resend.isPending ? <Loader size={12} /> : undefined}
          >
            Resend email
          </Button>
        </>
      )}
    </div>
  );
}
