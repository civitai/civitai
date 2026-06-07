# Self-Hosted Generation Toggle

> Status: **Implemented** (branch `feat/self-hosted-generation-toggle`). The plan below is preserved for context; see **As-built** for what actually shipped and where it differs.

## Goal

Add a moderator toggle that controls generation requests routed to **Civitai's own GPUs/workers** (as opposed to external providers like FAL, Google, OpenAI). Like the existing global generation toggle, it has three states:

- `enabled` — everyone can use self-hosted ecosystems
- `memberOnly` — only members; free users are blocked from self-hosted ecosystems
- `disabled` — nobody can use self-hosted ecosystems (mods bypass)

The moderator UI is the easy part (mirrors the existing `GenerationStatusCard`). The hard part is **telling the client which ecosystems/base-models are affected** so it can (a) disable those `BaseModelInput` options, (b) show an alert when one is selected, and (c) disable the **Generate** button. That data rides along in the `generation.getGenerationConfig` response.

## As-built (what shipped)

The implementation followed the plan; the notable specifics and deviations:

### Server (as-built)

- **Classification** — `SELF_HOSTED_ECOSYSTEM_KEYS` (single source-of-truth list) in `basemodel.constants.ts`, stamped onto each `EcosystemRecord` as `selfHosted: true` at module load, plus `isSelfHostedEcosystem(key)`. (Decision 2: the flag lives on the record, fed by one list.)
- **Storage** — `selfHostedMode` added to `generationStatusSchema` (same Redis `generation:status` object). **No `selfHostedMessage`** — the self-hosted toggle is mode-only; the client shows fixed copy. `selfHostedUpdatedBy` audit stamp is kept.
- **Service** — `getSelfHostedDisabledEcosystems({ selfHostedMode, isMember, isModerator })` resolver (mods → `[]`; `disabled` → all; `memberOnly` → all for non-members). `getGenerationConfig` returns `selfHostedDisabledEcosystems` + `selfHostedMode`. `setSelfHostedGenerationStatus` mirrors `setGenerationStatus` and preserves the other's fields.
- **Enforcement** — done in `buildGenerationContext` (orchestration-new.service.ts), which adds `selfHostedDisabledEcosystems` to the server `externalCtx`. `generateFromGraph`/`whatIfFromGraph` → `validateInput` → `generationGraph.safeParse` runs the ecosystem-node refine, so a blocked ecosystem 400s server-side. (No separate check added to `orchestrator.router.ts` — the graph is the guard.)
- **Message masking** — the public `getStatus` route nulls `message` when `mode === 'enabled'` (message stays persisted in Redis; `getStatusModerator` still returns it raw for editing).

### Client (as-built)

- `GenerationCtx.selfHostedDisabledEcosystems`, populated in `GenerationFormProvider` via `useSelfHostedDisabledEcosystems()`.
- **Ecosystem node** keeps disabled keys in `compatibleEcosystems`, exposes `meta.disabledEcosystems`, and rejects them in the `output` refine. **Gotcha:** `meta` must be a **function** `(ctx, ext) => …` (not a static object) — the node factory only re-runs on its `['workflow','output']` deps, so a static meta never reflects the async-loaded `ext` (config). `_updateAllMeta` only recomputes function-form meta. A shared `getEcosystemLists(workflow, ext)` helper keeps the factory and meta in sync.
- **`BaseModelInput`** renders disabled items present-but-disabled with a badge (**"Members only"** yellow / **"Disabled"** gray) + tooltip, blocks click/Enter. Group display items (ZImage, Flux2Klein, LTXV) resolve to their **default ecosystem key** before the disabled check (their `key` is the group id, not an ecosystem key).
- **Alert + Generate button** — the self-hosted alert was moved out of `GenerationForm` into `FormFooter`'s `PriorityAlertSpace` as the **first** priority branch (`SelfHostedBlockedAlert`), sharing a `useSelfHostedBlock()` hook with `FormFooter`, which **hides the entire submit/reset row** when blocked. Members-only copy links to `syncAccount(//green/pricing)` (the existing membership-upsell pattern).

### Known limitations (accepted)

