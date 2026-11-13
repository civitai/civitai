import { getContext, setContext } from 'svelte';
import { forgetDismissal, whatsNewShowing, type DismissState } from './whats-new-dismiss';

type WhatsNewView = { readonly state: DismissState; readonly showing: boolean };

const KEY = Symbol('whats-new');

/** The root layout's dismiss state, shared with its pages through context. */
export function provideWhatsNew(sent: () => boolean): WhatsNewView {
  const state = $state<DismissState>({ hidden: false, message: null });
  const showing = $derived(whatsNewShowing(sent(), state));
  $effect(() => forgetDismissal(state, sent()));
  return setContext<WhatsNewView>(KEY, {
    state,
    get showing() {
      return showing;
    },
  });
}

export const whatsNewView = () => getContext<WhatsNewView>(KEY);
