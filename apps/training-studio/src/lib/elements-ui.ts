import { getContext, setContext } from 'svelte';

const KEY = Symbol('elements-ui');

/** Whether this viewer gets the Civitai Elements redesign (the `ELEMENTS_UI_FLAG_KEY` gate). Set once by
 *  the flow, read by shared components below it, so steps don't thread a prop through. */
export function setElementsUi(enabled: () => boolean): void {
  setContext(KEY, enabled);
}

export function useElementsUi(): () => boolean {
  return getContext<(() => boolean) | undefined>(KEY) ?? (() => false);
}
