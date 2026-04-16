import type { TextProps } from '@mantine/core';
import { Anchor, Text } from '@mantine/core';
import type { TurnstileProps, TurnstileInstance } from '@marsidev/react-turnstile';
import { Turnstile } from '@marsidev/react-turnstile';
import { forwardRef, useImperativeHandle, useRef } from 'react';
import { env } from '~/env/client';
import { showExpiredCaptchaTokenNotification } from '~/utils/notifications';

export type CaptchaState = {
  status: 'success' | 'error' | 'expired' | null;
  token: string | null;
  error: string | null;
};

export type TurnstileWidgetRef = TurnstileInstance;

export const TurnstileWidget = forwardRef<TurnstileInstance, Props>(function TurnstileWidget(
  {
    siteKey = env.NEXT_PUBLIC_CF_INVISIBLE_TURNSTILE_SITEKEY ||
      env.NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITEKEY,
    ...props
  },
  forwardedRef
) {
  const ref = useRef<TurnstileInstance>(null);
  useImperativeHandle(forwardedRef, () => ref.current as TurnstileInstance, []);

  const handleExpired: Props['onExpire'] = (token) => {
    const instance = ref.current;
    if (instance) showExpiredCaptchaTokenNotification({ onRetryClick: () => instance.reset() });

    return props.onExpire?.(token);
  };

  if (!siteKey) return null;

  return (
    <Turnstile
      ref={ref}
      siteKey={siteKey}
      options={{ size: 'invisible' }}
      {...props}
      onExpire={handleExpired}
    />
  );
});

type Props = Omit<TurnstileProps, 'siteKey' | 'injectScript'> & { siteKey?: string };

export function TurnstilePrivacyNotice(props: TextProps) {
  return (
    <Text size="xs" {...props}>
      This site is protected by Cloudflare Turnstile and the Cloudflare{' '}
      <Anchor href="https://www.cloudflare.com/privacypolicy/">Privacy Policy</Anchor> applies.
    </Text>
  );
}
