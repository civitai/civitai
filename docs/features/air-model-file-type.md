# AIR `type` segment: Model Type vs. Model File Type

## Context / The problem

An **AIR** (AI Resource identifier) looks like:

```
urn:air:sdxl:checkpoint:civitai:12345@67890
            └ ecosystem └ type    └ source  └ modelId@versionId
```

The `type` segment today is derived from the **model's `ModelType`** (e.g. `Checkpoint`,
`LORA`), via `typeUrnMap` in [`src/shared/utils/air.ts`](../../src/shared/utils/air.ts).

We now allow users to attach **related component files** of a different kind to a model —
e.g. a **Text Encoder** file attached to a model whose `ModelType` is `Checkpoint`. When the
generation panel builds the AIR for that file, it stamps the segment with the *model* type
(`checkpoint`) instead of the *file* type (`textencoder`). The orchestrator then routes the
file into the wrong slot (or rejects it), because the orchestrator routes on this segment.

The desire: derive the `type` segment from the **`ModelFile.type`** instead of (or in
addition to) the `ModelType`. This doc enumerates both vocabularies and the blockers.

---

## Where the segment is produced and consumed

| | File | Detail |
|---|---|---|
| **Produced** | [`stringifyAIR`](../../src/shared/utils/air.ts) | `type: ModelType` → `typeUrnMap[type] ?? 'unknown'` |
| Generation panel | [`generation.service.ts` `bringItAllTogether`](../../src/server/services/generation/generation.service.ts) | passes `type: resource.model.type` |
| Resource caches | [`caches.ts`](../../src/server/redis/caches.ts) (`modelVersionResourceCache`) | passes `type: v.model.type` |
| File scanning | [`orchestrator.service.ts`](../../src/server/services/orchestrator/orchestrator.service.ts) | passes `type: modelType` |
| Public API | `src/pages/api/v1/model-versions/[id].ts`, `.../mini/[id].ts` | emit AIR in responses |
| Display | [`ModelURN.tsx`](../../src/components/Model/ModelURN/ModelURN.tsx) | user-facing URN on model pages |
| **Consumed** | [`comfy.utils.ts`](../../src/server/services/orchestrator/comfy/comfy.utils.ts) | branches on `parsedAir.type === 'checkpoint' \| 'vae' \| 'embedding'` and `LORA_TYPES.includes(...)` |
| Reverse map | [`urnToModelType`](../../src/shared/utils/air.ts) | URN type string → `ModelType` (used by resource matching, dedup, metadata hydration) |

**Key point:** the `type` segment is a **routing key**, not a label. The orchestrator uses it
to decide which slot (checkpoint / vae / lora / embedding / …) a resource fills.

---

## Vocabulary 1 — `ModelType` (the model's category)

Source: [`src/shared/utils/prisma/enums.ts`](../../src/shared/utils/prisma/enums.ts) (`ModelType`).
The `→ URN` column is the current mapping in `typeUrnMap`.

| `ModelType` | URN `type` | In `typeUrnMap`? |
|---|---|---|
| Checkpoint | `checkpoint` | ✅ |
| TextualInversion | `embedding` | ✅ |
| Hypernetwork | `hypernet` | ✅ |
| AestheticGradient | `ag` | ✅ |
| LORA | `lora` | ✅ |
| LoCon | `lycoris` | ✅ |
| DoRA | `dora` | ✅ |
| Controlnet | `controlnet` | ✅ |
| Upscaler | `upscaler` | ✅ |
| MotionModule | `motion` | ✅ |
| VAE | `vae` | ✅ |
| TextEncoder | `textencoder` | ✅ |
| UNet | `unet` | ✅ |
| CLIPVision | `clipvision` | ✅ |
| Poses | `unknown` | ❌ |
| Wildcards | `unknown` | ❌ |
| Workflows | `unknown` | ❌ |
| Detection | `unknown` | ❌ |
| Other | `unknown` | ❌ |

---

