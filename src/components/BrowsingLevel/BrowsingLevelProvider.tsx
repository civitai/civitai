import React, { createContext, useContext, useDeferredValue, useEffect, useState } from 'react';
import {
  BrowsingLevel,
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { useCookies } from '~/providers/CookiesProvider';
import { Flags } from '~/shared/utils';
import { setCookie } from '~/utils/cookies-helpers';
import { createStore, useStore } from 'zustand';
import { trpc } from '~/utils/trpc';
import { useDebouncer } from '~/utils/debouncer';
import { useSession } from 'next-auth/react';
import { useDebouncedValue, useDidUpdate } from '@mantine/hooks';
import { deleteCookie } from 'cookies-next';

type StoreState = {
  showNsfw: boolean;
  blurNsfw: boolean;
  browsingLevel: number;
  disableHidden?: boolean;
};
type BrowsingModeStore = ReturnType<typeof createBrowsingModeStore>;
const createBrowsingModeStore = (props: StoreState) =>
  createStore<StoreState>(() => ({ ...props }));

function useBrowsingModeStore<T>(selector: (state: StoreState) => T) {
  const store = useContext(BrowsingModeCtx);
  if (!store) throw new Error('missing BrowsingModeProvider');
  return useStore(store, selector);
}

const BrowsingModeCtx = createContext<BrowsingModeStore | null>(null);
export function useBrowsingModeContext() {
  const store = useContext(BrowsingModeCtx);
  if (!store) throw new Error('missing BrowsingModeProvider');
  return {
    ...store,
    useStore: useBrowsingModeStore,
    toggleShowNsfw: (showNsfw?: boolean) =>
      store.setState((state) => {
        const _showNsfw = showNsfw ?? !state.showNsfw;
        // const browsingLevel = getBrowsingLevelFromShowNsfw(_showNsfw);
        // return { showNsfw: _showNsfw, browsingLevel };
        return { showNsfw: _showNsfw };
      }),
    toggleBlurNsfw: (blurNsfw?: boolean) =>
      store.setState((state) => ({ blurNsfw: blurNsfw ?? !state.blurNsfw })),
    toggleBrowsingLevel: (level: BrowsingLevel) => {
      store.setState((state) => {
        const instance = state.browsingLevel;
        const browsingLevel = !instance
          ? level
          : Flags.hasFlag(instance, level)
          ? Flags.removeFlag(instance, level)
          : Flags.addFlag(instance, level);
        return { browsingLevel };
      });
    },
    toggleDisableHidden: (hidden?: boolean) =>
      store.setState((state) => ({ disableHidden: hidden ?? !state.disableHidden })),
  };
}

function updateCookieValues({ browsingLevel, blurNsfw, showNsfw, disableHidden }: StoreState) {
  setCookie('level', browsingLevel);
  setCookie('blur', blurNsfw);
  setCookie('nsfw', showNsfw);
  setCookie('disableHidden', disableHidden);
  deleteCookie('mode');
}

export function BrowsingModeProvider({ children }: { children: React.ReactNode }) {
  const { status, data } = useSession();
  const isAuthed = status === 'authenticated';
  const currentUser = data?.user;
  const debouncer = useDebouncer(1000);
  const cookies = useCookies();
  const { mutate } = trpc.user.updateBrowsingMode.useMutation();
  const [store, setStore] = useState(createBrowsingModeStore(getStoreInitialValues()));

  function getStoreInitialValues() {
    if (!currentUser) return { showNsfw: false, blurNsfw: true, browsingLevel: 0 };

    let showNsfw = currentUser.showNsfw;
    let browsingLevel = currentUser.browsingLevel;
    // if cookies.mode is present, then this is the user's first time accessing this feature
    if (cookies.mode) {
      showNsfw = false;
      browsingLevel = allBrowsingLevelsFlag;
    }

    return {
      showNsfw,
      blurNsfw: currentUser.blurNsfw,
      browsingLevel,
      disableHidden: cookies.disableHidden,
    };
  }

  useDidUpdate(() => {
    if (isAuthed) {
      setStore(createBrowsingModeStore(getStoreInitialValues()));
    }
  }, [isAuthed]);

  // update the cookie to reflect the browsingLevel state of the current tab
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (store && document.visibilityState === 'visible') updateCookieValues(store.getState());
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [store]);

  useEffect(() => {
    if (store && isAuthed) {
      return store.subscribe((state, prevState) => {
        updateCookieValues(state);
        const disableHiddenChanged = state.disableHidden !== prevState.disableHidden;
        if (currentUser && !disableHiddenChanged) debouncer(() => mutate({ ...state }));
      });
    }
  }, [store, isAuthed]);

  return <BrowsingModeCtx.Provider value={store}>{children}</BrowsingModeCtx.Provider>;
}

const BrowsingModeOverrideCtx = createContext<{
  browsingLevelOverride?: number;
  setBrowsingLevelOverride?: React.Dispatch<React.SetStateAction<number | undefined>>;
}>({});
export const useBrowsingModeOverrideContext = () => useContext(BrowsingModeOverrideCtx);
export function BrowsingModeOverrideProvider({
  children,
  browsingLevel,
}: {
  children: React.ReactNode;
  browsingLevel?: number;
}) {
  const [browsingLevelOverride, setBrowsingLevelOverride] = useState(browsingLevel);

  useDidUpdate(() => setBrowsingLevelOverride(browsingLevel), [browsingLevel]);

  return (
    <BrowsingModeOverrideCtx.Provider value={{ browsingLevelOverride, setBrowsingLevelOverride }}>
      {children}
    </BrowsingModeOverrideCtx.Provider>
  );
}

/** returns the user selected browsing level or the system default browsing level */
export function useBrowsingLevel() {
  const { browsingLevelOverride } = useBrowsingModeOverrideContext();
  const { useStore } = useBrowsingModeContext();
  const browsingLevel = useStore((x) => x.browsingLevel);
  const showNsfw = useStore((x) => x.showNsfw);
  if (browsingLevelOverride) return browsingLevelOverride;
  if (!showNsfw) return publicBrowsingLevelsFlag;
  return !browsingLevel ? publicBrowsingLevelsFlag : browsingLevel;
}

export function useBrowsingLevelDebounced() {
  const browsingLevel = useBrowsingLevel();
  const [debounced] = useDebouncedValue(browsingLevel, 500);
  return useDeferredValue(debounced ?? browsingLevel);
}

// export function useIsPublicBrowsingLevel() {
//   const level = useBrowsingLevelDebounced();
//   return getIsPublicBrowsingLevel(level);
// }

export function useIsBrowsingLevelSelected(level: BrowsingLevel) {
  const { useStore } = useBrowsingModeContext();
  const browsingLevel = useStore((x) => x.browsingLevel);
  return Flags.hasFlag(browsingLevel, level);
}
