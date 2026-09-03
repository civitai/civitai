---
name: form-graph-port
description: Port an existing form (a data-graph graph, or a bespoke RHF+zod form like model training) to the form-graph library. Use when asked to move a form's field logic, branching, persistence, or server validation onto form-graph. Encodes the method proven by the generation-form port — oracle-first differential testing, scope mapping, staged cutover.
---

# Porting a form to form-graph

The method that took the generation form (14 ecosystem families, 4 output types, 7
standalone workflows, ~12k differential cases) onto form-graph, distilled so the next
port (e.g. model training) doesn't rediscover it. The worked example is
`src/shared/form-graph/generation/` + `docs/form-graph-port-plan.md`; read the plan
doc's phase structure before starting anything sizable.

## 0. Read the lib's own guidance first

`C:\work\form-graph\CLAUDE.md` carries the library's design invariants (one branch
combinator, sync resolution, wire-named computedKeys, the prepack-after-every-edit rule
for `link:` consumers). Don't design against an imagined API.

## 1. Identify the oracle, then build the harness FIRST

Nothing else starts until parity is measurable.

- **Oracle = whatever produces today's wire payload.** For a data-graph form it's
  `graph.safeParse`. For a bespoke form (training: `src/components/Training/Wizard` +
  `src/server/schema/training.schema.ts` + the orchestrator validation) it's the submit
  payload builder — capture real input→payload fixtures if there's no parse function.
- **Differential = byte-identical wire.** `assertDifferential` pattern: port parse vs
  oracle parse over generated cases, plus the **parse-fixpoint pin** (re-parse the port's
  own state → identical data; this is what makes whatIf/cost preview trustworthy).
- **Bound every generated-case driver** — a fake that pages/loops must terminate on its
  own (see CLAUDE.md's microtask-loop warning; a hang is unreportable in vitest).
- Divergences found by the harness are *findings to record*, not always bugs — v1 does
  have dead paths and quirks. Pin the deliberate deltas in a comment or the plan doc.

## 2. Structure: declare-then-dispatch

- Discriminators are ordinary fields declared **above** the dispatch:
  `.field('ecosystem', def)` then `.use(branch('ecosystem', [[keys, member], ...] as const))`.
  Group related keys into one pair — arm count should equal *family* count, not key count.
- State-only discriminators (never on the wire) are computeds with `{ emit: false }` fed
  to the tagged `branch(key, pick, members, { emit: false })` form.
- Shared per-family plumbing goes in a `shared.ts` (`familyScope`, text-block factories,
  `modelIdOf`-style raw-or-parsed readers — store state holds RAW inputs, so anything
  reading ctx must accept both shapes).

## 3. Storage: map the old adapter groups to scopes

Translate the legacy storage-adapter groups (see the v1 `createLocalStorageAdapter`
config in `GenerationFormProvider.tsx` for the pattern) into graph/field `scope`
declarations: graph-level `scope` for family buckets, `rootScope()` to opt a field out
to global memory, `rootScope(workflow)` for per-workflow buckets, relative `[modelId]`
appends for per-variant refinements. One persisted record per form
(`persistedStorage('<key>')`).

## 4. Types: extract, never re-declare

`InferData` / `InferArm` / `InferLooseData` from the graph type the handlers
(`EcosystemData<'X'>` pattern in `src/shared/form-graph/generation/types.ts`). Zero
`as never`; a residual cast marks a provably-dead path and says so. After type-level
work, measure compiler cost against main (`tsc --extendedDiagnostics`, delete
`tsconfig.tsbuildinfo`, `NODE_OPTIONS=--max_old_space_size=12288` — default heap OOMs).

## 5. Stored-value migration (if old users' settings should survive)

Consumer-side module (`migrate-v1-storage.ts` is the template): read the old records,
pick ONLY the fields worth carrying, build one address→raw-value record with
`scopedAddress`, write it once iff the new key is absent. Values go in raw — the input
schemas validate on first resolve, so stale garbage degrades to defaults. Never delete
the old records while anything still reads them.

## 6. Cutover: three flags, staged

1. `<form>-shadow-parse` (Flipt) — server parses BOTH, compares, counts
   (`registerCounterWithLabels`) and logs divergence with **diff keys only — never field
   values** (user content must not reach logs; pin that with a test).
2. `<form>-parse` — serve the port's result; keep the old parse running for whatever
   metrics still tap it.
3. Client feature flag (`availability: ['mod']` first) swapping the form component.

Flags off must be byte-identical. Deleting the old engine is a separate change after the
flags have fully flipped.

## Gotchas that cost real time on the generation port

- Cross-field coherence (a selection retargeting another selection) belongs in a
  RULE on the graph (`.effect({...})` — gesture-aware, fires before resolution,
  covers every writer), NOT in transcribed v1 UI handlers. v1 kept it in handlers
  because data-graph had no rules; transcribing that architecture reintroduced a
  crash the graph could have prevented (see `selector-coherence.ts`).

- The port parse composes as `hub.parse(reconcileSelectors(raw).raw, ext)` — selector
  reconciliation is part of the parse contract, not optional plumbing.
- A generic helper over union arms hits TS's weak-type rule when one arm shares no
  properties — constrain `T extends object` and read loosely inside.
- `useForm` must be typed to preserve the store's full type (`Store extends
  FormStore<any, Ext, any, any>`), or per-arm emits break DataOf≡Ctx at mounts.
- After every form-graph lib edit: `pnpm run prepack` in the lib, or the `link:`
  consumer runs stale dist.
- Pre-PR: publish the lib as ONE version, swap `link:` → `^x.y.z`, remove any
  `turbopack.root` widening / tsconfig `react` paths pin added for the link, re-run the
  full battery.