## Vocabulary 2 — `ModelFile.type` (the file's role)

Source: [`constants.modelFileTypes`](../../src/server/common/constants.ts) (validated by
[`model-file.schema.ts`](../../src/server/schema/model-file.schema.ts)).
The `→ URN?` column is **proposed** — there is **no** file-type→URN map today.

| `ModelFile.type` | Clean URN equivalent? | Notes |
|---|---|---|
| `Model` | ❌ **ambiguous** | Generic weights. Used as the primary file for Checkpoint, LORA, DoRA, LoCon, Hypernetwork, Controlnet, Upscaler, VAE, … (see `primaryFileTypesByModelType`). Tells you *nothing* about routing. |
| `Pruned Model` | ❌ **ambiguous** | Same as `Model` — a quant/precision variant, not a category. |
| `Diffusion Model` | ⚠️ none | No entry in `typeUrnMap` and not understood by the comfy router. Used by Flux/Wan/ZImage/etc. checkpoints. Would emit an unknown URN type. |
| `UNet` | ✅ `unet` | Matches `UNet` model type. |
| `VAE` | ✅ `vae` | |
| `Text Encoder` | ✅ `textencoder` | **The motivating case.** |
| `CLIPVision` | ✅ `clipvision` | |
| `ControlNet` | ✅ `controlnet` | |
| `Upscaler` | ✅ `upscaler` | |
| `Negative` | ⚠️ `embedding`? | Negative TI embedding — arguably `embedding`, but semantics differ. |
| `Enhancement LoRA` | ⚠️ `lora`? | Not a 1:1 with any `ModelType`. |
| `Training Data` | ❌ n/a | Not a generation resource. |
| `Config` | ❌ n/a | Not a weights file. |
| `Archive` | ❌ n/a | Container (zip). |
| `Workflow` | ❌ n/a | Not a weights file. |
| `Other` | ❌ n/a | Catch-all. |

Note the asymmetry: file type is **more** specific on the weights axis
(`Diffusion Model` vs `UNet` vs `VAE`) but **less** specific on the routing axis (a bare
`Model` file is shared across many `ModelType`s).

---

## Vocabulary 3 — ComfyUI model folder categories

