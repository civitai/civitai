import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { createStore, useStore } from 'zustand';
import type { UserSettings } from '~/server/services/user.service';
import { useDebouncer } from '~/utils/debouncer';
import { isEqual } from 'lodash-es';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';

const Context = createContext<Store | null>(null);
export function UserSettingsProvider({
  settings,
  children,
}: {
  settings: UserSettings;
  children: React.ReactNode;
}) {
  const debouncer = useDebouncer(1000);
  const currentUser = useCurrentUser();
  const [store] = useState(() => {
    let allowAds = settings.allowAds;
    if (!currentUser?.isPaidMember) allowAds = true;
    return createSettingsStore({
      ...settings,
      allowAds,
    });
  });
  const snapshotRef = useRef<Partial<StoreState> | null>(null);
  if (!snapshotRef.current) snapshotRef.current = store.getState();

  // TODO - need a way to trigger fetch without debouncer
  useEffect(() => {
    if (!currentUser) return;
    const unsubscribe = store.subscribe((curr, prev) => {
      debouncer(() => {
        const snapshot = snapshotRef.current ?? {};
        const changed = getChanged(curr, snapshot);
        if (!Object.keys(changed).length) return;
        fetch('/api/user/settings', {
          method: 'POST',
          body: JSON.stringify(changed),
          headers: { 'Content-Type': 'application/json' },
        })
          .then(async (res) => {
            if (!res.ok) throw new Error(await res.text());
            snapshotRef.current = curr;
          })
          .catch((error) => {
            const reverseChanged = getChanged(snapshot, curr);
            curr.setState(reverseChanged);
            if (error instanceof Error)
              showErrorNotification({
                title: 'Failed to update user settings',
                error,
              });
          });
      });
    });
    return unsubscribe;
  }, [store, currentUser, debouncer]);

  return <Context.Provider value={store}>{children}</Context.Provider>;
}

type Store = ReturnType<typeof createSettingsStore>;
type StoreState = UserSettings;
type SetStateCallback = (state: StoreState) => Partial<StoreState>;
type StoreStateActions = {
  setState: (args: Partial<StoreState> | SetStateCallback) => void;
};

function createSettingsStore(props: UserSettings) {
  return createStore<StoreState & StoreStateActions>((set) => ({
    ...props,
    setState: (args) =>
      set((state) => {
        return typeof args === 'function' ? args(state) : args;
      }),
  }));
}

export function useUserSettings<T>(selector: (state: StoreState & StoreStateActions) => T) {
  const store = useContext(Context);
  if (!store) throw new Error('Missing ContentSettingsProvider');
  return useStore(store, selector);
}

function getChanged<T extends Record<string, unknown>>(curr: T, prev: T) {
  return Object.keys(curr).reduce<Partial<T>>((acc, key) => {
    if (!isEqual(curr[key], prev[key])) return { ...acc, [key]: curr[key] };
    return acc;
  }, {});
}
