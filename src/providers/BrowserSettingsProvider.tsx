import React, { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
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
import type { UserContentSettings } from '~/server/schema/user.schema';
import type { EventPointPops } from '~/shared/constants/event-point-pops.constants';

/**
 * Whether this viewer sees event cosmetics (worn hats) and Hat Turf. Reads true outside the
 * provider. Viewer-side only: it changes nothing about opt-in, stock or scoring.
 */
export function useShowEventCosmetics() {
  const store = useContext(Context);
  const preview = useContext(EventCosmeticsPreviewContext);
  const getSnapshot = () => preview || (store?.getState().showEventCosmetics ?? true);
  return useSyncExternalStore(store?.subscribe ?? noSubscription, getSnapshot, getSnapshot);
}

const EventCosmeticsPreviewContext = createContext(false);
/**
 * Shows event cosmetics inside whatever the setting: for a preview of the hat someone is picking,
 * fitting or buying, which is a control they opened, not content.
 */
export function EventCosmeticsPreview({ children }: { children: React.ReactNode }) {
  return (
    <EventCosmeticsPreviewContext.Provider value>{children}</EventCosmeticsPreviewContext.Provider>
  );
}

const Context = createContext<ContentSettingsStore | null>(null);

const debouncer = createDebouncer(1000);
export function BrowserSettingsProvider({ children }: { children: React.ReactNode }) {
  const domain = useDomainColor();
  const { type, settings } = useCivitaiSessionContext();
  const queryUtils = trpc.useUtils();
  const { mutate } = trpc.user.updateContentSettings.useMutation({
    onSuccess: (_, variables) => {
      // These lists are filtered on the server by these two, read from the session, which this
      // mutation has refreshed by the time it returns: the app image picker's posted list, a 3D
      // model's related posts, and a shop's services (mature ones show only at the viewer's
      // level). A list fetched before that was filtered at the old level. A no-op for a list
      // that has not been opened.
      if (variables.showNsfw !== undefined || variables.browsingLevel !== undefined) {
        void queryUtils.blockImagePicker.getPosted.reset();
        void queryUtils.creatorService.getForShop.reset();
        void queryUtils.model3d.getRelatedPosts.reset();
      }
      // A 3D model's related posts also leave out the viewer's hidden tags unless hiding is off.
      if (variables.disableHidden !== undefined) void queryUtils.model3d.getRelatedPosts.reset();

      // Patch every confirmed field into the getSettings React Query cache so
      // `CivitaiSessionProvider` sees the user's intent immediately, instead
      // of the stale `session.user.*` values that live behind the JWT cookie
      // until the next SignalR/session refresh. Without this the smart-merge
      // below would read store==snapshot (both true) as "not dirty" and
      // apply the stale server value, reverting the user's toggle.
      const changedSettings: Partial<UserContentSettings> = {};
      if (variables.allowAds !== undefined) changedSettings.allowAds = variables.allowAds;
      if (variables.disableHidden !== undefined)
        changedSettings.disableHidden = variables.disableHidden;
      if (variables.showNsfw !== undefined) changedSettings.showNsfw = variables.showNsfw;
      if (variables.blurNsfw !== undefined) changedSettings.blurNsfw = variables.blurNsfw;
      if (variables.autoplayGifs !== undefined)
        changedSettings.autoplayGifs = variables.autoplayGifs;
      if (variables.showEventCosmetics !== undefined)
        changedSettings.showEventCosmetics = variables.showEventCosmetics;
      if (variables.eventPointPops !== undefined)
        changedSettings.eventPointPops = variables.eventPointPops;

      if (Object.keys(changedSettings).length === 0) return;

      // Cancel any in-flight getSettings refetch so a stale response
      // (e.g. triggered by window focus) can't overwrite this update.
      queryUtils.user.getSettings.cancel();
      queryUtils.user.getSettings.setData(undefined, (old: UserContentSettings | undefined) => {
        if (!old) return old;
        return { ...old, ...changedSettings } satisfies UserContentSettings;
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

  // Event cosmetics are hidden on this device by its cookie too: the only place a signed-out
  // viewer's choice lives, and the first paint's answer before an account is read.
  useEffect(() => {
    const store = storeRef.current;
    if (!store) return;
    return store.subscribe((curr, prev) => {
      if (curr.showEventCosmetics !== prev.showEventCosmetics)
        setCookie('showEventCosmetics', curr.showEventCosmetics);
      if (curr.eventPointPops !== prev.eventPointPops)
        setCookie('eventPointPops', curr.eventPointPops);
    });
  }, []);

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
          // Cancel any in-flight getSettings refetch so a stale response
          // (e.g. triggered by window focus) can't overwrite the mutation's cache update.
          queryUtils.user.getSettings.cancel();
          mutate(changed);
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

const noSubscription = () => () => undefined;
/** `autoplayGifs` for components that can mount outside the provider, where it reads true. */
export function useAutoplayGifs() {
  const store = useContext(Context);
  const getSnapshot = () => store?.getState().autoplayGifs ?? true;
  return useSyncExternalStore(store?.subscribe ?? noSubscription, getSnapshot, getSnapshot);
}

type StoreState = {
  showNsfw: boolean;
  blurNsfw: boolean;
  browsingLevel: number;
  disableHidden: boolean;
  allowAds: boolean;
  autoplayGifs: boolean;
  showEventCosmetics: boolean;
  eventPointPops: EventPointPops;
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
