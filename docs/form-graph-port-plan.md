# Porting data-graph to the `form-graph` package

**Branch:** `feat/form-graph-port` (this worktree, `C:\work\worktrees\form-graph-port`)
**Owner:** Briant. The executing agent commits at phase boundaries on this branch; it never
pushes, opens PRs, or merges without Briant's explicit approval.

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
  createTypedController, useFormState } from 'form-graph/react'` —
  `useForm(graph, { ext, storage })` returns the store; `persistedStorage(key)` /
  `debouncedStorage(...)` from `form-graph` for localStorage persistence.
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

Put differential tests in `src/shared/data-graph/__ported__/__tests__/` (new directory;
they run in the `unit` vitest project automatically). Ported graphs live in
`src/shared/data-graph/__ported__/<family>.ts` until the final swap, so old and new
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

### Phase 1 — the video slice, from the reference (medium)

Port LTX + Wan + the video hub by adapting the finished reference ports:

1. Copy `wan.ts`, `ltx.ts`, `video-hub.ts`, `defs.ts` from
   `C:\work\form-graph\src\v1\ports\` into `src/shared/data-graph/__ported__/video/`.
2. Rewire imports: `'../../lib/core/index.js'` → `'form-graph'`; their `constants.js`
   imports point at this repo's real modules under `src/shared/data-graph/generation/`
   (the reference's `constants.ts` was a vendored copy — import the originals via `~/`).
   `gates.ts` similarly: the reference used a copy of this repo's `gates.ts`.
3. Copy + adapt the differential suite from `C:\work\form-graph\src\v1\__tests__\`
   (`video-parity.test.ts` pattern) — but here the oracle is the LIVE
   `generationGraph.safeParse`, not a vendored copy, which is strictly better.
4. Grow the case list: every LTX/Wan ecosystem × workflow × a gated-ext variant, plus the
   reconcile probes (workflow↔ecosystem coupling).

**Closing condition:** the video differential suite passes with an empty (or explicitly
documented) delta allowlist; committed. If a delta cannot be explained, STOP and write it
up for Briant instead of allowlisting it.

### Phase 2 — remaining families, one PR-sized commit each (large, repetitive)

There are ~50 more family graphs. For each family (suggested order: `flux-graph.ts` first
— the form-graph repo's corpus has a flux sample to crib from — then the SD/image
families, then audio/video exotics):

1. Read the old `<family>-graph.ts` end to end.
2. Write `src/shared/data-graph/__ported__/<family>.ts` as a form-graph graph. Patterns:
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

**Closing condition:** a root differential suite — the full old
`generationGraph.safeParse` vs the ported root's `.parse` — passes over a broad matrix
(every ecosystem × its workflows × gated/ungated ctx × a stored-values variant), plus
reconcile-sequence probes through live stores. This is the effort's centerpiece test;
budget real time for the case list.

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
import/type updates, not logic changes). Storage: study `storage-adapter.ts` for the
existing localStorage key/shape and decide (with Briant) whether to migrate stored
intent or accept a one-time reset — form-graph's intent format differs.

**Closing condition:** the generation form works end to end in the dev server (use the
`/dev-server` skill; verify with `probe`), typecheck green, full suite green. This phase
needs Briant's hands-on testing before it is called done.

### Phase 6 — deletion

Delete `src/libs/data-graph/`, `src/shared/data-graph/generation/` (the old graphs),
move `__ported__/` to its final home (`src/shared/generation-form/` or Briant's choice),
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

## 7. Family checklist (update as you go)

| Family | Ported | Differential green | Notes |
| --- | --- | --- | --- |
| video: wan | ☐ | ☐ | reference: C:\work\form-graph\src\v1\ports\wan.ts |
| video: ltx | ☐ | ☐ | reference: ltx.ts |
| video hub | ☐ | ☐ | reference: video-hub.ts |
| flux | ☐ | ☐ | corpus sample: C:\work\form-graph\src\lib\generation\flux.ts |
| _…add a row per `*-graph.ts` file during Phase 2 inventory…_ | | | |
