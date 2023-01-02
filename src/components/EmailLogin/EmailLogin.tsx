import { Alert, Group, Stack, ThemeIcon, Text } from '@mantine/core';
import { IconMail } from '@tabler/icons';
import { signIn } from 'next-auth/react';
import { useState } from 'react';
import { z } from 'zod';
import { SocialButton } from '~/components/Social/SocialButton';
import { Form, InputText, useForm } from '~/libs/form';

const schema = z.object({ email: z.string().email() });
export const EmailLogin = () => {
  const [submitted, setSubmitted] = useState(false);
  const form = useForm({ schema });
  const handleEmailLogin = ({ email }: z.infer<typeof schema>) => {
    setSubmitted(true);
    signIn('email', { email, redirect: false });
  };

  if (submitted)
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
    <Form form={form} onSubmit={handleEmailLogin}>
      <Stack>
        <InputText
          name="email"
          type="email"
          label="Email"
          placeholder="coolperson@email.com"
          withAsterisk
        />
        <SocialButton provider="email" type="submit" />
      </Stack>
    </Form>
  );
};
