import { useCallback, useContext, useEffect } from 'react';
import { env } from '../../env/client.mjs';
import { RecaptchaContext } from './RecaptchaWidget';
import { RecaptchaAction } from '../../server/common/constants';
import { useDebouncer } from '../../utils/debouncer';

export const useRecaptchaToken = (action: RecaptchaAction) => {
  const { ready, tokens, updateToken } = useContext(RecaptchaContext);
  const data = tokens[action];
  const debouncer = useDebouncer(100);

  const getToken = useCallback(async () => {
    if (data?.loading) {
      return;
    }

    if (!ready) {
      updateToken(action, {
        loading: false,
        error: 'Google recaptcha has not loaded yet',
        token: null,
      });

      return;
    }

    if (data?.token) {
      return;
    }

    updateToken(action, { loading: true, error: null, token: null });

    try {
      const token = await window?.grecaptcha.enterprise.execute(env.NEXT_PUBLIC_RECAPTCHA_KEY, {
        action,
      });

      updateToken(action, { loading: false, error: null, token });
      return token;
    } catch (error: any) {
      updateToken(action, { loading: false, error, token: null });
    }
  }, [ready, data, tokens, action, updateToken]);

  useEffect(() => {
    if (ready) {
      debouncer(() => {
        getToken();
      });
    }
  }, [ready]);

  return { token: data?.token, loading: data?.loading, error: data?.error, getToken };
};
