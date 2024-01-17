import { createContext, useState } from 'react';
import Script from 'next/script';
import { env } from '../../env/client.mjs';
import { Anchor, Text, TextProps } from '@mantine/core';

export const RecaptchaContext = createContext<boolean | null>(null);

export function RecaptchaWidgetProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  return (
    <RecaptchaContext.Provider value={ready}>
      <Script
        src={`https://www.google.com/recaptcha/enterprise.js?render=${env.NEXT_PUBLIC_RECAPTCHA_KEY}`}
        onLoad={() => {
          window?.grecaptcha.enterprise.ready(() => {
            setReady(true);
          });
        }}
      />
      {children}
    </RecaptchaContext.Provider>
  );
}

export function RecaptchaNotice(props: TextProps) {
  return (
    <Text size="xs" {...props}>
      This site is protected by reCAPTCHA and the Google{' '}
      <Anchor href="https://policies.google.com/privacy">Privacy Policy</Anchor> and{' '}
      <Anchor href="https://policies.google.com/terms">Terms of Service</Anchor> apply.
    </Text>
  );
}

declare global {
  interface Window {
    grecaptcha: any; // @ts-ignore: - this is coming from Google recaptcha
  }
}
