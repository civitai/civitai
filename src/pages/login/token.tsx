import { Container, Loader, Stack } from '@mantine/core';
import { isArray } from 'lodash-es';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';

export default function TokenLoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const { token: tokenQuery } = router.query;
    if (!tokenQuery) return;
    const token = isArray(tokenQuery) ? tokenQuery[0] : tokenQuery;

    console.log('Logging in with token');
    setLoading(true);
    signIn('token-login', { token, callbackUrl: '/' })
      .then(() => setLoading(false))
      .catch(console.error);
  }, [router.query]);

  return (
    <Container size="xs">
      <Stack>
        <h1>Token Login</h1>
        <p>
          This page is only available with a valid token. Pass the token in the query string to log
          in with the associated user.
        </p>
        <p>
          Example: <code>?token=abcd</code>
        </p>
        {loading && <Loader />}
      </Stack>
    </Container>
  );
}
