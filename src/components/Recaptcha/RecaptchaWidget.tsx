import Script from 'next/script';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { env } from '../../env/client.mjs';
import { Anchor, Text, TextProps } from '@mantine/core';

export function RecaptchaWidget() {
  const user = useCurrentUser();
  if (!user) return null;
  return (
    <Script
      src={`https://www.google.com/recaptcha/enterprise.js?render=${env.NEXT_PUBLIC_RECAPTCHA_KEY}`}
      onLoad={() => {
        window?.grecaptcha.enterprise.ready(() => {
          console.log('yei!');
        });
      }}
    />
  );
}

export function RecaptchaNotice(props: TextProps) {
  return (
    <Text size="xs" {...props}>
      This site is protected by reCAPTCHA and the Google
      <Anchor href="https://policies.google.com/privacy">Privacy Policy</Anchor> and
      <Anchor href="https://policies.google.com/terms">Terms of Service</Anchor> apply.
    </Text>
  );
}

declare global {
  interface Window {
    grecaptcha: any; // @ts-ignore: - this is coming from Google recaptcha
  }
}
