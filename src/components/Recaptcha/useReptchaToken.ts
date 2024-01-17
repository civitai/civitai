import { useCallback, useContext, useEffect, useState } from 'react';
import { env } from '../../env/client.mjs';
import { RecaptchaContext } from './RecaptchaWidget';

export const useRecaptchaToken = (action?: string) => {
  const ready = useContext(RecaptchaContext);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); // Start as true.
  const [error, setError] = useState<Error | null>(null);

  const getToken = useCallback(async (action?: string) => {
    if (!action || !ready) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const token = await window?.grecaptcha.enterprise.execute(env.NEXT_PUBLIC_RECAPTCHA_KEY, {
        action,
      });

      setToken(token);
    } catch (error: any) {
      setError(error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;

    getToken(action);
  }, [ready, action]);

  return { token, loading, error, getToken };
};
