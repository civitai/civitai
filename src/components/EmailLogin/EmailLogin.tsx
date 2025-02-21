import { Alert, Group, Stack, Text, ThemeIcon, MantineSize, Button } from '@mantine/core';
import { IconMail } from '@tabler/icons-react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { z } from 'zod';
import { Form, InputText, useForm } from '~/libs/form';

const schema = z.object({
  email: z.string().trim().toLowerCase().email(),
});
export const EmailLogin = ({ returnUrl, size }: { returnUrl: string; size?: MantineSize }) => {
  const router = useRouter();
  const [status, setStatus] = useState<'idle' | 'loading' | 'submitted'>('idle');
  const form = useForm({ schema });
  const handleEmailLogin = async ({ email }: z.infer<typeof schema>) => {
    setStatus('loading');
    const result = await signIn('email', { email, redirect: false, callbackUrl: returnUrl });
    if (result?.error === 'AccessDenied') {
      router.replace({ query: { error: 'NoExtraEmails' } }, undefined, { shallow: true });
      setStatus('idle');
      return;
    } else if (result?.error) {
      router.replace({ query: { error: 'TooManyRequests' } }, undefined, { shallow: true });
      setStatus('idle');
      return;
    }

    setStatus('submitted');
  };

  if (status === 'submitted')
    return (
      <Alert pl={15}>
        <Group noWrap>
          <ThemeIcon size="lg">
            <IconMail size={20} />
          </ThemeIcon>
          <Stack spacing={0}>
            <Text
              size="md"
              sx={{ lineHeight: 1.1 }}
            >{`Check your email for a special login link`}</Text>
            <Text size="xs" color="dimmed">
              Be sure to check your spam...
            </Text>
          </Stack>
        </Group>
      </Alert>
    );

  return (
    <Form form={form} onSubmit={handleEmailLogin} className="flex flex-col gap-3">
      <InputText
        name="email"
        type="email"
        placeholder="coolperson@email.com"
        withAsterisk
        size={size}
      />
      <Button type="submit" loading={status === 'loading'} size={size}>
        Continue
      </Button>
    </Form>
  );
};
