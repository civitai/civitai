import React, { createContext, useContext, useEffect, useRef } from 'react';
import { createStore, useStore } from 'zustand';
import { useCivitaiSessionContext } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { Flags } from '~/shared/utils/flags';
import { setCookie } from '~/utils/cookies-helpers';
import { createDebouncer } from '~/utils/debouncer';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isEqual } from 'lodash-es';
import { devtools } from 'zustand/middleware';
import type { NsfwLevel } from '~/server/common/enums';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import { useDomainColor } from '~/hooks/useDomainColor';
import type { UserSettingsSchema } from '~/server/schema/user.schema';

const Context = createContext<ContentSettingsStore | null>(null);

const debouncer = createDebouncer(1000);
export function BrowserSettingsProvider({ children }: { children: React.ReactNode }) {
  const domain = useDomainColor();
  const { type, settings } = useCivitaiSessionContext();
  const queryUtils = trpc.useUtils();
  const { mutate } = trpc.user.updateContentSettings.useMutation({
    onSuccess: (_, variables) => {
      const changedSettings: Partial<UserSettingsSchema> = {};
      if (variables.allowAds !== undefined) changedSettings.allowAds = variables.allowAds;
      if (variables.disableHidden !== undefined)
        changedSettings.disableHidden = variables.disableHidden;

      if (Object.keys(changedSettings).length === 0) return;

      queryUtils.user.getSettings.setData(undefined, (old) => {
        if (!old) return old;
        return { ...old, ...changedSettings } satisfies UserSettingsSchema;
      });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to update settings',
        error: new Error(error.message),
      });
    },
  });

  const snapshotRef = useRef<Partial<StoreState>>({});
  const storeRef = useRef<ContentSettingsStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createContentSettingsStore({ ...settings, domain });
    snapshotRef.current = settings;
  }

  useEffect(() => {
    if (storeRef.current) {
      const currentStore = storeRef.current.getState();
      const prevSnapshot = snapshotRef.current;

      // Smart merge: only apply incoming values for fields the user hasn't changed locally.
      // A field is "locally dirty" if its store value differs from our last-known snapshot.
      // This prevents a stale session refresh from reverting a toggle the user just made.
      const merged: Partial<StoreState> = {};
      for (const key of Object.keys(settings) as (keyof typeof settings)[]) {
        const locallyDirty = !isEqual(currentStore[key], prevSnapshot[key]);
        if (!locallyDirty) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (merged as any)[key] = settings[key];
        }
      }

      if (Object.keys(merged).length > 0) {
        storeRef.current.setState(merged);
      }
      // Update snapshot to reflect what the server sent, so future local changes
      // are correctly detected as dirty against this new baseline.
      snapshotRef.current = settings;
    }
  }, [settings]);

  useEffect(() => {
    const store = storeRef.current;
    if (!store || type === 'unauthed') return;
    const unsubscribe = store.subscribe(({ setState, ...curr }, prev) => {
      // Set disableHidden cookie immediately (outside debouncer) so a page refresh
      // within the 1s debounce window still preserves the user's choice.
      // TODO.hiddenPreferences - remove this once `disableHidden` comes in with rest of user settings
      if (curr.disableHidden !== prev.disableHidden) setCookie('disableHidden', curr.disableHidden);

      debouncer(() => {
        const changed = getChanged({ ...curr, domain }, { ...snapshotRef.current, domain });
        if (Object.keys(changed).length > 0) {
          // The reason why we pass domain it's cause that way we can store the content values on different places depending
          // on how it makes sense. For instance, for RED - Browssing level is stored under the name `redBrowsingLevel` inside the user settings.
          mutate({
            ...changed,
            domain,
          });
          snapshotRef.current = curr;
        }
      });
    });
    return () => {
      unsubscribe();
    };
  }, [domain, mutate, type]);

  return <Context.Provider value={storeRef.current}>{children}</Context.Provider>;
}

function getChanged<T extends Record<string, unknown>>(curr: T, prev: T) {
  return Object.keys(curr).reduce<Partial<T>>((acc, key) => {
    if (!isEqual(curr[key], prev[key])) return { ...acc, [key]: curr[key] };
    return acc;
  }, {});
}

export function useBrowsingSettings<T>(selector: (state: StoreState & StoreStateActions) => T) {
  const store = useContext(Context);
  if (!store) throw new Error('Missing ContentSettingsProvider');
  return useStore(store, selector);
}

type StoreState = {
  showNsfw: boolean;
  blurNsfw: boolean;
  browsingLevel: number;
  disableHidden: boolean;
  allowAds: boolean;
  autoplayGifs: boolean;
  domain: ColorDomain;
};

type SetStateCallback = (state: StoreState) => Partial<StoreState>;

type StoreStateActions = {
  setState: (args: Partial<StoreState> | SetStateCallback) => void;
};

type ContentSettingsStore = ReturnType<typeof createContentSettingsStore>;
function createContentSettingsStore(state: StoreState) {
  return createStore<StoreState & StoreStateActions>()(
    devtools(
      (set) => ({
        ...state,
        setState: (args) =>
          set((state) => {
            return typeof args === 'function' ? args(state) : args;
          }),
      }),
      { name: 'browing settings' }
    )
  );
}

export function useToggleBrowsingLevel() {
  const setState = useBrowsingSettings((x) => x.setState);
  return function (level: NsfwLevel) {
    setState((state) => ({
      browsingLevel: Flags.hasFlag(state.browsingLevel, level)
        ? Flags.removeFlag(state.browsingLevel, level)
        : Flags.addFlag(state.browsingLevel, level),
    }));
  };
}