- **`canGenerate` is not gated** — `resolveCanGenerateForVersions` / `getResourceCanGenerate` already enforce the _operator_ ecosystem gates but **not** the self-hosted toggle, so "Create" buttons on model pages/cards stay enabled site-wide even when self-hosted is off. Enforcement is generator-form + submit-time only. (Deliberately scoped out to avoid touching the shared canGenerate path.)
- **Propagation** — `getGenerationConfig` is `staleTime: Infinity` and only invalidated on the toggling mod's own client, so already-open generator sessions don't reflect a toggle change until reload.
- **Default ecosystem** — on fresh load with self-hosted disabled, the form can still land on a disabled default (the node _factory_ computes `defaultValue` and doesn't re-run on async `ext`); the alert + hidden submit cover it, the user switches models manually.

## The crux: what "self-hosted" means in code

The input types that route to our GPUs (provided by `@dev`, from `@civitai/client`):

| Input type                | Routed to   |
| ------------------------- | ----------- |
| `AceStepAudioInput`       | self-hosted |
| `TextToImageInput`        | self-hosted |
| `Flux2KleinImageGenInput` | self-hosted |
| `ComfyImageGenInput`      | self-hosted |
| `SdCppImageGenInput`      | self-hosted |
| `ComfyVideoGenInput`      | self-hosted |
| `ComfyLtx2VideoGenInput`  | self-hosted |
| `ComfyLtx23VideoGenInput` | self-hosted |

**Key insight from the codebase:** the self-hosted/external split is **not** at the orchestrator step `$type` level (`textToImage` / `comfy` / `imageGen` / `videoGen` / `aceStepAudio`). A single `imageGen` step can be self-hosted _or_ external depending on the **engine / specific input type** the handler builds. So the 8 input types above are the source of truth, and they resolve to a specific set of ecosystems via the handlers in `src/server/services/orchestrator/ecosystems/`.

### Derived self-hosted ecosystem set

Mapping each input type to the ecosystem(s) whose handler produces it (router: `src/server/services/orchestrator/ecosystems/index.ts`):

| Input type                | Ecosystems (ECO keys)                                                                                                      | Handler                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `TextToImageInput`        | `SD1`, `SD2`, `SDXL`, `Pony`, `Illustrious`, `NoobAI`, `Flux1`, `FluxKrea`, `Chroma`, `HiDream`, `PonyV7`                  | `stable-diffusion.handler.ts`, `flux.handler.ts`, `chroma.handler.ts`, `hi-dream.handler.ts`, `pony-v7.handler.ts` |
| `ComfyImageGenInput`      | `Anima`, `Ernie`, `Lens`, `HiDream-O1` + SD-family img2img/face-fix/hires-fix (already covered by the SD ecosystems above) | `anima/ernie/lens/hi-dream-o1.handler.ts`, `comfy-input.ts`                                                        |
| `SdCppImageGenInput`      | `ZImageTurbo`, `ZImageBase`, `Qwen`                                                                                        | `z-image.handler.ts`, `qwen.handler.ts`                                                                            |
| `Flux2KleinImageGenInput` | `Flux2Klein_9B`, `Flux2Klein_9B_base`, `Flux2Klein_4B`, `Flux2Klein_4B_base`                                               | `flux2-klein.handler.ts`                                                                                           |
| `ComfyVideoGenInput`      | _(no active ecosystem — see note)_                                                                                         | —                                                                                                                  |
| `ComfyLtx2VideoGenInput`  | `LTXV2`                                                                                                                    | `ltx.handler.ts`                                                                                                   |
| `ComfyLtx23VideoGenInput` | `LTXV23`                                                                                                                   | `ltx.handler.ts`                                                                                                   |
| `AceStepAudioInput`       | `Ace`                                                                                                                      | `ace-audio.handler.ts`                                                                                             |

> **Note on `ComfyVideoGenInput`:** the literal type is **not produced by any handler today** — a grep finds only `Wan22ComfyVideoGenInput` (a Wan-specific subtype) in `wan.handler.ts`. **Wan currently routes entirely through FAL (external) and is out of scope.** So `ComfyVideoGenInput` maps to **no active self-hosted ecosystem** right now; it's reserved. The only self-hosted video ecosystems are `LTXV2` / `LTXV23`. If a generic comfy-video ecosystem is wired up later, mark it `selfHosted: true` then.

### Traps — lookalike ecosystems that are EXTERNAL (must NOT be gated)

- **`Flux2`** (plain) → external (`flux2` engine). Only **`Flux2Klein*`** is self-hosted.
- **`Qwen2`** → external (`fal`). Only **`Qwen`** (sdcpp) is self-hosted.
- **All `Wan*` ecosystems** → external (FAL) today. Out of scope.

> **Decision 1 — RESOLVED: clean ecosystem-key granularity.** Every self-hosted ecosystem is all-or-nothing at the ecosystem-key level. No flag-conditional cases, no version-level lists. The static `selfHosted: true` flag fully describes the set.

## Architecture overview

This feature is structurally a sibling of the existing `gatedEcosystems` / `gatedVersionIds` mechanism, with three differences:

1. Driven by **one 3-state toggle**, not per-ecosystem operator lists.
2. The affected set is **derived from a static self-hosted classification**, not hand-entered by a moderator.
3. Client behavior is **disable + alert** (not hide-entirely, which is what `gatedEcosystems` does today).

### 1. Source of truth: a static self-hosted classification

Add a declarative marker for self-hosted ecosystems in `src/shared/constants/basemodel.constants.ts`. Two options:

- **(a)** A `selfHosted: true` flag on each ecosystem record, with a derived `SELF_HOSTED_ECOSYSTEMS: string[]` helper.
- **(b)** A standalone `SELF_HOSTED_ECOSYSTEMS` constant set, maintained next to the handlers.

Either way, also define `SELF_HOSTED_INPUT_TYPES` (the 8 names) used for **server-side enforcement** (see §5). The static ecosystem list is for **client UX only**; the server enforcement on the produced input type is the real security boundary (belt + suspenders, since the static list can drift).

> **Decision 2 — RESOLVED: (a).** Per-ecosystem `selfHosted: true` flag on the ecosystem record, with a derived `SELF_HOSTED_ECOSYSTEMS` helper. No conditional markers needed.
> @dev - we can go with (a)

### 2. Storage: a new toggle field

Mirror the existing `generationStatusSchema` (`src/server/schema/generation.schema.ts:227`). Reuse `generationStatusModeSchema` (`'enabled' | 'memberOnly' | 'disabled'`).

> **Decision 3 — RESOLVED: new field on the existing `generationStatus` object.** Add `selfHostedMode` (+ `selfHostedMessage`, `selfHostedUpdatedBy`) to `generationStatusSchema`. Same Redis field (`generation:status`), write path mirrors `setGenerationStatus` (`generation.service.ts:250`).
> @dev - new field on the existing status object

### 3. Server: extend `getGenerationConfig`

In `src/server/services/generation/generation.service.ts`, extend `GenerationConfig` (line 714) and resolve per-user exactly like `getGatedListsForUser` (line 745):

```ts
export type GenerationConfig = {
  // ...existing fields...
  /** Self-hosted ecosystems disabled FOR THIS USER (resolved against mode + tier). */
  selfHostedDisabledEcosystems: string[];
  /** Why they're disabled, so the client can show the right alert/CTA. */
  selfHostedMode: 'enabled' | 'memberOnly' | 'disabled';
};
```

Resolution logic (mirrors `getGatedListsForUser`, `generation.service.ts:745`):

1. Build the self-hosted ecosystem set from the static `selfHosted` flags.
2. Apply the mode:
   - `selfHostedMode === 'enabled'` → `selfHostedDisabledEcosystems = []`
   - `selfHostedMode === 'disabled'` → full self-hosted set (mods bypass → `[]`)
   - `selfHostedMode === 'memberOnly'` → full set for free users, `[]` for members & mods

Returning the **resolved per-user list** keeps tier logic server-side (consistent with the existing pattern). Returning **`selfHostedMode`** alongside lets the client distinguish "members-only (show upsell)" from "fully disabled" in the alert copy.

> **Decision 4 — RESOLVED: ecosystem list only.** No `selfHostedDisabledVersionIds`. Every self-hosted ecosystem is clean at the ecosystem-key level, so the client receives a plain ecosystem list.
> @dev - I think the ecosystem list should be sufficient assuming that the more granular Wan ecosystems apply cleanly.

### 4. Client wiring — through the generation graph (not a standalone hook)

The disabled list flows the **same path `gatedEcosystems` already takes**, but with **disable** semantics instead of **hide**. This keeps validation inside `generationGraph` and gives the components a single source of truth via the ecosystem node's `meta`.

**The flow:** `getGenerationConfig` → `GenerationFormProvider` builds `externalContext: GenerationCtx` (`GenerationFormProvider.tsx:266`) → ecosystem node reads `ext` → ecosystem node `meta` → `GenerationForm` → `BaseModelInput`.

1. **Graph context** (`src/shared/data-graph/generation/context.ts`): add `selfHostedDisabledEcosystems?: string[]` to `GenerationCtx` (sibling of `gatedEcosystems` at line 28). Populate it in `GenerationFormProvider`'s `externalContext` memo (alongside `gatedEcosystems`, `GenerationFormProvider.tsx:278`) from `useGenerationConfig().selfHostedDisabledEcosystems`.

2. **Ecosystem node** (`src/shared/data-graph/generation/ecosystem-graph.ts:119`): unlike `gatedEcosystems`, **do NOT filter** these out of `compatibleEcosystems` — we want them to render. Instead:

   - Add `disabledEcosystems` to the node's `meta` (the resolved list intersected with `compatibleEcosystems`), plus the reason/`selfHostedMode` (or a pre-derived badge label) so the picker can label the badge without re-reading config.
   - Add a `.refine()` on the node's `output` schema rejecting a selected disabled ecosystem (`message: 'Ecosystem is currently unavailable'`), mirroring the gated refine at line 150. **This is where validation lives** — a disabled selection makes the graph invalid, which is what blocks submission.
   - Do **not** add it to the `input` transform's drop logic (line 143) — we want the disabled value to stay selected so the alert + disabled state show, rather than silently snapping to a default.

3. **`BaseModelInput`** (`src/components/generation_v2/inputs/BaseModelInput.tsx`): add a `disabledEcosystems` prop fed from `meta?.disabledEcosystems` (`GenerationForm.tsx:470`). Render those items present-but-disabled, distinct from the `applyExcludeFilter` _removal_ used for gated items (line 624). The item rows are `UnstyledButton`s rendered in **two places** — the recent list (~line 344) and the grouped list (~line 400) — so factor a small per-item renderer or apply the treatment in both. For a disabled item:

   - **Show a badge** in the trailing slot next to the existing check/arrow icons — Mantine `<Badge size="xs">`. **Two variants, keyed on `selfHostedMode`:**
     - `selfHostedMode === 'disabled'` → **"Disabled"** badge (e.g. `color="gray"`/`red`). Only shown here, because this is the only mode where the ecosystem is truly off for everyone.
     - `selfHostedMode === 'memberOnly'` → **"Members only"** badge (e.g. `color="yellow"`). Only non-members ever reach this case — members and mods get an empty resolved `disabledEcosystems` list, so the item renders normally with no badge.
     - Pass `selfHostedMode` (or a pre-derived badge variant) through the node `meta` alongside `disabledEcosystems` so the picker doesn't re-read config. Since the resolved list is already per-user, an item being _in_ the list + the single `selfHostedMode` value fully determines which badge to show.
   - **Grey + block interaction:** reuse the existing `opacity-60`/`opacity-50` + `cursor-not-allowed` styling and guard `onClick` to early-return for disabled keys (mirrors the `disabled` guard already at line 838).
   - **Tooltip (optional):** wrap in a `Tooltip` explaining why (e.g. "Members-only generation" / "Temporarily unavailable"), same pattern as the existing "Will switch to …" tooltip at line 373.

4. **`ResourceAlerts`** (`src/components/generation_v2/ResourceAlerts.tsx`): new alert following the `ExperimentalModelAlert` / `GrokEcosystemAlert` pattern, shown when the selected ecosystem ∈ disabled set. Copy matches the badge variant — `selfHostedMode === 'disabled'` → "this model can't be generated right now"; `selfHostedMode === 'memberOnly'` → members-only upsell (link to membership). Read `selfHostedMode` from `useGenerationConfig()`.

5. **Generate button** — **no direct edit needed.** Because validation lives in the ecosystem node's `output` refine (step 2), a disabled selection makes the graph invalid and submission is already blocked through the normal graph-validity path. _(Confirm during implementation that the button's disabled state reflects graph validity; if it only keys off `canGenerate`/queue today, wire graph-invalid into that one place rather than re-deriving the disabled set.)_

