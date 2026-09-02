# Porting data-graph to the `form-graph` package

**Branch:** `feat/form-graph-port` (this worktree, `C:\work\worktrees\form-graph-port`)
**Owner:** Briant. The executing agent commits at phase boundaries on this branch; it never
pushes, opens PRs, or merges without Briant's explicit approval.

**Layout (Briant, 2026-09-01):** the port lives at `src/shared/form-graph/generation/` —
one folder per graph domain, with a future training graph at `src/shared/form-graph/training`.
Domain-agnostic def builders (slider/enum/select/bool) live at `src/shared/form-graph/defs.ts`,
shared by every domain; `generation/defs.ts` re-exports them plus the generation-specific defs.

**Closing condition for the whole effort:** `src/libs/data-graph/` and
`src/shared/data-graph/` are deleted; every former consumer imports `form-graph` (npm,
`^0.2.0`); `pnpm run typecheck` and `pnpm run test:unit:run` are green; and Briant has
reviewed the final diff. Each phase below has its own closing condition — do not start a
phase before the previous one's condition is met.

---

## 1. What is being replaced, and with what

### The old system (in this repo)

- **Engine:** `src/libs/data-graph/` — `data-graph.ts` (~2,170 lines), React bindings in
  `react/` (`DataGraphProvider`, `Controller`, `useDataGraph`), `storage-adapter.ts`
  (localStorage persistence).
- **Graphs:** `src/shared/data-graph/generation/` — 52 `*-graph.ts` family files (flux,
  wan, ltx, hi-dream, grok, anima, …), composed by `generation-graph.ts` (the root),
  `ecosystem-graph.ts` (ecosystem/workflow coupling), `gates.ts` (availability rules),
  `common.ts`, `context.ts`, and `config/`.
