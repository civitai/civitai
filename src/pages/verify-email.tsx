import {
  Alert,
  Button,
  Card,
  Center,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import type { GetServerSideProps } from 'next';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

type VerifyEmailPageProps = {
  token?: string;
};

export default function VerifyEmailPage({ token }: VerifyEmailPageProps) {
  const router = useRouter();
  const [status, setStatus] = useState<'pending' | 'loading' | 'success' | 'error'>('pending');
  const [message, setMessage] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [currentEmail, setCurrentEmail] = useState('');
  const [isEmailChange, setIsEmailChange] = useState(false);
  const currentUser = useCurrentUser();

  const { data: tokenData, error: tokenError } = trpc.user.validateEmailToken.useQuery(
    { token: token || '' },
    { enabled: !!token }
  );

  const verifyEmailMutation = trpc.user.verifyEmailChange.useMutation({
    onSuccess: async (data) => {
      setStatus('success');
      setMessage(data.message);
      // `refreshSession` emits a session:refresh signal, but that only reaches a tab holding a
      // live connection and this page is public — so pull the session rather than rely on it.
      await currentUser?.refresh();
    },
    onError: (error) => {
      setStatus('error');
      setMessage(error.message);
    },
  });

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('No verification token provided');
    } else if (tokenError) {
      setStatus('error');
      setMessage(tokenError.message);
    } else if (tokenData) {
      setStatus('pending');
      setNewEmail(tokenData.newEmail);
      setCurrentEmail(tokenData.currentEmail);
      setIsEmailChange(tokenData.isEmailChange);
    }
  }, [token, tokenData, tokenError]);

  const handleConfirmChange = () => {
    if (token) {
      setStatus('loading');
      verifyEmailMutation.mutate({ token });
    }
  };

  const handleReturnToAccount = async () => {
    await currentUser?.refresh();
    router.push('/user/account');
  };

  return (
    <>
      <Meta title="Email Verification - Civitai" deIndex />
      <Container size="sm" py="xl">
        <Center>
          <Card withBorder shadow="md" p="xl" w="100%" maw={500}>
            <Stack align="center" gap="lg">
              <Title order={2} ta="center">
                Email Verification
              </Title>

              {status === 'pending' && (
                <>
                  <Text ta="center" size="lg" fw={500}>
                    {isEmailChange ? 'Confirm Email Change' : 'Confirm Your Email Address'}
                  </Text>
                  <Text ta="center" c="dimmed">
                    {isEmailChange
                      ? 'You\u2019re about to change your email address:'
                      : 'Confirm this is your email address:'}
                  </Text>
                  {isEmailChange
                    ? currentEmail &&
                      newEmail && (
                        <Stack gap="xs" align="center">
                          <Group gap="xs" align="center">
                            <Text size="md" fw={500}>
                              From:
                            </Text>
                            <Text size="md" c="red" fw={600}>
                              {currentEmail}
                            </Text>
                          </Group>
                          <Text size="xl" c="dimmed">
                            ↓
                          </Text>
                          <Group gap="xs" align="center">
                            <Text size="md" fw={500}>
                              To:
                            </Text>
                            <Text size="md" c="green" fw={600}>
                              {newEmail}
                            </Text>
                          </Group>
                        </Stack>
                      )
                    : newEmail && (
                        <Text size="md" fw={600}>
                          {newEmail}
                        </Text>
                      )}
                  <Text ta="center" c="dimmed" size="sm">
                    Please confirm this action. You will not need to sign in again.
                  </Text>
                  <Group justify="center" gap="sm">
                    <Button variant="outline" onClick={handleReturnToAccount}>
                      Cancel
                    </Button>
                    <Button onClick={handleConfirmChange} disabled={!newEmail}>
                      {isEmailChange ? 'Yes, Change Email' : 'Verify Email'}
                    </Button>
                  </Group>
                </>
              )}

              {status === 'loading' && (
                <>
                  <Loader size="lg" />
                  <Text ta="center" c="dimmed">
                    Updating your email address...
                  </Text>
                </>
              )}

              {status === 'success' && (
                <>
                  <IconCheck size={48} color="green" />
                  <Alert
                    color="green"
                    title={isEmailChange ? 'Email updated!' : 'Email verified!'}
                    w="100%"
                  >
                    {message}
                  </Alert>
                  <Button onClick={handleReturnToAccount} fullWidth>
                    Return to Account Settings
                  </Button>
                </>
              )}

              {status === 'error' && (
                <>
                  <IconX size={48} color="red" />
                  <Alert color="red" title="Verification Failed" w="100%">
                    {message}
                  </Alert>
                  <Group justify="center" gap="sm">
                    <Button variant="outline" onClick={handleReturnToAccount}>
                      Return to Account Settings
                    </Button>
                    <Button onClick={() => router.push('/')}>Go to Homepage</Button>
                  </Group>
                </>
              )}
            </Stack>
          </Card>
        </Center>
      </Container>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<VerifyEmailPageProps> = async (context) => {
  const { token } = context.query;

  return {
    props: {
      token: typeof token === 'string' ? token : undefined,
    },
  };
};
