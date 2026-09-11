// The seam between the flow UI and whatever hosts it (docs/training-studio-web-component.md).
// Today the SvelteKit shell wires it in +layout.svelte from $app/$env; the web-component wrapper
// will wire it from host-injected props. Flow code imports from here — never from $app/* or $env/*.

import type { StudioBackend } from './backend';

export const browser = typeof window !== 'undefined';

export const isDev = import.meta.env.DEV;

/** The studio's navigable surfaces. The HOST owns the URL space — flow code describes where to go in
 *  studio terms and the host maps it onto its own routes (standalone: `/`, `/new`, `/<id>`; an embed
 *  chooses its own). Flow code never hardcodes a path. */
export type StudioLocation =
  | { view: 'home' }
  | { view: 'new' }
  | { view: 'run'; workflowId: string };

export interface HostContext {
  /** Every read/write the flow performs — the shell's /api fetches or the element's direct SDK calls. */
  backend: StudioBackend;
  config: {
    /** Cloudflare Images base for avatar/media keys (PUBLIC_IMAGE_LOCATION in the shell). */
    imageLocation: string | null;
    /** SignalR endpoint; null => the app runs on polling alone (PUBLIC_SIGNALS_ENDPOINT in the shell). */
    signalsEndpoint: string | null;
  };
  /** The host's URL for a location — for real `<a href>`s (middle-click / open-in-new-tab). */
  hrefFor: (loc: StudioLocation) => string;
  /** `refreshAll` = server data is stale everywhere (e.g. Buzz was just spent) — the host must re-read
   *  it all, not just render the target (Kit `invalidateAll` in the shell). */
  navigate: (loc: StudioLocation, opts?: { refreshAll?: boolean }) => Promise<void>;
  /** Re-run the host's data load for a dependency key (Kit `invalidate` in the shell). */
  refresh: (key: string) => Promise<void>;
  /** Where portalled UI (dialogs, select/tooltip content) should land. The element supplies its
   *  body-level portal root (an ancestor `container-type` on the embedding page makes it the
   *  containing block for `position: fixed`, so un-portalled overlays center against the wrong box,
   *  and the scoped CSS only reaches nodes under a scope root). Unset in the shell — its styles are
   *  global, so the default bits-ui portal to <body> is correct. */
  portalTarget?: () => Element | undefined;
}

// Module scope is safe on the server: the shell sets a user-independent value (env config + function
// refs) identically on every request, and navigate/refresh only run in the browser.
let ctx: HostContext | null = null;

export function setHostContext(next: HostContext) {
  ctx = next;
}

function host(): HostContext {
  if (!ctx)
    throw new Error(
      'host context not set — the shell must setHostContext() before the flow renders'
    );
  return ctx;
}

export const hostConfig = () => host().config;
export const backend = () => host().backend;
export const hrefFor = (loc: StudioLocation) => host().hrefFor(loc);
export const navigate = (loc: StudioLocation, opts?: { refreshAll?: boolean }) =>
  host().navigate(loc, opts);
export const refresh = (key: string) => host().refresh(key);
export function portalProps(): { to?: Element; disabled?: boolean } {
  const target = host().portalTarget?.();
  return target ? { to: target } : {};
}