### 5. Server enforcement (the real guard)

Client gating is bypassable, so enforce server-side where `memberOnly` is enforced today: `src/server/routers/orchestrator.router.ts` (~lines 379, 425). After the request resolves to orchestrator steps, inspect the produced input type; if it's in `SELF_HOSTED_INPUT_TYPES` and `selfHostedMode === 'disabled'` (or `memberOnly` && free user) → throw `BAD_REQUEST` with the status message. This catches exactly the self-hosted input types regardless of which ecosystem/workflow produced them — no drift risk if the static client list ever lags the handlers.

For provider-discriminated handlers, the produced input also carries `provider` (`'civitai'`/`'comfy'` = self-hosted, `'fal'` = external); matching on the input type already covers this, but `provider === 'fal'` is a useful belt-and-suspenders allow-check if a future ecosystem reuses a self-hosted input type for an external route.

## Files touched (summary)

### Server

| Area           | File                                                                                               | Change                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Classification | `src/shared/constants/basemodel.constants.ts`                                                      | `selfHosted` flag + `SELF_HOSTED_ECOSYSTEMS`; `SELF_HOSTED_INPUT_TYPES`                                   |
| Schema         | `src/server/schema/generation.schema.ts`                                                           | `selfHostedMode` field on `generationStatusSchema`                                                        |
| Service        | `src/server/services/generation/generation.service.ts`                                             | get/set self-hosted status; extend `GenerationConfig` + resolver                                          |
| Router         | `src/server/routers/generation.router.ts`                                                          | extend `getGenerationConfig` query response; accept `selfHostedMode` in the mod set/get status procedures |
| Enforcement    | `src/server/routers/orchestrator.router.ts`                                                        | block self-hosted input types per mode (bypass-proof guard)                                               |
| Mod UI         | `src/components/Moderation/GenerationStatusCard.tsx` + `src/pages/moderator/generation-config.tsx` | new toggle section                                                                                        |