- **Server entry points** (the load-bearing ones):
  - `src/server/services/orchestrator/orchestration-new.service.ts` (~line 586):
    `generationGraph.safeParse(normalizeInput(input), externalCtx)` — the generation
    submit path.
  - `src/server/services/orchestrator/legacy-metadata-mapper.ts` (~line 651): display
    parsing with `DISPLAY_GENERATION_CTX`.
  - `src/server/metrics/generation-model-substitution.metrics.ts` — a metrics tap over
    every server-side `safeParse` (it reads the graph's correction/substitution output).
- **Client entry point:** `src/components/generation_v2/GenerationFormProvider.tsx` wires
  `DataGraphProvider` + `createLocalStorageAdapter` + `generationGraph`; ~119 files under
  `src/components/generation_v2/` and neighbors consume the graph through it.

### The new system (npm package)

- **`form-graph@^0.2.0`** — published by Briant (`bkdiehl`), repo
  `github.com/bkdiehl/form-graph`. Docs: https://bkdiehl.github.io/form-graph/docs —
  **read the docs site before writing any code**; the API changed heavily right before
  0.2.0 and your training data does not contain it.
- Peer deps: zod `^3.25 || ^4` (this repo has `zod ^4.0.17` — compatible), react
  `^18 || ^19` (this repo has 18.3 — compatible). Svelte peer is optional; ignore it.
- **Local reference implementation (this machine only, not in any git remote):**
  `C:\work\form-graph\src\v1\ports\` contains finished, parity-verified form-graph ports
  of the **LTX**, **Wan**, and **video-hub** slices of this repo's data-graph
  (`wan.ts`, `ltx.ts`, `video-hub.ts`, `defs.ts`, `constants.ts`), plus a 36-case
  differential suite in `C:\work\form-graph\src\v1\__tests__\`. They were written against
  vendored copies of this repo's v1 code and pass bit-for-bit parity. **Copy from them
  freely** — they are the intended starting point for Phase 2 — but note they import
  from relative form-graph paths; imports must become `form-graph` package imports here.

---

## 2. form-graph API primer (as of 0.2.0 — trust this over training data)

```ts
import { defineGraph, branch, branchOn, defFamily } from 'form-graph';
import { slider, enumOf, textOf, boolOf } from 'form-graph/defs';
```

- **A graph IS the form.** `defineGraph<Ext>()` starts a chain; the runtime lives on it:
  `graph.createStore({ ext })` (client), `graph.parse(raw, ext)` (server; returns
  `{ success, data, state, notes, errors }`), `graph.parsePartial(raw, ext)`. There is no
  `defineForm` and no separate mount step.
- **A field is one definition.** `.field(key, def)` or `.field(key, (c) => def | null)`.
  The function receives **one bag**: prior fields spread at top level (destructure what
  you read — `({ mode, _ext }) => …`), external context under the reserved key **`_ext`**.
  Returning `null` means the field does not exist this pass (its key goes optional).
  Declaration order is the dependency order; you cannot read a later field (compile error).
- **A definition object:** `{ output, input?, default, meta?, scope?, correct?, coerce?,
  toOutput? }`. `output` is the strict zod schema (submit/server). `input` is OPTIONAL —
  omitted, untrusted boundaries (storage, raw parse) parse leniently with the output
  schema and fall back to the default. Declare `input` only for coercion, key migration,
  or restoring invalid persisted drafts (`textOf({ output })` does that for text).
- **`.computed(key, (c) => value)`** — derived read-only keys.
- **Helpers** cache their zod schemas automatically, keyed on their inputs. `defFamily(fn)`
  memoizes a parameterized definition family (e.g. aspect-ratio options per resolution).
- **Reuse:** a section is just another graph; its "needs" are its `Ext`; mount it with
  `.use(sectionGraph)` (the child reads needs via `_ext`, satisfied by the parent's fields
  plus ext). `.use(fn)` is plain function application for transforms like key prefixing.
- **Branching (discriminated unions):**
  - `branchOn(key, def, { a: graphA, b: graphB })` — the discriminator is a FIELD the hub
    declares; state is a union discriminated on `key`.
  - `branch(key, (ext) => memberKey, members)` — the discriminator is DERIVED from ext;
    the picked member key is stamped into state under `key` as a computed (this is how
    version tags like `wanVersion` work).
  - `branch((ext) => memberKey, members)` — untagged; no state key, and member-attached
    effects are NOT auto-scoped (they must self-guard).
  - Hubs merge member registries (`.defs`) and effects; hubs nest (a branch of hubs is
    fine) and carry the same runtime (`hub.createStore()`, `hub.parse()`).
- **Rules (effects)** run on `set()` and rewrite the patch before it becomes intent:
  - Map form: `.effect({ triggerKey: (value, { patch, state, next, _ext... }) => additions })`
    — fires when `triggerKey` is in the patch. `next` = state with the patch overlaid
    (read `next` for multi-field decisions). NOTE: the rule ctx uses `ext` (no
    underscore) — only definition bags use `_ext`.
  - Callback form: `.effect(({ patch, state, next }) => additions)` — runs on every patch,
    for decisions spanning keys.
  - Rules attached to a member of a TAGGED hub auto-scope to that member being active.
- **Corrections:** a def's `correct: (value) => { value, reason, detail? } | undefined`
  snaps a value with a recorded note (this is what the substitution metrics will read).
  `enumOf({ gate: { optionValue: 'reason' } })` disables an option AND corrects off it.
- **React binding:** `import { useForm, useField, useTypedField, Controller,
  MultiController, createTypedController, useFormState } from 'form-graph/react'` —
  `useForm(graph, { ext, storage })` returns the store; `persistedStorage(key)` /
  `debouncedStorage(...)` from `form-graph` for localStorage persistence. The
  `graph` prop on `Controller` types `name`/`value`/`meta` from the graph itself
  (the port's standard form); `MultiController` is one subscription over several
  fields. `graph.scope(fn)` sets a default persistence scope for every field a
  graph declares (field `scope` wins; `[]` opts out; children keep their own fn).
- **Word list:** definitions ("defs"), not codecs. `graph.defs` is the registry. There is
  no public `codec()`, `Fields`, or `FieldOptions` — if you find yourself wanting them,
  you are porting the wrong way; re-read the docs' graph model.

---

## 3. Strategy: differential parity first, strangler second

The previous arc proved the method: **never port a graph without a differential test
pinning it against the old implementation first.** The old `generationGraph.safeParse` is
the oracle; it stays in place, untouched, until the very last phase.

The differential pattern (mirror `C:\work\form-graph\src\v1\__tests__\video-parity.test.ts`):

```ts
const legacy = generationGraph.safeParse(input, ctx);       // oracle
const ported = newFamilyGraph.parse(input, ctx);            // form-graph
// assert: success/failure agreement, per-key deep equality, full key sets,
// with an explicit documented-delta allowlist per case (added/missing/valueDeltas).
```

Put differential tests in `src/shared/form-graph/generation/__tests__/` (new directory;
they run in the `unit` vitest project automatically). Ported graphs live in
`src/shared/form-graph/generation/<family>.ts` until the final swap, so old and new
coexist without touching consumers.

---

## 4. Phases

### Phase 0 — dependency + spike (small)

1. `pnpm add form-graph@^0.2.0` (root workspace package).
2. Write a 20-line spike test: build a 2-field graph with `defineGraph`, `parse` a raw
   record, assert the result — proving the package imports, zod v4 interop works, and the
   vitest `unit` project picks it up.
3. Run it: `pnpm exec vitest run --project 'unit*' <the spike file>`.

**Closing condition:** the spike test passes in this worktree; committed.

### Phase 1 — the video slice (medium)

**Scouting findings — read before starting. The reference ports are a SHAPE GUIDE, not
code to copy:**

- They were written against a **vendored snapshot that has drifted from live**. Live
  `wan-graph.ts` has **six** versions (v2.1, v2.2, v2.2-5b, v2.5, v2.7, **v3.0**); the
  reference has five — v3.0 must be ported fresh from the live file. Live LTX matches
  the reference (v2, v23, v25).
- The live tables have **different names** than the reference's vendored copies (live
  `wan21AspectRatiosByResolution` vs reference `wan21AspectRatioList`, etc.).
- **COPY constants/tables/helpers out of the graph files into the port — do not import
  them** (Briant, 2026-09-01, reversing the earlier import-only rule). Every `*-graph.ts`
  file plus `common.ts` and `version-ids.ts` is deleted at the end of the migration, so
  an import from them blocks Phase 6; a copy stops being duplicate code the day they go.
  The differential suite pins the copies against the originals while both live, so drift
  is caught. What the port MAY keep importing: `generation/config` (workflow/ecosystem
  availability tables), `generation/gates.ts`, `generation/context.ts` (the ext type),
  `~/shared/constants/*`, `~/utils/*` — domain config that survives the migration.
  Gate/ecosystem-state logic copied from `ecosystem-graph.ts` lives in
  `form-graph/generation/ecosystem-gates.ts`.
- The reference's `defs.ts` uses `codec()`, which form-graph 0.2.0 **no longer exports**.
  This is NOT a missing capability — `codec()` was a pure identity function for typing.
  Replace `codec<T, M>({…})` with an object literal typed `FieldDef<T, M>` (exported).

Steps:

1. Port `ltx`, `wan` (all six versions) and the video hub into
   `src/shared/form-graph/generation/video/`, reading the live `*-graph.ts` as the source
   of truth and the reference ports as the shape guide.
2. Import every table and version id from the live graph files via
   `~/shared/data-graph/generation/…`.
3. Build the family case list on the differential harness (below).
4. Grow the case list: every LTX/Wan ecosystem × workflow × a gated-ext variant, plus the
   reconcile probes (workflow↔ecosystem coupling).

**The differential harness already exists and is smoke-tested:**
`src/shared/form-graph/generation/__tests__/differential.ts`. A family suite is a case
table plus `assertDifferential(portedGraph, testCase, TEST_CTX)`. It compares
success/failure, the full key sets, and per-key values. Declared deltas
(`added`/`missing`/`valueDeltas`) must carry a written reason inside the string, must be
REAL (a stale entry fails the test), and cannot be declared on a case where both sides
fail. `harness.smoke.test.ts` holds its negative controls — keep them green.

**Closing condition:** the video differential suite passes with an empty (or explicitly
documented) delta allowlist; committed. If a delta cannot be explained, STOP and write it
up for Briant instead of allowlisting it.

### Phase 2 — remaining families, one PR-sized commit each (large, repetitive)

There are ~50 more family graphs. For each family (suggested order: `flux-graph.ts` first
— the form-graph repo's corpus has a flux sample to crib from — then the SD/image
families, then audio/video exotics):

1. Read the old `<family>-graph.ts` end to end.
2. Write `src/shared/form-graph/generation/<family>.ts` as a form-graph graph. Patterns:
   - per-version subgraphs + `branch('versionKey', pick, members)` for version families;
   - shared segments as graphs mounted with `.use`;
   - node `transform`/`correct` logic → def `correct` policies;
   - old effects/reconcilers → `.effect` maps (or the callback form for multi-field
     decisions — read `next`, not `state`, for any field that may be in the same patch);
   - gates → output-schema `.refine` for refusal, `enumOf`'s `gate` for option
     disabling, `correct` for snapping.
3. Write the differential test BEFORE declaring the family done: old root
   `generationGraph.safeParse` vs the ported family graph, over that family's ecosystems,
   workflows, and representative stored-value inputs.
4. Run scoped tests (`pnpm exec vitest run --project 'unit*' <files>`), commit per family
   (or per small group of trivial families).

**Closing condition:** every family in `src/shared/data-graph/generation/*-graph.ts` has
a ported twin and a green differential test; the composed root (next phase's subject)
is the only thing left. Keep a checklist table at the bottom of this file updated as
families land.

### Phase 3 — the composed root + ecosystem hub (medium, delicate)

Port `generation-graph.ts` + `ecosystem-graph.ts` as the top-level hub: head fields
(workflow/ecosystem/gates/quantity/priority/outputFormat), the family dispatch (a
`branch` over the family graphs), and the ecosystem↔workflow couplings as `.effect`
rules. The reference `video-hub.ts` shows exactly this shape for two families.

**One hub per output type — do not port v1's shared ecosystem field as-is** (Briant,
2026-09-01). v1 has one ecosystem field serving image/video/audio/model3d; the port
gives each output type its own hub owning only its ecosystems (`videoHub` is already
trimmed this way — its default is video-only, its quantity has no image branch). The
root then becomes: workflow + the output/input computeds hoisted up, and a
`branchOn`-style dispatch over the per-output-type hubs. Each hub keeps the
selection/derived split internally: the family's `emit: 'ecosystem'` computed
shadows the same-named selection field off the wire implicitly — no
`emit: false` needed on the field.

**Closing condition:** a root differential suite — the full old
`generationGraph.safeParse` vs the ported root's `.parse` — passes over a broad matrix
(every ecosystem × its workflows × gated/ungated ctx × a stored-values variant), plus
reconcile-sequence probes through live stores. This is the effort's centerpiece test;
budget real time for the case list.

**Phase 4/5 groundwork (built 2026-09-01, uncommitted):** the handler lane lives at
`src/server/services/orchestrator/form-graph/` — per-family `*.handler.ts` transcribed
from the data-graph handlers but importing only ported modules, a dispatcher
(`createFormGraphStepInput`, loud error on unported ecosystems), and a differential
test feeding BOTH dispatchers the same parsed data and asserting identical steps.
The client lane lives at `src/components/form-graph/generation/` —
BaseGenerationForm (owns the store over the composed root via FormProvider,
renders the workflow picker + submit footer, switches on the `output` computed) +
Image/VideoGenerationForm in the generation_v2 GenerationForm idiom: one
`<Controller graph={imageHub|videoHub} name=...>` per field (typed from that
hub's registry — and, for computeds/branch tags like `wanVersion`, from its
state type), wired to the REAL generation_v2 input components
(BaseModelInput, ResourceSelect*, ImageUploadMultipleInput, VideoInput,
GenerationTextEditor, ControlNetsInput, AspectRatioInput, Priority/OutputFormat,
ActiveWildcards with the ported add/remove flow, ResourceAlerts via
MultiController). Demo at `/form-graph` (standalone page; mounts
ResourceDataProvider itself). Not yet ported from v2's form: compatibility-confirm
modal flows, prompt-enhance button, presets, tours, remix handling, and the whatIf
cost footer; submit ends at `validate()`.

**Persistence (2026-09-01):** v1's ~540-line grouped storage adapter maps onto
per-graph scopes. The lib grew `graph.scope(fn)` (graph-level default scope;
field `scope` — including `[]`, the bare-key opt-out — wins; mounted children
keep their own fn). The layout, mirroring v1's groups: every family graph and
branch member carries `.scope(familyScope)` (ecosystem group id, else key —
wan versions and klein variants share buckets); `SEED` and `controlNetsDef`
opt out to bare keys (v1 stores them globally); images/video wrap their def fns
in `workflowScoped` (per-workflow buckets); the hubs scope `ecosystem` per
output type, `quantity` per workflow only on draft, `enhancedCompatibility`
per family bucket; and the turbo-variant families (zimage/boogu/krea2/anima/ernie/lens/mage-flow — all seven ported
entries of v1's TURBO_VARIANT_ECOSYSTEMS) refine
cfgScale/steps `perModelScope` — per model version, v1's
TURBO_VARIANT_ECOSYSTEMS. One localStorage record under `form-graph:generation`
(`persistedStorage`, debounced, flushed on pagehide) attached in
BaseGenerationForm. Layout pinned by `__tests__/persistence.test.ts`.
Not decided (Briant): migrating v1's stored values (different keys AND record
shape — v1 splits across many localStorage keys) vs a one-time reset; and v1's
"preferences survive reset" semantics (outputFormat/priority), which belongs to
the reset affordance when one exists. Store-path gotcha this surfaced: STORE
state holds raw inputs (a bare-number model), so mode picks and scopes read ids
via `modelIdOf` rather than `.id`.

### Phase 4 — server swap (small, high-stakes)

1. Write one adapter in `src/server/services/orchestrator/`: a function with the exact
   shape the three call sites expect from `generationGraph.safeParse`, implemented over
   the ported root's `.parse` (map `notes` → whatever the substitution metrics read —
   study `generation-model-substitution.metrics.ts` first; its tests must stay green).
2. Swap the call sites (`orchestration-new.service.ts`, `legacy-metadata-mapper.ts`)
   behind that adapter.
3. Run the covering suites for those services, then the FULL unit suite once.

**Closing condition:** full unit suite green (compare failing files against `main` via
stash before blaming the port); substitution-metrics tests green; committed. **Ask
Briant before this phase begins** — it changes the production submit path.

### Phase 5 — client swap (large, UI)

Replace `DataGraphProvider`/`useDataGraph` usage with `form-graph/react`
(`useForm(rootGraph, { ext, storage: persistedStorage(...) })`, `useTypedField`,
`createTypedController`). `GenerationFormProvider.tsx` is the hub; port it first, then
walk the ~119 consumer files (most only consume via the provider's context and need
import/type updates, not logic changes). Storage: the adapter layout is built (see the Persistence note under the Phase 4/5
groundwork above); the v1 stored-value migration-vs-reset decision recorded there is
the remaining Phase 5 item.

**Closing condition:** the generation form works end to end in the dev server (use the
`/dev-server` skill; verify with `probe`), typecheck green, full suite green. This phase
needs Briant's hands-on testing before it is called done.

### Phase 6 — deletion

Delete `src/libs/data-graph/`, `src/shared/data-graph/generation/` (the old graphs),
move `form-graph/generation/` to its final home (`src/shared/generation-form/` or Briant's choice),
delete the differential suites (they die with their oracle), and run `docs-drift-review`
+ `comment-review` over the branch.

**Closing condition:** no import of `~/libs/data-graph` or the old graph paths remains
(`grep -rn "libs/data-graph\|shared/data-graph/generation" src` is empty besides the new
home); full suite + typecheck + lint green; Briant reviews the final diff.

---

## 5. Repo rules the executing model MUST follow (digest of CLAUDE.md + preferences)

- **Never commit without being in this worktree's branch**; commit at phase boundaries
  with descriptive messages; **never push or open a PR without Briant's approval**.
- Tests: run scoped files during iteration
  (`pnpm exec vitest run --project 'unit*' <files>` — the quotes and `*` are
  load-bearing); the FULL `pnpm run test:unit:run` once per phase, not per edit.
- Validate this worktree's test runs: `blocks.router.workflow.test.ts` must COLLECT a
  nonzero test count (if it collects 0, the submodule/setup is broken and the run is
  meaningless).
- Prettier: `pnpm run prettier:write` formats only uncommitted files — never widen it.
- Dev server: only via the `/dev-server` skill; never `pnpm run dev` directly; never
  curl a dev port (use `probe`).
- Do not modify the `form-graph` package from this repo. If the port reveals a
  form-graph bug or missing capability, STOP and write it up for Briant — the fix
  happens in `C:\work\form-graph`, gets published, and the version bumps here.
- Do not touch `src/shared/data-graph/` or `src/libs/data-graph/` (the oracle) until
  Phase 6. The old system must keep working untouched through Phases 0–5.
- When a differential test disagrees with the port, **the oracle is right** — fix the
  port. Only allowlist a delta with a written reason; a delta you cannot explain is a
  stop-and-ask.

## 6. Known traps

- The form-graph API in your training data is wrong; even recent memory of it may be
  stale. The docs site + section 2 above are authoritative. Notably: one-bag def
  functions with `_ext`; no `defineForm`; "defs" not "codecs"; input optional.
- `branch` pick functions receive EXT directly (no bag) — `(ext) => key`.
- Rules see the RAW patch (pre-schema); read `next` for effective multi-field values.
- Untagged hubs don't auto-scope member effects; tagged ones do (on the stamped key).
- data-graph's node semantics won't map 1:1 everywhere — its `when`/`with`/`constrain`
  and dependency-array machinery have no direct equivalents. The mapping table in
  Phase 2 step 2 covers the known cases; anything outside it is a stop-and-ask, not an
  improvisation.
- Some old graphs read `Date.now()`/randomness — fine in this repo (no such restriction
  here), but keep such reads out of the differential inputs or the tests will flake.
- **v1's checkpoint effect runs during safeParse and the MODEL WINS in unlocked
  families**: a cross-ecosystem model keeps its value and drags `ecosystem` (and every
  ecosystem-dependent field) with it. Within a family that is the `effectiveEcosystem`
  `emit: 'ecosystem'` computed + `checkpointDef({ modelWins: true })` — see image/sd.graph.ts
  and video/ltx.graph.ts (probed 2026-09-01: oracle kept the SD1.5 model on an SDXL selection
  and produced SD1 data). **CROSS-family and cross-VERSION
  switching are handled by `generation/reconcile.ts`** (decided 2026-09-01): one pure
  policy (`deriveSelectorsFromModel`) with two adapters — `reconcileSelectors(raw)`
  applied BEFORE `parse` at the boundary (the differential harnesses compose it into
  their port wrapper; the production call site lands with the Phase 4 submit wiring,
  beside `normalizeInput`), and `modelSelectorRules` attached with `.effect` on both
  hubs so an interactive pick moves the selectors identically. Two ordering truths the
  matrix forced: a LOCKED slot (ecosystem-defaults `modelLocked`, or flux's draft
  workflow) beats a cross-family model — v1 substitutes it before its effect runs — but
  version SIBLINGS (LTX↔LTX, wan↔wan) re-pick THROUGH the lock, since they are valid in
  the locked picker's own version list; and a gate-HIDDEN selection drops to the default
  before v1's model effect runs, an ordering the ext-free boundary reconciler cannot see,
  so that one combo stays scoped out of the matrix. The family computeds
  (`effectiveEcosystem`) now delegate to the same policy via `effectiveEcosystemOf`.
- The oracle emits `controlNets: []` (not undefined) when nothing is staged — the def
  carries `default: []` for that reason.
- Both matrices now carry a `gated` context (rules-hidden ecosystem in the image suite,
  rules-disabled workflow in both) and model/resource/vae shapes, so the gate refusals
  and the parse-time compat filters are differentially pinned. Seedance is ported, so the video
  suite pins the hidden-ecosystem drop too.
- **An ecosystem that doesn't support the workflow REDIRECTS during parse** (v1's
  workflow→ecosystem sync effect): txt2img + WanVideo30 parses as SD1. Ported as
  `resolveCompatibleEcosystem` in ecosystem-gates.ts, applied in both hubs' input
  transforms, with v1's workflow-group override guard (wan T2V↔I2V switches stay
  in-family). Redirect targets that land on UNPORTED families (txt2vid + SDXL → HyV1)
  parse into the wrong family until those families arrive — keep such combos out of
  the matrices.

## 7. Family checklist (update as you go)

| Family | Ported | Differential green | Notes |
| --- | --- | --- | --- |
| video: wan (all 6 versions incl. v3.0) | DONE | DONE | LIVE HAS v3.0, reference does not — shape guide: C:\work\form-graph\src\v1\ports\wan.ts |
| video: ltx (v2/v23/v25) | DONE | DONE | model-wins split like sd (`effectiveEcosystem` emit); cross-VERSION re-pick handled by `reconcile.ts` (version siblings re-pick THROUGH the lock). v1's `enablePromptEnhancer` node (`when: false` — never shown, never in data) is deliberately NOT ported; revive it from ltx-graph.ts if the flag ever flips |
| video hub (ecosystem/quantity, video-scoped) | DONE | DONE | workflow/output/input moved to the composed root |
| composed root (`form-graph/generation/hub.graph.ts`, image+video dispatch) | DONE | DONE | audio/model3d hubs arrive with their families |
| image hub (ecosystem/priority/outputFormat/enhancedCompatibility/quantity) | DONE | DONE | enhancedCompatibility + quantity sit AFTER the family dispatch (they read model/effectiveEcosystem) |
| image: stable-diffusion (SD1/SD2/SDXL/Pony/Illustrious/NoobAI) | DONE | DONE | ecosystem FOLLOWS a cross-eco model (`effectiveEcosystem` emit; `checkpointDef modelWins`); SD2 supports no workflows |
| image: zimage (Turbo/Base) | DONE | DONE | Base's negativePrompt is NOT a snippet target (v1 mode-subgraph quirk) |
| image: chroma | DONE | DONE | no negative prompt, no images node |
| video: seedance | DONE | DONE | no resources, no negative prompt; resolution/duration ceilings per model version. Unblocked the video suite's hidden-ecosystem gate coverage (hidden selections fall back to Seedance) |
| image: flux (Flux1/FluxKrea, 5 modes) | DONE | DONE | `workflowVersions` turned out UNUSED by flux — its draft coupling is two sync effects, resolved at parse as "the workflow wins" (both directions are `correct` policies on the model, probed 2026-09-01). The `fluxMode` tagged branch picks on `model.id` — a mounted branch's pick sees prior fields via ctx-over-ext. Kontext/Flux2/Klein are separate graphs (rows below). |
| image: flux-kontext (pro/max) | DONE | DONE | img2img-primary; both modes share one field set, so the mode is just a version pick — no branch |
| image: flux2 (dev/flex/pro/max) | DONE | DONE | mode by model.id; only dev carries resources |
| image: flux2-klein (9B/9B-base/4B/4B-base) | DONE | DONE | FOUR ecosystems share the graph — mode from ecosystem, not model. negativePrompt is NOT a snippet target (v1's own comment claims it self-registers; the differential says no). Handler pins distilled steps/cfg even though the graph exposes a steps slider — v1 quirk, mirrored |
| image: boogu (base/turbo/edit/editTurbo) | DONE | DONE | workflowVersions: version options are WORKFLOW-scoped and the MODEL WINS the workflow (probed — an edit checkpoint on txt2img parses as img2img:edit, model kept; v1's index-remap transform is dead code). The cross-workflow rewrite lives in `reconcile.ts` (`deriveWorkflowFromModel`, registry `workflowScopedVersions`) since a family cannot change the root workflow. negativePrompt only in base/edit modes |
| image: krea2 (fal/raw/turbo/editRaw/editTurbo) | DONE | DONE | locked checkpoint; version selector splits across FAL (creativity/styleReferences) and comfy (LoRA/cfg/steps) engines; img2img:edit narrows the picker to comfy builds and the lock substitutes FAL tiers to the edit default. NO cross-workflow pull (unlike boogu) |
| image: imagen4 | DONE | DONE | locked single version; negative prompt registers at top level |
| image: pony-v7 | DONE | DONE | LoRAs, no negative prompt; ecosystem-defaults lock applies |
| image: reve | DONE | DONE | locked; AR on txt2img only, edit takes 1-4 reference frames |
| image: mai | DONE | DONE | locked; edit crops the single reference to a supported ratio |
| image: ernie (base/turbo) | DONE | DONE | RAW resourcesNode in v1 — `resourcesDef({ filterIncompatible: false })`, foreign LoRAs pass through and only the limit binds |
| image: seedream (5 versions) | DONE | DONE | one field set; 2K/4K toggle gated per version (v5.0-pro is 2K-only) |
| image: anima (base/turbo) | DONE | DONE | comfy sampler/scheduler names; controlNets behind the `animaControlnet` fail-open flag |
| image: mage-flow (4 workflow-scoped versions) | DONE | DONE | workflowVersions where the WORKFLOW wins — the oracle index-remaps a cross-workflow version (opposite of boogu, probed); the remap is a `correct` in the graph |
| image: hi-dream (fast/dev/full × fp8/fp16) | DONE | DONE | hierarchical VersionGroup picker; negativePrompt only in full, snippet registration never fires |
| image: hi-dream-o1 (full/dev) | DONE | DONE | ecosystem KEY is `HiDream-O1` (dash); v1 mounts no snippetsGraph — `makeTextBlock({ snippets: false })` |
| image: openai (v1/v1.5/v2) | DONE | DONE | gpt1 arms carry the transparency toggle; gpt2 drops seed handling in the engine but keeps the field |
| image: lens (base/turbo) | DONE | DONE | raw resourcesNode (no filter); resolution above the variant branch, AR follows it |
| image: qwen (Qwen/Qwen2/Qwen3) | DONE | DONE | one graph, untagged sub-branch on ecosystem; Qwen's workflow-scoped versions hit the LOCK (cross-workflow version substitutes to the current workflow's default — probed, a third semantics next to boogu/mageflow) |
| image: nano-banana (standard/pro/v2/v2lite) | DONE | DONE | resolution-multiplied AR dims; negativePrompt only in pro, not a snippet target |
| image: grok | OPEN | OPEN | spans BOTH output types (grokImageGraph + grokVideoGraph split on output) — needs a member in each hub sharing constants; the last image-hub family |
| video: happy-horse, minimax, kling, veo3, vidu, sora, mochi, hunyuan, flux3-video, wan-image + audio/model3d hubs | OPEN | OPEN | the video/audio/3d tail — same loop as the image slice |
| _…add a row per `*-graph.ts` file during Phase 2 inventory…_ | | | |

---

## 8. Mapping rules proven in Phase 1 (apply these in Phase 2)

The video slice reached full differential parity (936 generated cases). These
are the data-graph -> form-graph correspondences it established; use them
rather than re-deriving, and add to the list when a family teaches something new.

| data-graph | form-graph | note |
| --- | --- | --- |
| `.node(key, {...})` | `.field(key, def)` | `defaultValue` -> `default` |
| `.node(key, (ctx, ext) => ({...}))` | `.field(key, ({ prior, _ext }) => def)` | destructure what you read |
| `when: false` on a node | return `null` from the field fn | key goes optional |
| `.computed(k, fn, deps)` | `.computed(k, fn)` | deps are the chain |
| `.discriminator(k, {...})` after `.computed(k, ...)` | `branch(k, pick, members)` | TAGGED: stamps k into state |
| `.merge(subgraph)` | `.use(graph)` | needs are the child's Ext |
| node `transform` | `correct` policy | runs in resolution, records a note |
| **effect that is a pure function of resolved fields** | **`correct` on the field it changes** | 🔴 NOT `.effect` — see below |
| effect reacting to a USER edit | `.effect({ trigger: ... })` | set()-time only |

🔴 **The single most important finding:** data-graph runs effects during
`safeParse`; form-graph runs rules on `set()` only. Any effect whose outcome is
a deterministic function of other resolved fields MUST become a `correct`
policy, or server-side parse will diverge from the client. The video port hit
this with Wan's workflow->ecosystem sync; every family with cross-node effects
will hit it too.

**"Mutually dependent" fields are a modeling smell, not a porting problem.**
Wan 2.1 taught this the long way: its ecosystem/resolution "cycle" was v1
conflating the user's SELECTION with a backend target DERIVED from resolution,
under one key — kept consistent by an iterating effect. Do NOT port the
iteration (a parseFixpoint helper was built for this and then deleted). Split
the facts instead: the field holds the selection; the derived value is computed
where its inputs already exist — a later definition function (v2.1's `model`
reads the backend off `resolution`, declared before it) — and the conflated
OUTPUT key is produced at the submission boundary (`parseVideo` derives
`ecosystem` after parse; the Phase 4 adapter ships that projection). If a
family's effects look like they need iteration, find the two facts wearing one
key first.

**Watch for text editors that are plain nodes.** `createTextEditorGraph`
registers its key in `snippets.targets`; a plain `negativePromptNode()` does
not (Wan 2.7). The snippets VALUE differs, so the differential catches it —
but only if the case list turns the `wildcards` flag on. Include a
wildcards-on context in every family's matrix.
