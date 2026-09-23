# Training Studio as a Web Component

Plan for extracting the Training Studio UI into a framework-agnostic web component
(`<civitai-training-studio>`) that runs in two hosts:

1. **Standalone** — training.civitai.com. The current SvelteKit app becomes a thin shell
   (auth, header, token minting) that mounts the component.
2. **Embedded** — the main Next.js app mounts the same component inside civitai.com.

The component is **pure client**. It holds no server routes and no secrets. Each host injects
credentials and config; the component calls the orchestrator (and signals) directly from the
browser with the injected user token. Minting stays server-side in whichever host is running.

## Why this shape

- The current app's 13 `/api/*` routes are almost all thin wrappers: verify session → mint/read
  the user's orchestrator token → one `@civitai/client` SDK call. Moving those calls into the
  browser removes the wrapper tier entirely; nothing of substance is lost.
- Signals already works exactly this way today (server mints a token at `/api/signals-token`,
  the browser connects to the signals host directly), so the pattern is proven in this app.
- An iframe was considered and rejected: it works, but the goal is a component the main app can
  compose (theme, navigation, layout), not a framed page.

## The injected contract

The host sets **JS properties** on the element (never attributes — credentials don't belong in
the DOM), before or after mount:

```ts
interface TrainingStudioHost {
  /** Called lazily and re-called after a 401 — orchestrator tokens are short-lived and a
   *  watched training outlives them. The host mints server-side and returns the raw token. */
  getOrchestratorToken(): Promise<string>;

  /** SignalR access token for live workflow updates. Null => component falls back to polling. */
  getSignalsToken(): Promise<string | null>;

  /** Spendable balances for the header/pricing UI. The buzz service is internal-only (no
   *  browser CORS), so this stays a host call. Null => balances hidden, flow still works. */
  getBuzzBalances(): Promise<{ yellow: number; green: number; blue: number } | null>;

  user: { id: number; username: string; image?: string };

  config: {
    orchestratorEndpoint: string; // e.g. https://orchestration-new.civitai.com
    signalsEndpoint: string | null;
    civitaiUrl: string;           // publish/model links
    orchestratorMode: 'dev' | 'prod';
    /** The host page's Buzz color (green domain vs yellow). When set, the component locks its
     *  Buzz spend mode to it — the user toggle hides and nothing is persisted to localStorage.
     *  Omit (standalone) to leave the user's own yellow⇄green toggle in charge. */
    buzzMode?: 'yellow' | 'green';
  };

  /** The host owns the URL space. Flow code describes destinations in studio terms; the host maps
   *  them onto its own routes. `hrefFor` exists so run cards render real <a href>s (middle-click,
   *  open-in-new-tab); `navigate` is the programmatic form. `refreshAll` marks server data stale
   *  everywhere (e.g. Buzz was just spent). Already implemented — see `src/lib/host.ts`. */
  hrefFor(loc: StudioLocation): string;
  navigate(loc: StudioLocation, opts?: { refreshAll?: boolean }): Promise<void>;

  /** Open the host page's own generator in place, seeded with an epoch's trained weights — no
   *  navigation (the main app opens its sidebar generation panel). Preferred over `generateUrl`
   *  when both are provided. */
  generate?(req: { air: string; workflowId: string; name: string }): void;

  /** URL for the main app's `/generate` deep link primed with an epoch's trained weights
   *  (`?air=<blob AIR>&workflowId=…&name=…`). Optional — omit both this and `generate` to hide
   *  the per-epoch Generate affordance. The component navigates same-tab for a relative URL,
   *  new-tab for an absolute one. */
  generateUrl?(req: { air: string; workflowId: string; name: string }): string;

  /** URL for the main app's publish entry (`/models/train/from-orchestrator?workflowId=…&epoch=…`),
   *  which builds a Draft model from the run's checkpoint and drops the user into the model wizard.
   *  Ownership is enforced there by re-fetching the workflow with the caller's own orchestrator
   *  token. Optional — omit to hide the Publish affordance. Same URL semantics as `generateUrl`:
   *  relative navigates same-tab, absolute opens a new tab. */
  publishUrl?(req: { workflowId: string; epoch: number }): string;

  /** URL for the run's model page, draft or published. The main app stamps
   *  `{ modelId, modelVersionId }` into the workflow's metadata when the publish entry creates the
   *  draft, and adds `published: true` when the model actually publishes; runs carrying a modelId
   *  render a "View draft" / "View your model page" link through this. Optional — omit to hide
   *  the affordance. Same URL semantics as `generateUrl`. */
  modelPageUrl?(req: { modelId: number }): string;

  /** Open the host's own model picker for the Custom training base (the main app's
   *  resource-select modal). The component passes the run's orchestrator ecosystem so a host
   *  that can map it pre-filters to compatible checkpoints. Resolves the picked model's
   *  checkpoint AIR (`urn:air:<eco>:checkpoint:civitai:<modelId>@<versionId>`) plus a display
   *  name; resolves null when the user cancels. Optional — omit and the component keeps its
   *  paste-an-AIR input alone. */
  pickModel?(req: { ecosystem?: string }): Promise<{ air: string; name?: string } | null>;
}

type StudioLocation = { view: 'home' } | { view: 'new' } | { view: 'run'; workflowId: string };
```

