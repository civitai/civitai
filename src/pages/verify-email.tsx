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

  const { data: tokenData, error: tokenError } = trpc.user.validateEmailToken.useQuery(
    { token: token || '' },
    { enabled: !!token }
  );

  const verifyEmailMutation = trpc.user.verifyEmailChange.useMutation({
    onSuccess: (data) => {
      setStatus('success');
      setMessage(data.message);
    },
    onError: (error) => {
      setStatus('error');
      setMessage(error.message);
    },
  });

  // Update status based on token validation
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
    }
  }, [token, tokenData, tokenError]);

  const handleConfirmChange = () => {
    if (token) {
      setStatus('loading');
      verifyEmailMutation.mutate({ token });
    }
  };

  const handleReturnToAccount = () => {
    router.push('/user/account');
  };

  return (
    <>
      <Meta title="Email Verification - Civitai" />
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
                    Confirm Email Change
                  </Text>
                  <Text ta="center" c="dimmed">
                    You&rsquo;re about to change your email address:
                  </Text>
                  {currentEmail && newEmail && (
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
                  )}
                  <Text ta="center" c="dimmed" size="sm">
                    Please confirm this action. You will not need to sign in again.
                  </Text>
                  <Group justify="center" gap="sm">
                    <Button variant="outline" onClick={handleReturnToAccount}>
                      Cancel
                    </Button>
                    <Button onClick={handleConfirmChange} disabled={!newEmail}>
                      Yes, Change Email
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
                  <Alert color="green" title="Success!" w="100%">
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
