import { createContext, useState, useEffect } from 'react';
import Script from 'next/script';
import { env } from '../../env/client.mjs';
import { Anchor, Text, TextProps } from '@mantine/core';
import { RecaptchaAction } from '../../server/common/constants';

type RecaptchaTokenInfo = {
  token: string | null;
  error: string | null;
  loading: boolean;
};

export const RecaptchaContext = createContext<{
  ready: boolean | null;
  tokens: Partial<Record<RecaptchaAction, RecaptchaTokenInfo>>;
  updateToken: (action: RecaptchaAction, token: RecaptchaTokenInfo) => void;
}>({ ready: false, tokens: {}, updateToken: () => undefined });

export function RecaptchaWidgetProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [tokens, setTokens] = useState<Partial<Record<RecaptchaAction, RecaptchaTokenInfo>>>({});
  const updateToken = (action: RecaptchaAction, token: RecaptchaTokenInfo) => {
    setTokens((prev) => ({ ...prev, [action]: token }));
  };

  useEffect(() => {
    if (window.grecaptcha) {
      window.grecaptcha.enterprise.ready(() => setReady(true));
    }
  }, []);

  return (
    <RecaptchaContext.Provider
      value={{
        ready,
        tokens,
        updateToken,
      }}
    >
      <Script
        src={`https://www.google.com/recaptcha/enterprise.js?render=${env.NEXT_PUBLIC_RECAPTCHA_KEY}`}
        onLoad={() => window.grecaptcha.enterprise.ready(() => setReady(true))}
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