Source: [`folder_paths.py`](https://github.com/comfyanonymous/ComfyUI/blob/master/folder_paths.py)
(`folder_names_and_paths`) — ComfyUI's canonical list of model categories. These are the
`models/<dir>` folders ComfyUI scans, i.e. the routing slots a loader resolves a resource into.
This is the vocabulary the **external orchestrator** ultimately has to satisfy, so it's the
reference for "what target URN types are even meaningful."

### 3a. The generation-relevant subset (the slots we actually route into)

Of all the folders ComfyUI exposes, only this subset matters for Civitai generation. **Two
distinctions are load-bearing and are *not* aliases for us:**

- **`clip` is distinct from `text_encoders`** — they are separate routing slots, not the same
  folder under an old name.
- **`unet` is distinct from `diffusion_models`** — `unet` is used mostly for **GGUF** weights;
  `diffusion_models` is the standard (safetensors) diffusion weights slot.

| Comfy slot | Civitai `ModelType` that feeds it | `ModelFile.type` that feeds it | Current URN `type` | Gap |
| --- | --- | --- | --- | --- |
| `checkpoints` | Checkpoint | `Model` / `Pruned Model` | `checkpoint` | — |
| `loras` | LORA / LoCon / DoRA | `Model` / `Enhancement LoRA` | `lora` / `lycoris` / `dora` | — |
| `vae` | VAE | `VAE` | `vae` | — |
| `text_encoders` | TextEncoder | `Text Encoder` | `textencoder` | **the motivating case** |
| `clip` | — | — | — | No Civitai type **or file type** distinguishes `clip` from `text_encoders` today |
| `diffusion_models` | — | `Diffusion Model` | — | No URN type exists; `Diffusion Model` not in `typeUrnMap` |
| `unet` | UNet | `UNet` | `unet` | URN `unet` exists, but must resolve to the **GGUF** unet slot, not `diffusion_models` |
| `clip_vision` | CLIPVision | `CLIPVision` | `clipvision` | — |
| `embeddings` | TextualInversion | `Negative` (negative TI) | `embedding` | — |
| `controlnet` | Controlnet | `ControlNet` | `controlnet` | — |
| `upscale_models` | Upscaler | `Upscaler` | `upscaler` | — |
| `latent_upscale_models` | — | — | — | No Civitai type/file type maps here |
| `model_patches` | — | — | — | No Civitai type/file type maps here |

**What this subset tells us:**

- The motivating case (**`text_encoders`**) and most component types (`vae`, `clip_vision`,
  `controlnet`, `upscale_models`) map cleanly — a file-type override would route them correctly.
- **`diffusion_models` is a real gap** on *our* side: we have a `Diffusion Model` file type but
  no URN type and no `typeUrnMap` entry. Comfy has the slot; we can't currently name it.
- **`unet` vs `diffusion_models`** must be kept distinct end-to-end. The URN type alone has to
  carry "GGUF unet" vs "diffusion weights," or the orchestrator picks the wrong loader.
- **`clip` vs `text_encoders`** can't even be expressed today: Civitai's `ModelFile.type`
  vocabulary has no `CLIP` value separate from `Text Encoder`. If any model needs a `clip`-slot
  file, neither vocabulary can route it — a file-type override would still send it to
  `text_encoders`.

### 3b. Full ComfyUI folder list (reference)

| ComfyUI folder | Legacy alias | Closest Civitai `ModelType` | Closest URN `type` |
|---|---|---|---|
| `checkpoints` | — | Checkpoint | `checkpoint` |
| `configs` | — | — (Config file) | n/a |
| `loras` | — | LORA / LoCon / DoRA | `lora` / `lycoris` / `dora` |
| `vae` | — | VAE | `vae` |
| `text_encoders` | — | TextEncoder | `textencoder` |
| `clip` | — (distinct slot, not an alias — see 3a) | — | — |
| `diffusion_models` | — (distinct from `unet` — see 3a) | — (Diffusion Model file) | — |
| `unet` | — (distinct slot, mostly GGUF) | UNet | `unet` |
| `clip_vision` | — | CLIPVision | `clipvision` |
| `style_models` | — | — (T2I style adapters) | — |
| `embeddings` | — | TextualInversion | `embedding` |
| `diffusers` | — | — (diffusers-format checkpoints) | `checkpoint`? |
| `vae_approx` | — | — (TAESD preview decoders) | — |
| `controlnet` | `t2i_adapter` | Controlnet | `controlnet` |
| `gligen` | — | — | — |
| `upscale_models` | — | Upscaler | `upscaler` |
| `latent_upscale_models` | — | — | — |
| `hypernetworks` | — | Hypernetwork | `hypernet` |
| `photomaker` | — | — | — |
| `classifiers` | — | — | — |
| `model_patches` | — | — | — |
| `audio_encoders` | — | — | — |
| `background_removal` | — | — | — |
| `frame_interpolation` | — | — (e.g. RIFE/FILM) | — |
| `geometry_estimation` | — | — | — |
| `optical_flow` | — | — | — |
| `detection` | — | Detection | — (currently `unknown`) |
| `custom_nodes` | — | — (not a model dir) | n/a |

(Excludes `custom_nodes`, which is a code dir, not a weights category.) ComfyUI accepts any file
with a `supported_pt_extensions` extension in these folders:
`.ckpt`, `.pt`, `.pt2`, `.bin`, `.pth`, `.safetensors`, `.pkl`, `.sft` (GGUF is added by the
ComfyUI-GGUF custom node, not core).

**Takeaways for this doc:**

- `diffusion_models` is a **first-class Comfy folder, distinct from `unet`** (see 3a — `unet` is
  mostly GGUF). So a `Diffusion Model` file *does* have a clean Comfy target; the gap is purely in
  our `typeUrnMap` + the orchestrator's URN→folder resolution, not in Comfy itself. The override
  must keep `Diffusion Model`→`diffusion_models` and `UNet`→`unet` separate.
- `text_encoders` and `clip_vision` are distinct Comfy folders, matching our `textencoder` /
  `clipvision` split — the motivating Text Encoder case lands cleanly. But `clip` is a **third**
  slot distinct from `text_encoders` that *no* Civitai vocabulary can currently name (see 3a).
- Comfy is **more granular** than both our vocabularies (`style_models`, `gligen`, `photomaker`,
  `model_patches`, `audio_encoders`, the video/perception helpers). Most have no Civitai
  `ModelType` and would need new URN types if we ever route them.
- This list is the orchestrator's target space — when checking Open Question 1 ("does the
  external orchestrator route on `textencoder` / `unet` / `diffusionmodel`?"), these folder
  names are what its loaders map URN types onto.

---

## How the orchestrator actually routes *(answers Open Question 1)*

Investigated `@civitai/client` **v0.2.0-beta.76** (`node_modules/@civitai/client/dist`). The
finding reframes the problem: **the AIR `type` segment is mostly *not* how resources get routed.**

### 1. The `Air` class treats `type` as a free-form string — no enum, no validation

[`dist/utils/Air.js`](../../node_modules/@civitai/client/dist/utils/Air.js) is a single regex
where `type` is just `[a-zA-Z0-9_\-\/]+`. `parse` / `parseSafe` / `stringify` / `isAir` never
enumerate or check the type value. So the client will happily emit `textencoder`, `diffusionmodel`,
or anything else — **the client is not a blocker; it won't reject new type strings.**

### 2. Orchestrator step inputs route by **named slot**, not by the AIR type

The typed inputs in [`dist/generated/types.gen.d.ts`](../../node_modules/@civitai/client/dist/generated/types.gen.d.ts)
expose explicit slots, and a resource object carries **only `air` (+ `strength`)** — there is no
`type` field on the resource for routing:

| Input type | Slots that take an AIR |
| --- | --- |
| `TextToImageInput` (SD family) | `model` (checkpoint), `additionalNetworks: { [air]: { strength } }`, `controlNets` |
| `Sd1ImageGenInput` (sdcpp) | `model`, `vaeModel`, `loras: { [air]: strength }`, `embeddings: string[]` |
| `ComfyKrea2BaseImageGenInput` | `model`, `loras: { [air]: strength }`, `diffusionModel: string \| null` |
| `ImageGenInputLora` / `VideoGenInputLora` | `{ air, strength }` |

**Which slot a resource lands in is chosen by *our* code, not by the AIR's type segment:**

- The **data-graph** buckets resources by `model.type` into typed nodes — e.g.
  [`vaeNode`](../../src/shared/data-graph/generation/common.ts) selects only `ModelType === 'VAE'`,
  the resources node selects `LORA`/`LoCon`/`DoRA`/`TextualInversion`, etc.
- The **handler** then drops each node's AIR into the matching named slot — e.g.
  [`stable-diffusion.handler.ts`](../../src/server/services/orchestrator/ecosystems/stable-diffusion.handler.ts)
  puts `data.model` into `model` and everything else (resources + vae) into `additionalNetworks`.

### 3. The one place the AIR `type` segment *is* read on our side

The **comfy path** ([`applyResources` in `comfy.utils.ts`](../../src/server/services/orchestrator/comfy/comfy.utils.ts),
invoked by [`createComfyInput`](../../src/server/services/orchestrator/ecosystems/comfy-input.ts))
branches on `parsedAir.type` — but only handles **`checkpoint`**, **`vae`**, **`embedding`**, and
`LORA_TYPES = ['lora', 'dora', 'lycoris']`. Two consequences:

- A wrong segment (`checkpoint` for a Text Encoder file) genuinely mis-routes here.
- `textencoder` / `unet` / `diffusionmodel` / `clipvision` / `controlnet` are **not handled by
  this loader at all** — a resource with one of those types is **silently dropped** from the comfy
  workflow. So emitting the correct segment is necessary but still insufficient until the loader
  learns those types (and a comfy node exists to receive them).

### What this means for the fix

The "Text Encoder on a Checkpoint" problem is **a two-layer routing problem, and the AIR string
is the smaller half:**

1. **Data-graph / handler layer (primary).** Even a perfect AIR type segment won't help unless
   (a) the data-graph routes the *component file* to a slot based on the **file's** role rather
   than the parent `model.type`, and (b) the ecosystem input **exposes a slot** for that role.
   Most current inputs don't — `TextToImageInput` has no text-encoder/clip slot at all; a text
   encoder would have to go into `additionalNetworks` and rely on the orchestrator resolving it.
2. **AIR-string layer (secondary).** Needed for the comfy path (`applyResources`) and for any
   server-side resolution that reads the segment, plus public API / URN display correctness.

So fixing `stringifyAIR` is **necessary but not sufficient**. The bigger work is teaching the
data-graph + ecosystem handlers about per-file "Additional Component" roles and giving the
ecosystem inputs named slots to route them into.

> **Still open (server-side, not visible in the client):** when the orchestrator resolves an AIR
> placed in `additionalNetworks` / `loras`, does it trust the AIR `type` segment or re-resolve the
> resource via the Civitai API and read its real type? The full package scan (v0.2.0-beta.76) found
> **no** type enum/validation anywhere in `@civitai/client` and **no** resource field other than
> `air` (+ `strength`) — strong evidence the orchestrator resolves the AIR opaquely server-side and
> does **not** branch on the segment. But that's an inference from the client surface, not a
> guarantee; confirm with the orchestrator team before relying on it. Note the segment is *also*
> seen carrying non-`typeUrnMap` values in the wild (`repository`, `birefnet`, `other`), reinforcing
> that it's a free-form, Civitai-side categorization.

---

## Blockers for a smooth transition

### 1. `Model` / `Pruned Model` are ambiguous — file type alone can't route
The most common file type is the generic `Model`. A `Model` file on a LoRA, a Checkpoint, and
a Controlnet are all literally `Model`. If you replace the segment with file type, you lose the
disambiguation that `ModelType` currently provides. → **You cannot drop `ModelType`; you can
only override it for *specific* component file types.**

### 2. No file-type→URN map exists, and it has holes
A new map is required. Several file types have **no** clean URN target:
- `Diffusion Model` — not in `typeUrnMap` at all, and the comfy router only understands
  `checkpoint` / `vae` / `embedding` / lora-types. Emitting `diffusion model` or `unknown`
  breaks routing.
- `Negative`, `Enhancement LoRA` — no 1:1 `ModelType`; semantics need a product decision.
- `Training Data` / `Config` / `Archive` / `Workflow` / `Other` — not generation resources.

### 3. One AIR per file — a structural change to what an AIR points at *(design decided)*

Today the AIR identifies a **model version** (`modelId@versionId`); `fileId` is only an
*optional* disambiguator, and `bringItAllTogether` doesn't pin one file. The new model is
**one AIR per model file**: the version's **primary file** plus any **Additional Components**
(extra files a user attaches as *required* or *recommended* for the version — e.g. a
`Text Encoder` on a `Checkpoint`). Each emitted AIR therefore needs:

- a populated `fileId` so it names a specific file, and
- a `type` segment derived from **that file's** `ModelFile.type` (with `ModelType` as fallback
  for the generic `Model`/`Pruned Model` primary file).

