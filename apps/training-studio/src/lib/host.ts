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

/** What "generate with this epoch" hands the main app's generator: the epoch's LoRA blob AIR, the
 *  training run the server verifies ownership against, and a display label for the resource. */
export interface GenerateRequest {
  air: string;
  workflowId: string;
  name: string;
}

/** What "publish this run" hands the main app: the training run and the checkpoint to build the
 *  draft model from. The main app re-fetches the workflow with the caller's own orchestrator token,
 *  so ownership is enforced server-side — everything else (name, base model) comes off the workflow. */
export interface PublishRequest {
  workflowId: string;
  epoch: number;
}

/** What "view this run's model" hands the host: the Civitai model stamped onto the workflow. */
export interface ModelPageRequest {
  modelId: number;
}

/** What the Custom-base "Browse models" affordance hands the host: the run's orchestrator
 *  ecosystem, so a host that knows how can pre-filter its picker to compatible checkpoints. */
export interface PickModelRequest {
  ecosystem?: string;
}

/** What the host's model picker resolves: the model's checkpoint AIR (the same shape the paste
 *  input takes) and, when the host has one, a display name for it. */
export interface PickedModel {
  air: string;
  name?: string;
}

export interface HostContext {
  /** Every read/write the flow performs — the shell's /api fetches or the element's direct SDK calls. */
  backend: StudioBackend;
  config: {
    /** Cloudflare Images base for avatar/media keys (PUBLIC_IMAGE_LOCATION in the shell). */
    imageLocation: string | null;
    /** SignalR endpoint; null => the app runs on polling alone (PUBLIC_SIGNALS_ENDPOINT in the shell). */
    signalsEndpoint: string | null;
    /** Whether this user may generate with UNPUBLISHED training results (the main app gates that
     *  on membership). Explicit `false` disables the per-epoch Generate affordance with an
     *  explanation; absent = unknown (a host with no membership knowledge, e.g. the standalone
     *  shell) and the affordance behaves as before. */
    canGenerateUnpublished?: boolean;
    /** The host's membership-plans page, linked from the explanation above (`hostLink` URL
     *  semantics). Absent => the explanation renders without a link. */
    pricingUrl?: string;
  };
  /** The host's URL for a location — for real `<a href>`s (middle-click / open-in-new-tab). */
  hrefFor: (loc: StudioLocation) => string;
  /** `refreshAll` = server data is stale everywhere (e.g. Buzz was just spent) — the host must re-read
   *  it all, not just render the target (Kit `invalidateAll` in the shell). */
  navigate: (loc: StudioLocation, opts?: { refreshAll?: boolean }) => Promise<void>;
  /** Re-run the host's data load for a dependency key (Kit `invalidate` in the shell). */
  refresh: (key: string) => Promise<void>;
  /** Open the host's own generator in place, seeded with an epoch's weights — no navigation.
   *  Preferred over `generateUrl` when both are provided (the embed's sidebar generator). */
  generate?: (req: GenerateRequest) => void;
  /** The host's URL for the main app's `/generate` deep link, primed with an epoch's weights.
   *  Absent (with `generate`) when the host has no generator to hand off to — the affordance
   *  hides. A relative URL is an in-host navigation; an absolute one opens the generator's
   *  origin in a new tab. */
  generateUrl?: (req: GenerateRequest) => string;
  /** The host's URL for the main app's publish-from-workflow entry (draft model + wizard), keyed on
   *  workflowId + epoch. Absent when the host has no publish surface — the affordance hides. Same
   *  URL semantics as `generateUrl`: relative = in-host same-tab, absolute = new tab. */
  publishUrl?: (req: PublishRequest) => string;
  /** The host's URL for the run's model page on Civitai — draft or published (a run carries its
   *  modelId from the moment a draft exists; see TrainingStudioMeta). Absent => the "view model"
   *  affordance hides. Same URL semantics as `generateUrl`. */
  modelPageUrl?: (req: ModelPageRequest) => string;
  /** Open the host's own model picker for the Custom base; resolves null when the user cancels.
   *  Absent => the studio keeps its paste-an-AIR input alone. */
  pickModel?: (req: PickModelRequest) => Promise<PickedModel | null>;
  /** Where portalled UI (dialogs, select/tooltip content) should land. The element supplies its
   *  body-level portal root (an ancestor `container-type` on the embedding page makes it the
   *  containing block for `position: fixed`, so un-portalled overlays center against the wrong box,
   *  and the scoped CSS only reaches nodes under a scope root). Unset in the shell — its styles are
   *  global, so the default bits-ui portal to <body> is correct. */
  portalTarget?: () => Element | undefined;
}

/** Interpret a host-returned URL per the seam contract above: only a host-relative URL is an
 *  in-host same-tab navigation; anything else (including protocol-relative) opens in a new tab.
 *  Returns spreadable anchor attrs so a call site can't forget the `noreferrer` half. */
export function hostLink(href: string): {
  href: string;
  target: '_blank' | undefined;
  rel: 'noreferrer' | undefined;
} {
  const external = !(href.startsWith('/') && !href.startsWith('//'));
  return {
    href,
    target: external ? '_blank' : undefined,
    rel: external ? 'noreferrer' : undefined,
  };
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
export const generate = () => host().generate;
export const generateUrl = () => host().generateUrl;
export const publishUrl = () => host().publishUrl;
export const modelPageUrl = () => host().modelPageUrl;
export const pickModel = () => host().pickModel;
export function portalProps(): { to?: Element; disabled?: boolean } {
  const target = host().portalTarget?.();
  return target ? { to: target } : {};
}
