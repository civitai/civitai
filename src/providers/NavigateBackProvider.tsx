import { useWindowEvent } from '@mantine/hooks';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { isNumber } from '~/utils/type-guards';

const incrementCount = () => {
  const hist_ct = Number(sessionStorage.getItem(sessionKey));
  const counter = isNumber(hist_ct) && hist_ct > 0 ? hist_ct : 0;
  sessionStorage.setItem(sessionKey, `${counter + 1}`);
};

const decrementCount = () => {
  const hist_ct = Number(sessionStorage.getItem(sessionKey));
  const counter = isNumber(hist_ct) && hist_ct > 1 ? hist_ct : 1;
  sessionStorage.setItem(sessionKey, `${counter - 1}`);
};

const sessionKey = 'hist_ct';
export const NavigateBackProvider = ({ children }: { children: React.ReactElement }) => {
  useEffect(() => {
    const pushState = history.pushState;
    history.pushState = function (...state: any[]) {
      incrementCount();
      return pushState.apply(history, state as any);
    };
    return () => {
      history.pushState = pushState;
    };
  }, []);

  const handlePopstate = (e: any) => {
    // TODO
    // maybe refer to this? https://yiou.me/blog/posts/spa-routing
    // e.type === 'popstate'
    // how do we handle forward 'popstate events'
    decrementCount();
  };

  useWindowEvent('popstate', handlePopstate);

  return children;
};

export const useNavigateBack = () => {
  const router = useRouter();

  const handleBack = (...[url, as, options]: Parameters<typeof router.push>) => {
    const prev = sessionStorage.getItem('prevPath');
    !prev ? router.push(url, as, options) : router.back();
  };

  return { goBack: handleBack };
};
