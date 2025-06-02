import { useCallback, useContext, useEffect, useState } from 'react';
import { env } from '../../env/client';
import { RecaptchaContext } from './RecaptchaWidget';
import type { RecaptchaAction } from '../../server/common/constants';
import { useDebouncer } from '../../utils/debouncer';
import { isDev } from '~/env/other';

export const useRecaptchaToken = (action: RecaptchaAction, fetchOnReady = true) => {
  const { ready } = useContext(RecaptchaContext);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const debouncer = useDebouncer(100);

  const getToken = useCallback(async () => {
    if (loading) {
      return;
    }

    if (!ready) {
      setError('Google recaptcha has not loaded yet');
      return;
    }

    setToken(null);
    setLoading(true);
    setError(null);

    try {
      if (isDev) {
        const token = 'dev-recaptcha-token';
        setToken(token);

        return token;
      }

      const token = await window?.grecaptcha.enterprise.execute(env.NEXT_PUBLIC_RECAPTCHA_KEY, {
        action,
      });

      setToken(token);

      return token;
    } catch (error: any) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }, [ready, loading, action]);

  useEffect(() => {
    if (ready && fetchOnReady) {
      debouncer(() => {
        getToken();
      });
    }
  }, [ready, fetchOnReady]);

  return {
    token,
    loading,
    error,
    getToken,
  };
};
