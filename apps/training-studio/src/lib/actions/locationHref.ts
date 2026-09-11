import type { Action } from 'svelte/action';
import { hrefFor, navigate, type StudioLocation } from '$lib/host';

/** Anchor to a StudioLocation: sets the real href (middle-click / open-in-new-tab keep working)
 *  and routes plain left-clicks through host.navigate — a plain `<a href>` inside the embedded
 *  element would full-page-load the host. */
export const locationHref: Action<HTMLAnchorElement, StudioLocation> = (node, loc) => {
  let current = loc;

  function apply(next: StudioLocation) {
    current = next;
    node.setAttribute('href', hrefFor(next));
  }

  function onClick(event: MouseEvent) {
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    void navigate(current);
  }

  apply(loc);
  node.addEventListener('click', onClick);

  return {
    update: apply,
    destroy() {
      node.removeEventListener('click', onClick);
    },
  };
};
