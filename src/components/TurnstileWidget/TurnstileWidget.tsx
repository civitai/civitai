import { Anchor, Text, TextProps } from '@mantine/core';
import { Turnstile, TurnstileProps, TurnstileInstance } from '@marsidev/react-turnstile';
import { useRef } from 'react';
import { env } from '~/env/client.mjs';
import { showExpiredCaptchaTokenNotification } from '~/utils/notifications';

export type CaptchaState = {
  status: 'success' | 'error' | 'expired' | null;
  token: string | null;
  error: string | null;
};

export function TurnstileWidget(props: Props) {
  const ref = useRef<TurnstileInstance>(null);

  const handleExpired: Props['onExpire'] = (token) => {
    const instance = ref.current;
    if (instance) showExpiredCaptchaTokenNotification({ onRetryClick: () => instance.reset() });

    return props.onExpire?.(token);
  };

  if (!env.NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITEKEY) return null;

  return (
    <Turnstile
      ref={ref}
      siteKey={env.NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITEKEY}
      options={{ size: 'invisible' }}
      {...props}
      onExpire={handleExpired}
    />
  );
}

type Props = Omit<TurnstileProps, 'siteKey'>;

export function TurnstilePrivacyNotice(props: TextProps) {
  return (
    <Text size="xs" {...props}>
      This site is protected by Cloudflare Turnstile and the Cloudflare{' '}
      <Anchor href="https://www.cloudflare.com/privacypolicy/">Privacy Policy</Anchor> applies.
    </Text>
  );
}
