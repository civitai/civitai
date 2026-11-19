import { Alert, Anchor, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import {
  isAddAccountFlow,
  NEW_ACCOUNT_HELP_URL,
  shouldShowNewAccountNotice,
} from '~/components/Onboarding/new-account-notice';
import { useSession } from '~/providers/SessionProvider';

export function NewAccountNotice() {
  const { data: session } = useSession();
  // sessionStorage is client-only, so the notice waits for mount rather than flashing in after hydration.
  const [addingAccount, setAddingAccount] = useState<boolean | null>(null);
  useEffect(() => setAddingAccount(isAddAccountFlow()), []);

  if (
    addingAccount === null ||
    !shouldShowNewAccountNotice({
      createdAt: session?.user?.createdAt,
      impersonated: !!session?.impersonatedBy,
      addingAccount,
    })
  )
    return null;

  return (
    <Alert color="blue" icon={<IconInfoCircle />} title="Already have a Civitai account?">
      <Text size="sm">
        This one was just created. If you meant to sign in to an existing account, you may have used
        a different sign-in method than last time.{' '}
        <Anchor href={NEW_ACCOUNT_HELP_URL} target="_blank" rel="noopener" size="sm">
          How to find your account
        </Anchor>
      </Text>
      <Text size="sm" mt="xs">
        To try another way, choose Decline below to log out, then sign in again.
      </Text>
    </Alert>
  );
}