### Client (all via the generation graph — no standalone gating hook)

| Area              | File                                                      | Change                                                                                                                                                   |
| ----------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph context     | `src/shared/data-graph/generation/context.ts`             | add `selfHostedDisabledEcosystems?: string[]` to `GenerationCtx`                                                                                         |
| Context wiring    | `src/components/generation_v2/GenerationFormProvider.tsx` | populate the new ctx field from `useGenerationConfig()` (alongside `gatedEcosystems`)                                                                    |
| Ecosystem node    | `src/shared/data-graph/generation/ecosystem-graph.ts`     | expose `meta.disabledEcosystems` (keep them in `compatibleEcosystems`) + `output` `.refine()` rejecting a disabled selection — **validation lives here** |
| Base model picker | `src/components/generation_v2/inputs/BaseModelInput.tsx`  | `disabledEcosystems` prop fed from node `meta`; render disabled (not removed)                                                                            |
| Alerts            | `src/components/generation_v2/ResourceAlerts.tsx`         | self-hosted-disabled alert; copy keyed on `selfHostedMode`                                                                                               |

> **Why `generation.router` is still in the list:** the toggle value and the resolved disabled list still originate server-side — `getGenerationConfig` returns them and the mod status procedures persist them. What the graph approach changes is the **client distribution**: instead of a `useSelfHostedDisabledEcosystems` hook wired independently into the picker, the alert, and the button, the resolved list rides in `GenerationCtx` and the ecosystem node owns validation + `meta`. The Generate button needs no dedicated change because a disabled selection invalidates the graph.

## Decisions (all resolved)

1. **Granularity** ✅ Clean ecosystem-key level. No special cases, no version-level lists.
2. **Where the flag lives** ✅ Per-ecosystem `selfHosted: true` flag on the ecosystem record.
3. **Storage** ✅ New `selfHostedMode` field on the existing `generationStatus` object.
4. **List shape** ✅ Ecosystem list only (`selfHostedDisabledEcosystems`) + `selfHostedMode`.

The plan is implementation-ready.
