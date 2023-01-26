import { useWindowEvent } from '@mantine/hooks';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import create from 'zustand';
import { immer } from 'zustand/middleware/immer';
import createContext from 'zustand/context';

// partial support navigation api - https://caniuse.com/?search=window.navigation
const isClient = typeof window !== 'undefined';
const hasNavigation = isClient && !!window.navigation;

type HistoryStore = {
  index: number;
  keys: string[];
  pushKey: (key: string) => void;
  setKey: (key: string) => void;
};

const { Provider, useStore } = createContext<ReturnType<typeof createMyStore>>();
const createMyStore = (initialState: { index: number; keys: string[] }) => {
  return create<HistoryStore>()(
    immer((set, get) => ({
      ...initialState,
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
};
export const HistoryProvider = ({ children }: { children: React.ReactElement }) => {
  return (
    <Provider
      createStore={() => createMyStore({ index: 0, keys: isClient ? [history.state.key] : [] })}
    >
      <HistoryEventsRegister>{children}</HistoryEventsRegister>
    </Provider>
  );
};

const HistoryEventsRegister = ({ children }: { children: React.ReactElement }) => {
  const setKey = useStore((state) => state.setKey);
  const pushKey = useStore((state) => state.pushKey);

  useEffect(() => {
    const pushState = history.pushState;
    history.pushState = function (data, unused, url) {
      pushKey(data.key);
      return pushState.apply(history, [data, unused, url]);
    };
    return () => {
      history.pushState = pushState;
    };
  }, []);

  const handlePopstate = (e: any) => setKey(e.state.key);
  useWindowEvent('popstate', handlePopstate);

  return children;
};

export const useNavigateBack = () => {
  const router = useRouter();

  const index = useStore((state) => state.index);

  const handleBack = (...[url, as, options]: Parameters<typeof router.push>) => {
    if (hasNavigation) {
      navigation.currentEntry.index > 0 ? router.back() : router.push(url, as, options);
    } else {
      index > 0 ? router.back() : router.push(url, as, options);
    }
  };

  return { back: handleBack };
};
