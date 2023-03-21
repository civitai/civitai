import { useWindowEvent } from '@mantine/hooks';
import { useEffect } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

// partial support navigation api - https://caniuse.com/?search=window.navigation
const isClient = typeof window !== 'undefined';
const hasNavigation = isClient && !!window.navigation;
const sessionKey = 'hist_keys';

type ClientNavigationStore = {
  index: number;
  keys: string[];
  setDefault: (key: string) => void;
  pushKey: (key: string) => void;
  setKey: (key: string) => void;
};

const useClientHistoryStore = create<ClientNavigationStore>()(
  immer((set) => ({
    index: 0,
    keys: [],
    setDefault: (key) => {
      set((state) => {
        state.keys = [key];
      });
    },
    pushKey: (key) => {
      set((state) => {
        state.keys = state.keys.slice(0, state.index + 1).concat([key]);
        state.index = state.keys.length - 1;
      });
    },
    setKey: (key) => {
      set((state) => {
        const index = state.keys.indexOf(key);
        if (index > -1) {
          state.index = index;
        } else if (index === -1) {
          state.keys = state.keys.slice(0, index).concat([key]);
          state.index = state.keys.length - 1;
        }
      });
    },
  }))
);

export function ClientHistoryStore() {
  const keys = useClientHistoryStore((state) => state.keys);
  const pushKey = useClientHistoryStore((state) => state.pushKey);
  const setDefault = useClientHistoryStore((state) => state.setDefault);
  const setKey = useClientHistoryStore((state) => state.setKey);

  useEffect(() => {
    sessionStorage.setItem(sessionKey, keys.join(','));
  }, [keys]);

  useEffect(() => {
    if (!keys.length) {
      setDefault(history.state.key);
    }
  }, [keys, setDefault]);

  useEffect(() => {
    const pushState = history.pushState;
    history.pushState = function (data, unused, url) {
      pushKey(data.key);
      return pushState.apply(history, [data, unused, url]);
    };
    return () => {
      history.pushState = pushState;
    };
  }, [pushKey]);

  const handlePopstate = (e: any) => setKey(e.state.key);
  useWindowEvent('popstate', handlePopstate);

  return null;
}

export function useHasClientHistory() {
  const index = useClientHistoryStore((state) => state.index ?? 0);
  if (hasNavigation) {
    return navigation.currentEntry.index > 0;
  } else {
    return index > 0;
  }
}

export const getHasClientHistory = () => {
  if (!hasNavigation) {
    const keys = sessionStorage.getItem(sessionKey)?.split(',') ?? [];
    const current = history.state.key;
    const index = keys.indexOf(current);
    return index > 0;
  } else return navigation.currentEntry.index > 0;
};

// export function BackButton({ children }: { children: React.ReactElement }) {
//   const router = useRouter();
//   const index = useClientHistoryStore((state) => state.index ?? 0);

//   const handleClick = (...[url, as, options]: Parameters<typeof router.push>) => {
//     if (hasNavigation) {
//       navigation.currentEntry.index > 0 ? router.back() : router.push(url, as, options);
//     } else {
//       index > 0 ? router.back() : router.push(url, as, options);
//     }
//   };

//   return cloneElement(children, { onClick: handleClick });
// }