This is no longer ambiguous, but it *is* a structural change: the generation form and the
resource caches currently key on one AIR per version and must now expand a version into
primary + component AIRs.

### 4. The reverse map breaks
[`urnToModelType`](../../src/shared/utils/air.ts) maps the segment **back** to a `ModelType`,
and many callers (resource matching, dedup, metadata, generation-data hydration) rely on it. If
the segment becomes a file type, every reverse lookup silently degrades to its passthrough
fallback.

### 5. Backwards compatibility & cache invalidation
AIRs are persisted widely — image metadata, stored generation params, `continueFromAir` for
training — and cached in Redis (`modelVersionResourceCache`, resource data cache). Existing AIRs
use model-type semantics. New AIRs would mean something different for the same resource, so
anything that compares/dedups AIRs across old and new data mismatches. Caches keyed on the old
shape need invalidation.

### 6. It's a shared contract (public API + URN display), but *not* the orchestrator's router

`stringifyAIR` has ~10 callers, including the **public** `/api/v1/model-versions/*` responses
and the user-facing URN on model pages — those must stay coherent. Per "How the orchestrator
actually routes" above, the external orchestrator does **not** appear to branch on the segment;
the real routing is the **named slot our code chooses** (data-graph + handlers) plus the **comfy
loader** (`applyResources`), which *does* read the segment but only handles
`checkpoint`/`vae`/`embedding`/lora-types. So the cross-service risk is smaller than it looks —
the heavier lift is on our side (see Blocker 7).

