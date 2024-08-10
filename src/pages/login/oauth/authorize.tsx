import { Alert, Button, Container, Paper, Stack, Text } from '@mantine/core';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client.mjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getLoginLink } from '~/utils/login-helpers';

export default function Authorize() {
  const router = useRouter();
  const { client_id } = router.query;
  const currentUser = useCurrentUser();
  const [status, setStatus] = useState<'pending' | 'loading' | 'error' | 'success'>('pending');
  const [error, setError] = useState<string | null>(null);
  if (!currentUser) {
    router.replace(getLoginLink({ returnUrl: location.href }));
    return null;
  }

  async function handleAuthorize() {
    setStatus('loading');
    const urlParams = new URLSearchParams(window.location.search);
    urlParams.set('allowed', 'true');
    const request = await fetch('/api/auth/oauth/authorize?' + urlParams.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    if (request.ok) {
      const { location } = await request.json();
      setStatus('success');
      setTimeout(() => {
        window.location.href = location;
      }, 2000);
    } else {
      const { error } = await request.json();
      setError(error);
      setStatus('error');
    }
  }

  function handleDeny() {
    router.replace('/');
  }

  return (
    <>
      <Meta
        title="Authorize Third Party App"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/login/oauth/authorize`, rel: 'canonical' }]}
      />
      <Container size="xs">
        <Stack>
          {status === 'success' ? (
            <Paper radius="md" p="xl" withBorder>
              <Text size="lg" weight={500}>
                Your account has been authorized. Redirecting...
              </Text>
            </Paper>
          ) : (
            <Paper radius="md" p="xl" withBorder>
              {status === 'error' && (
                <Alert color="red" mb="md">
                  {error}
                </Alert>
              )}
              <Text size="lg" weight={500}>
                Would you like to authorize {client_id} to access your account?
              </Text>
              <Stack spacing="xs" mt="md">
                <Button fullWidth onClick={handleAuthorize} loading={status === 'loading'}>
                  Yes
                </Button>
                <Button
                  fullWidth
                  onClick={handleDeny}
                  variant="default"
                  disabled={status !== 'pending'}
                >
                  No
                </Button>
              </Stack>
            </Paper>
          )}
        </Stack>
      </Container>
    </>
  );
}
