import { useCallback, useContext, useEffect, useState } from 'react';
import { env } from '../../env/client.mjs';
import { RecaptchaContext } from './RecaptchaWidget';
import { RecaptchaAction } from '../../server/common/constants';
import { useDebouncer } from '../../utils/debouncer';

export const useRecaptchaToken = (
  action: RecaptchaAction,
  onGetToken?: (token: string) => void
) => {
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

    try {
      const token = await window?.grecaptcha.enterprise.execute(env.NEXT_PUBLIC_RECAPTCHA_KEY, {
        action,
      });

      setToken(token);
      onGetToken?.(token);

      return token;
    } catch (error: any) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }, [ready, loading, action]);

  useEffect(() => {
    if (ready) {
      debouncer(() => {
        getToken();
      });
    }
  }, [ready]);

  return {
    token,
    loading,
    error,
    getToken,
  };
};
