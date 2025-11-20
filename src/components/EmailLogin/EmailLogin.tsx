import type { MantineSize } from '@mantine/core';
import { Alert, Button, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconMail } from '@tabler/icons-react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import * as z from 'zod';
import type { CaptchaState } from '~/components/TurnstileWidget/TurnstileWidget';
import {
  TurnstilePrivacyNotice,
  TurnstileWidget,
} from '~/components/TurnstileWidget/TurnstileWidget';
import { env } from '~/env/client';
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

  const [captchaState, setCaptchaState] = useState<CaptchaState>({
    status: null,
    token: null,
    error: null,
  });
  const email = form.watch('email');

  const handleEmailLogin = async ({ email }: z.infer<typeof schema>) => {
    if (captchaState.status !== 'success')
      return showErrorNotification({
        title: 'Cannot send login email',
        error: new Error(captchaState.error ?? 'Captcha token expired. Please try again.'),
      });

    if (!captchaState.token)
      return showErrorNotification({
        title: 'Cannot send login email',
        error: new Error('Captcha token is missing'),
      });

    onStatusChange('loading');
    try {
      console.log('Signing in with email:', email);
      const result = await signIn('email', { email, redirect: false, callbackUrl: returnUrl });
      console.log('Sign in result:', result);
      if (result?.error === 'AccessDenied') {
        router.replace({ query: { error: 'NoExtraEmails' } }, undefined, { shallow: true });
        onStatusChange('idle');
        return;
      } else if (result?.error) {
        console.log(result?.error);
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
      <Alert
        icon={
          <ThemeIcon>
            <IconMail size={18} />
          </ThemeIcon>
        }
        classNames={{
          wrapper: 'items-center',
        }}
      >
        <Stack gap={0}>
          <Text
            size="md"
            // style={{ lineHeight: 1.1 }}
          >{`Check your email for a special login link`}</Text>
          <Text size="xs" c="dimmed">
            Be sure to check your spam...
          </Text>
        </Stack>
      </Alert>
    );

  return (
    <Stack gap="sm">
      <Form form={form} onSubmit={handleEmailLogin} className="flex flex-col gap-3">
        <InputText
          name="email"
          type="email"
          placeholder="coolperson@email.com"
          withAsterisk
          size={size}
        />
        <Button
          type="submit"
          size={size}
          loading={status === 'loading'}
          disabled={!email || !email.length || captchaState.status !== 'success'}
        >
          Send login link
        </Button>
      </Form>
      {!!email && email.length > 0 && (
        <>
          <TurnstileWidget
            options={{ size: 'normal' }}
            className="!w-full justify-items-center"
            onSuccess={(token) => setCaptchaState({ status: 'success', token, error: null })}
            onError={(error) =>
              setCaptchaState({
                status: 'error',
                token: null,
                error: `There was an error generating the captcha: ${error}`,
              })
            }
            siteKey={env.NEXT_PUBLIC_CF_MANAGED_TURNSTILE_SITEKEY}
            onExpire={(token) =>
              setCaptchaState({ status: 'expired', token, error: 'Captcha token expired' })
            }
          />
          {captchaState.status === 'error' && (
            <Text size="xs" c="red">
              {captchaState.error}
            </Text>
          )}
          <TurnstilePrivacyNotice />
        </>
      )}
    </Stack>
  );
};