### 7. The real fix is two-layer — the AIR string is the smaller half

Routing a component file correctly requires changes the AIR segment alone can't deliver:

- **Data-graph** must bucket the file by its **own role** (`ModelFile.type`), not the parent
  `model.type`, so a Text Encoder on a Checkpoint doesn't get treated as a checkpoint resource.
- **Ecosystem inputs/handlers** must expose a **slot** for that role. `TextToImageInput` has no
  text-encoder/clip slot today; some ecosystem `ImageGenInput`s do (`vaeModel`, `diffusionModel`,
  `embeddings`) but coverage is uneven.
- **The comfy loader** must learn the new types or the resource is silently dropped.

---

## Recommended direction (not a clean swap)

A **targeted override** of the AIR segment, paired with the data-graph/handler routing work
(Blocker 7). The AIR change alone won't fix generation.

**AIR-string layer:**

1. Emit **one AIR per file** with `fileId` always populated (primary file + Additional
   Components). This is the decided model — see Blocker 3.
2. Keep `ModelType` as the base for the segment (preserves routing for the generic
   `Model`/`Pruned Model` primary file).
3. When the file's `ModelFile.type` is a **specific component type** (`Text Encoder`, `VAE`,
   `UNet`, `Diffusion Model`, `CLIPVision`, `ControlNet`, `Upscaler`), substitute the
   corresponding URN type instead. Keep `UNet`→`unet` and `Diffusion Model`→`diffusionmodel`
   distinct (GGUF vs diffusion weights — see 3a).
4. Add a small `fileTypeUrnMap` next to `typeUrnMap` covering only those component types.
5. Keep `urnToModelType` and downstream parsers working for both old and new segments.

**Routing layer (the heavier lift — Blocker 7):**

1. Make the data-graph bucket component files by `ModelFile.type`, not the parent `model.type`.
2. Give the ecosystem inputs/handlers named slots for the component roles we want to support
   (e.g. a text-encoder slot), and teach the comfy loader (`applyResources`) the new types so
   they aren't silently dropped.

### Open questions

- **(Largely answered — see "How the orchestrator actually routes")** The external orchestrator
  shows no evidence of branching on the segment; routing is the named slot we choose + the comfy
  loader. Remaining: confirm with the orchestrator team whether server-side AIR resolution ever
  reads the segment.
- `@ai:` **Which file the AIR refers to is resolved** — one AIR per file (primary +
  Additional Components), `fileId` always set. Folded into Blocker 3 and step 1 above.
- Do we need a new `ModelFile.type` value to distinguish `clip` from `Text Encoder`? Today no
  Civitai file type can route into Comfy's `clip` slot (see 3a).
- What URN type should `Negative` and `Enhancement LoRA` map to?