Everything else the current server does — session gating, the Flipt closed-beta segment,
`TRAINING_STUDIO_DEV_LOGIN` — is a **host concern**: the host decides whether to render the
component at all.

## Direct-call surface (browser → service, with the injected token)

Derived from the current `+server.ts` routes. Every row below is today a server wrapper around
the same SDK call; in the component it becomes a browser call.

| Operation | SDK / endpoint | Today's route |
| --- | --- | --- |
| Submit training (+ whatif price) | `submitWorkflow` | `POST /api/train` |
| List my trainings | `queryWorkflows` (tag-filtered) | `GET /api/trainings` |
| Run detail / dataset | `getWorkflow` | `GET /api/run-dataset` |
| Train further (quote + submit) | `getWorkflow` + `submitWorkflow` | `/api/continue-training` |
| Rename a run | `updateWorkflow` | `POST /api/rename` |
| Import from generations | `queryWorkflows` | `GET /api/generations` |
| Blob upload URL | `getConsumerBlobUploadUrl` | `GET /api/upload-url` |
| Auto-label (submit + poll) | `submitWorkflow` / `getWorkflow` | `/api/auto-label` |
| Dataset blob fetch | consumer blobs GET, `Authorization: Bearer` | `GET /api/dataset-blob` |
| Live trace tail | streaming-blobs GET (no auth today) | direct in prod already |

Stays host-side (not orchestrator-backed or not user-token-backed):

- **Orchestrator token minting** — `@civitai/db` ApiKey row + redis cache (standalone shell) /
  `getOrchestratorToken` (main app).
- **Signals token minting** — internal signals endpoint.
- **Buzz balances** — internal buzz service (`BUZZ_ENDPOINT`), no browser CORS.

## CORS requirement

The orchestrator API and the consumer-blobs/streaming-blobs hosts must send CORS headers
(including `Authorization` in `Access-Control-Allow-Headers`) for **every origin that hosts the
component** — the component's fetches carry the *host page's* origin, not the component's.
Both required origins are confirmed allowed (2026-09-10):

- `https://training.civitai.com` (standalone)
- `https://civitai.com` (embedded)

A new embedding origin (another spoke, a partner surface) needs adding to the orchestrator's
allowlist before the component works there.

## Decomposition

- **Component**: the four-step flow, My trainings, run detail (live progress, epochs, train
  further, remix), label editor — everything under `src/routes/*.svelte` + `[id]/` today.
- **Shell (standalone host)**: hooks auth gate, closed-beta page, header chrome (avatar,
  logout), favicon, and the three host callbacks above backed by the existing
  `lib/server/{orchestrator-token,signals,buzz}.ts`.
- **Main app (embedded host)**: implements the same three callbacks with its existing
  orchestrator/buzz infra; mounts the element on a page/route it owns.

## Packaging notes

- Svelte compiles components to custom elements (`customElement: true`); the component ships as
  one JS bundle + injected styles. SvelteKit-specific imports (`$app/*`, `$env/*`) must be
  replaced with the injected `config` — they don't exist outside the Kit runtime.
- Shadow DOM gives style isolation from Mantine; Tailwind v4 + the `@civitai/ui` theme
  variables get injected into the shadow root at construction.
- The main app pays the Svelte runtime + component bundle once, lazy-loaded on the route that
  mounts it. Measure before shipping.

## Security posture change

A user-scoped orchestrator token moves from server-only into browser memory (never DOM, never
storage). Mitigations: short TTL, provider-refresh on 401, scope limited to the user's own
workflows (already enforced orchestrator-side). This is new exposure relative to today and
needs a security sign-off before the embed ships.

## Staging

1. **Detach from Kit runtime** — replace `$app`/`$env` usage inside the flow components with an
   injected context; the SvelteKit app keeps working (shell provides the context).
2. **Lift the calls** — move the SDK calls from `lib/server` into a client `lib/api` that takes
   the token provider; delete the wrapper routes as each screen cuts over. The standalone app
   is now shell + component in one repo.
3. **Package** — build the custom-element bundle; embed it in the main app behind its flag.

Stage 1–2 are refactors of this app with no behavior change; stage 3 is where the main-app work
and the CORS verification land.
