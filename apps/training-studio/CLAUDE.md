# apps/training-studio

> 🔴 **No commit or push without BOTH gates passed, in order:**
> 1. **Adversarial review** — run the review agents (`/svelte-review`: correctness + idiom + abstraction)
>    over the segment and resolve the findings.
> 2. **The maintainer's personal review + explicit OK** — a human reads the diff and says commit. This is
>    a separate, required step; passing tests, a green build, or "go on"/"continue" is **not** it.
>
> Until both are done, leave changes in the working tree and ask. Applies to every commit, on any branch.

**Follow [`docs/svelte-app-standard.md`](../../docs/svelte-app-standard.md)** — the shared conventions
for every SvelteKit app here (runes, derive-the-promise, keyed loops, form actions, `@civitai/ui`,
`text-dark-2`, placement, comments, the three review agents).

The Training Studio is the LoRA training UI — a slicker replacement for the in-app trainer
(`src/components/Training/**`), built as a **separate app** that can be extracted later. Its training
**data** comes from the orchestrator, not the repo DB. It follows the moderator app's spoke shape:
`@civitai/auth` (session gate), `@civitai/brand` (favicon), plus `@civitai/db` + `@civitai/redis` used
for ONE thing — minting the user's short-lived orchestrator token in-app (a `System` `ApiKey` row +
a redis get-or-mint cache; see `src/lib/server/{db,redis,orchestrator-token}.ts`). No `@civitai/clickhouse`.

## The flow (build to this)

The clickable design of record is checked in — **open it before writing UI**:
`docs/prototype/training-flow.html` (and `screen-*.html`). Four steps, then a decision:

1. **Select** — pick a **type** (Character/Style/Concept/Effect) → auto-recommends a base model. Cards
   are ecosystems grouped by media (image types show image models; Effect shows video), each with
   **versions** (latest-default + a **Custom…** option), a from-price, and a **label-type lock** (a
   dataset is tags *or* captions — mixing is disabled, explained on hover). Multi-run is a secondary
   "Add another model". ← **built** (`src/routes/SelectStep.svelte`)
2. **Data & labels** — upload / from-my-generations / reuse a dataset; auto-labeled free in the format
   the model needs (tags vs captions **derived from the model**, never asked); per-image edit + relabel;
   optional trigger word (model-dependent). ← next
3. **Review & start** — Steps as the primary field shown as **"each image seen ~N×"** with a low
   warning; type acts as a preset; advanced collapsed; sample prompts; whatif price; Start.
4. **Results (live)** — progress header (step/checkpoint, no loss/LR), epoch cards stream in; then
   Publish / Generate / Save+Download / Train further / Remix.

Landing is **My trainings** (`src/routes/MyTrainings.svelte`) — the reconnect surface; "New training"
enters the flow.

## Architecture decisions (settled 2026-08-27 team review — don't re-litigate)

- **No database for training DATA. Orchestrator is the source of truth.** Draft workflows (30-day TTL,
  per-user gated) hold the in-progress dataset/captions/settings; Start turns the draft into a real
  workflow. (The `@civitai/db` dep is ONLY for minting the orchestrator token — an `ApiKey` row — never
  for training state.)
- **Per-blob upload, no zip.** Scan on upload (same policy as generation). Auto-label over signals.
- **Live training over signals** (step/checkpoint; near-real-time possible). Generate/Publish operate
  off the **workflow ID / AIR**, not a `ModelVersion`.
- **AI-Toolkit only** (Kohya stays in the in-app trainer). Trigger word is **model-dependent** (large/
  video models can't train it — confirm per-model with Atif before enforcing).

## Model catalog

`src/lib/data/trainingModels.ts` is a **vendored mirror** of the main app's `src/utils/training.ts`
`trainingModelInfo` (an `apps/*` package can't import from the main app's `src/`). All ~21 ecosystems
are present, grouped by family with versions. Re-mirror by hand when the trainer's list changes; if
`trainingModelInfo` ever moves to a `packages/civitai-*`, import it instead.

## Previewing the UI without OAuth

`hooks.server.ts` has a **dev-only** bypass: in `vite dev` with `TRAINING_STUDIO_DEV_LOGIN=1` (set in
`.env`) it injects a stub user and skips the guard (dead code in the built server). `pnpm dev:training-studio`
→ http://localhost:5173. Screenshot with a headless browser to iterate.

## Deltas

- **Auth allows any signed-in user.** Training is a normal user feature, so the spoke guard in
  `src/lib/server/auth.ts` requires only a resolved session (`(user) => !!user`) — NOT `isModerator`.
  `hooks.server.ts` sends an unauthenticated request to the hub login and a forbidden one to
  civitai.com.

## Non-negotiables

Duplicated in every SvelteKit app's `CLAUDE.md` because this file always loads and the standard is one
link away. Full reasoning: [`docs/svelte-app-standard.md`](../../docs/svelte-app-standard.md).

- **Derive the promise; never fetch in `$effect` and assign to `$state`.** It gives a stuck spinner, a
  re-run loop, or a stale response landing on a newer lookup. `const x = $derived(browser ? fetch(...).then(r => r.json()) : null)`, then `{#await x}`.
- **Every `{#await}` needs a `{:catch}`.** Without one a rejection is silent and the panel never fills in.
- **Key every `{#each}` on something unique.** An unkeyed or duplicate-keyed loop reuses the wrong DOM
  node, so a row's action button ends up wired to a different row. Correctness, not lint.
- **A custom `use:enhance` callback must call `applyAction`.** It replaces the default handling, so
  without it every `fail()` is discarded and a refused action looks like a successful one.
- **Optimistic UI must revert on failure.**
- **Treat 0 affected rows as a failure, not a success.**
- **A `$bindable` prop passed one-way can latch.** Use function bindings —
  `bind:checked={() => expr, (v) => handler(v)}` — whenever the parent owns the state.
- **`typecheck`, never `check` — and `build` is not a check.** Both run `svelte-kit sync`, which fights
  the dev server's watcher. Read `svelte-check`'s **WARNING** lines too: `state_referenced_locally` is a
  real bug and appears nowhere else.
- **Before calling a segment done**, run `svelte-correctness-review`, `svelte-idiom-review` and
  `svelte-abstraction-review` (or the `/svelte-review` skill) — then **look at the page**.
