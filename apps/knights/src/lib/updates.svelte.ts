import { invalidate } from '$app/navigation';
import { getContext, setContext, untrack } from 'svelte';
import {
  closeUpdates,
  syncUpdates,
  unseenNow,
  type Updates,
  type UpdatesDeps,
  type UpdatesState,
} from './updates';

export type UpdatesView = {
  readonly open: boolean;
  /** Entries not seen yet: the header button's dot, and the "New" marks in the dialog. */
  readonly unseen: number;
  show: () => void;
  close: () => void;
};

const KEY = Symbol('updates');

async function sendSeen() {
  const response = await fetch('/whats-new', { method: 'POST' });
  return response.ok;
}

/** The root layout's "What's new" entries dialog, shared with the header button through context. */
export function provideUpdates(opts: {
  updates: () => Updates | null;
  userId: () => number | null;
  /** Whether unseen entries may open the dialog by themselves on this page right now. */
  autoOpen: () => boolean;
}): UpdatesView {
  const state = $state<UpdatesState>({ open: false, seen: null, autoOpened: false });
  const updates = $derived(opts.updates());
  const deps: UpdatesDeps = {
    get userId() {
      return opts.userId();
    },
    storage: () => localStorage,
    send: sendSeen,
    refresh: () => invalidate('knights:header'),
  };
  // Effects run only in the browser, so the server never renders the dialog open.
  $effect(() => {
    const now = updates;
    const allowed = opts.autoOpen();
    untrack(() => syncUpdates(state, now, deps, allowed));
  });
  return setContext<UpdatesView>(KEY, {
    get open() {
      return state.open;
    },
    get unseen() {
      return unseenNow(updates, state);
    },
    show: () => (state.open = true),
    close: () => closeUpdates(state, updates, deps),
  });
}

export const updatesView = () => getContext<UpdatesView | undefined>(KEY);
