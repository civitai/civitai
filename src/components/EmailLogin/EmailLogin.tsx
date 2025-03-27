import { Alert, Group, Stack, Text, ThemeIcon, MantineSize, Button } from '@mantine/core';
import { IconMail } from '@tabler/icons-react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { z } from 'zod';
import { Form, InputText, useForm } from '~/libs/form';
import { showErrorNotification } from '~/utils/notifications';

const schema = z.object({
  email: z.string().trim().toLowerCase().email(),
});
type Status = 'idle' | 'loading' | 'submitted';
export const EmailLogin = ({
  returnUrl,
  size,
  status,
  onStatusChange,
}: {
  returnUrl: string;
  size?: MantineSize;
  status: Status;
  onStatusChange: (value: Status) => void;
}) => {
  const router = useRouter();
  const form = useForm({ schema });
  const handleEmailLogin = async ({ email }: z.infer<typeof schema>) => {
    onStatusChange('loading');
    try {
      const result = await signIn('email', { email, redirect: false, callbackUrl: returnUrl });
      if (result?.error === 'AccessDenied') {
        router.replace({ query: { error: 'NoExtraEmails' } }, undefined, { shallow: true });
        onStatusChange('idle');
        return;
      } else if (result?.error) {
        router.replace({ query: { error: 'TooManyRequests' } }, undefined, { shallow: true });
        onStatusChange('idle');
        return;
      }
      onStatusChange('submitted');
    } catch (error) {
      showErrorNotification({
        title: 'Failed to sign in',
        error: new Error('Email sign-in is not available. Please try again later.'),
      });
      onStatusChange('idle');
    }
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
