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
  };

  /** Host-owned navigation (publish handoff, model links, "leave the studio"). The component
   *  never does top-level navigation itself when embedded. */
  navigate(url: string): void;
}
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
