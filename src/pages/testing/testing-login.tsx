import { Container, Loader, Stack } from '@mantine/core';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { isDev } from '~/env/other';

export default function DevLoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isDev) return;

    const { userId } = router.query;

    if (userId) {
      console.log('Logging in as user', userId);
      setLoading(true);
      signIn('testing-login', { id: userId as string, callbackUrl: '/' })
        .then(() => setLoading(false))
        .catch(console.error);
    }
  }, [router.query]);

  if (!isDev) return <NotFound />;

  return (
    <Container size="xs">
      <Stack>
        <h1>Development Login</h1>
        <p>
          This page is only available in development mode. Pass the user ID in the query string to
          log in as that user.
        </p>
        <p>
          Example: <code>?userId=1</code>
        </p>
        {loading && <Loader />}
      </Stack>
    </Container>
  );
}
