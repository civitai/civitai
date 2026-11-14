import { deserialize } from '$app/forms';
import { invalidateAll } from '$app/navigation';
import { getContext, setContext, untrack } from 'svelte';
import {
  closeWhatsNew,
  syncWhatsNew,
  whatsNewShowing,
  type DismissDeps,
  type DismissState,
} from './whats-new-dismiss';

type WhatsNewView = { readonly showing: boolean; close: () => void };

const KEY = Symbol('whats-new');

/** Posts to the `dismissWhatsNew` action of the page that sent the copy (/home and /play both answer it). */
async function sendDismiss(path: string) {
  const response = await fetch(`${path}?/dismissWhatsNew`, {
    method: 'POST',
    body: new FormData(),
    headers: { accept: 'application/json' },
  });
  return deserialize(await response.text()).type === 'success';
}

/** The root layout's dismiss state, shared with its pages through context. */
export function provideWhatsNew(opts: {
  sent: () => boolean;
  userId: () => number | null;
  path: () => string;
}): WhatsNewView {
  const state = $state<DismissState>({ hidden: false, checked: false });
  const sent = $derived(opts.sent());
  const showing = $derived(whatsNewShowing(sent, state));
  const deps: DismissDeps = {
    get userId() {
      return opts.userId();
    },
    storage: () => localStorage,
    send: () => sendDismiss(opts.path()),
    refresh: () => invalidateAll(),
  };
  // Effects run only in the browser, so the server never renders the dialog for a player whose marker says seen.
  $effect(() => {
    const now = sent;
    untrack(() => syncWhatsNew(state, now, deps));
  });
  return setContext<WhatsNewView>(KEY, {
    get showing() {
      return showing;
    },
    close: () => closeWhatsNew(state, deps),
  });
}

export const whatsNewView = () => getContext<WhatsNewView>(KEY);
