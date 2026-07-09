# Generation Gating — Consolidation Plan

> Status: **Partially implemented** (branch `refactor/generation-gating-consolidation`).
> Captures how to collapse the duplicated wiring behind the generation "gating"
> features (gated ecosystems, self-hosted toggle, disabled workflows).

## What landed (and what was deliberately skipped)

The guiding rule was **net less code + fewer files to touch for a future gate** —
not new abstraction. Only the changes that actually _reduce_ were taken:

- ✅ **P0 — one zod schema.** `GenerationEcosystemConfig` type, its `DEFAULT`,
  and the router's `ecosystemConfigInputSchema` (three copies of the same field
  list across three files) collapsed into a single `generationEcosystemConfigSchema`
  in `generation.schema.ts`; the type (`z.infer`), default (`parse({})`), and
  mod-write validation all derive from it. **A future gate is one line here**
  instead of edits in three files.
- ✅ **P1 — deleted the per-field client hooks.** `useGatedEcosystems` /
  `useGatedVersionIds` / `useSelfHostedDisabledEcosystems` / `useDisabledWorkflows`
  (and their file) are gone; `useGenerationConfig` now merges defaults so callers
  read `useGenerationConfig().<field>` directly. **A future gate adds no hook.**
- ❌ **Skipped — `gatedStringSchema` / disabled-badge component / shared `toGenerationExt`.**
  Each would be _new_ shared code for only 2–3 call sites (code gain, not
  reduction); the inline refines/badges are short and clear. Left as-is.
- ⏸️ **Deferred — the gate registry (P2 below).** A type/schema-generating
  registry is framework machinery that adds more than it removes for 3 gates.
  Revisit only if gates keep multiplying.
- 🔜 **Remaining real reduction (not done): the mod-config form.** The per-field
  type/empty/hydrate/save/render repetition in `generation-config.tsx` is the
  largest leftover per-gate cost; a field-descriptor-driven form would collapse
  it. Deferred because it's a riskier UI change and wasn't worth bundling here.

---

> The original plan is preserved below for context.

## The problem

We now have **three** operator-controlled gating mechanisms layered onto the
generator, all built the same way but wired by hand:

| Gate                                                | Behavior                       | Scope                                 | Where the source list lives                                                   |
| --------------------------------------------------- | ------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------- |
| `gatedEcosystems` / `gatedVersionIds`               | **Hide** ecosystems / versions | per-user (mod/testing/green resolved) | `GenerationEcosystemConfig` (Redis `generation:ecosystem-config`)             |
| `selfHostedDisabledEcosystems` (+ `selfHostedMode`) | **Show-but-disable** + alert   | per-user (member/mod resolved)        | `generationStatus` (Redis `generation:status`) + `SELF_HOSTED_ECOSYSTEM_KEYS` |
| `disabledWorkflows`                                 | **Show-but-disable**           | global (no resolution)                | `GenerationEcosystemConfig` (Redis `generation:ecosystem-config`)             |

Each new gate touches **~10–12 files** in the same shape. Adding
`disabledWorkflows` (the smallest of the three — global, binary) still required
edits in 11 files. That's the smell: the per-gate skeleton is copy-pasted rather
than abstracted.

### The repeated skeleton (per gate)

Every gate threads the same value through these layers:

1. **Redis config type + default** — `GenerationEcosystemConfig` in
   [server/common/constants.ts](../../src/server/common/constants.ts) (or a field on
   `generationStatusSchema` for the self-hosted toggle).
2. **Read/write service** — `getGenerationEcosystemConfig` /
   `setGenerationEcosystemConfig` (or `get/setGenerationStatus`).
3. **Per-user resolver** — `getGatedListsForUser` / `getSelfHostedDisabledEcosystems`
   in [generation.service.ts](../../src/server/services/generation/generation.service.ts).
4. **Response assembly** — `GenerationConfig` type + `getGenerationConfig` return.
5. **Router schema** — `ecosystemConfigInputSchema` / `setSelfHostedStatus` input in
   [generation.router.ts](../../src/server/routers/generation.router.ts).
6. **Graph context type** — a field on `GenerationCtx`
   ([context.ts](../../src/shared/data-graph/generation/context.ts)).
7. **Server ext builder** — `buildGenerationContext`
   ([orchestration-new.service.ts](../../src/server/services/orchestrator/orchestration-new.service.ts)).
8. **Client ext builder** — `GenerationFormProvider` externalContext memo.
9. **Client default** — `DEFAULT_GENERATION_CONFIG` in
   [generation.utils.ts](../../src/components/ImageGeneration/GenerationForm/generation.utils.ts).
10. **Client hook** — `useGatedEcosystems` / `useSelfHostedDisabledEcosystems` /
    `useDisabledWorkflows` (all near-identical one-liners over `useGenerationConfig`).
11. **Graph node consumption** — `output` `.refine()` (+ `meta`) on the ecosystem /
    workflow node, with the meta-as-function gotcha.
12. **Picker UI** — `BaseModelInput` / `WorkflowInput` re-implement the
    badge + grey-out + block-selection branch.
13. **Mod UI** — a form field + `TagsInput`/`MultiSelect` + save in
    [generation-config.tsx](../../src/pages/moderator/generation-config.tsx) (or a card for the toggle).

## Consolidation opportunities

Ranked by value/effort. Each is independently shippable.

### P0 — Co-locate the config (the explicit ask, low risk)

Move the gating **config shapes out of `server/common/constants.ts`** into a
dedicated generation-gating module so the Redis config, defaults, resolver, and
response type live together instead of being scattered.

- Move `GenerationEcosystemConfig`, `GenerationEcosystemContext`,
  `DEFAULT_GENERATION_ECOSYSTEM_CONFIG` → a new
  `src/server/services/generation/generation-gating.constants.ts` (or
  `src/shared/constants/generation.constants.ts` if we want it shared — but it's
  a server/Redis shape, so a server module is the cleaner home).
- Co-locate the resolvers (`getGatedListsForUser`, `getSelfHostedDisabledEcosystems`,
  the `disabledWorkflows` passthrough) and `GenerationConfig` next to it.
- **Pure move + re-export shim** so call sites don't churn in the same PR.

This alone makes the surface legible without changing behavior.

### P1 — Extract the obvious shared helpers (medium value, low risk)

These remove literal duplication with no architectural change:

- **`gatedStringSchema(disabledList, message)`** — the
  `list?.length ? z.string().refine(v => !list.includes(v), { message }) : z.string()`
  block is copy-pasted in the ecosystem node and the workflow node. One helper.
- **Picker "disabled option" primitive** — `BaseModelInput.renderItem` and
  `WorkflowInput.WorkflowMenuItem` both implement: grey + `cursor-not-allowed`,
  block `onClick`, `<Badge>Disabled</Badge>`, tooltip. Extract a shared
  `DisabledOptionBadge` + a `useDisabledSet(list, keyFn)` helper.
- **Collapse the client hooks** — `useGatedEcosystems` / `useGatedVersionIds` /
  `useSelfHostedDisabledEcosystems` / `useDisabledWorkflows` are identical
  field reads over `useGenerationConfig`. Replace with a single
  `useGenerationConfig().<field>` access or one tiny `useGenerationGate(field)`.
- **Shared `GenerationCtx` builder** — `buildGenerationContext` (server) and
  `GenerationFormProvider` (client) assemble the _same_ gating fields from the
  _same_ resolved config. Extract a `toGenerationExt(config, user)` used by both
  so they can't drift (today they're maintained in parallel).

### P2 — Declarative gate registry (high value, higher effort)

The structural fix: describe each gate **once** and generate the wiring.

```ts
// one entry per gate
const GENERATION_GATES = {
  disabledWorkflows: {
    redis: 'ecosystem-config',
    scope: 'global', // | 'per-user'
    behavior: 'disable', // | 'hide'
    target: 'workflow', // | 'ecosystem' | 'versionId'
    default: [] as string[],
  },
  // gatedEcosystems, selfHostedDisabledEcosystems, ...
} as const;
```

From the registry, derive: the config type + default, the response shape +
resolver, the router input schema, the `GenerationCtx` fields, and the client
default. The per-gate work shrinks from ~12 files to **one registry entry +
the UI surface** (picker rendering and mod-UI control, which stay bespoke).

This is the only change that actually fixes "we touch too many files." It's also
the riskiest, so it should come after P0/P1 have de-risked the surface.

## Risks / constraints to preserve

Whatever we do, keep these invariants (each was a real bug during the original
builds):

- **Graph `meta` must stay a function** where it depends on async `ext`
  (`getGenerationConfig` loads after the graph inits). Static-object meta goes
  stale — see the ecosystem node's `meta: (ctx, ext) => …`.
- **Server is the enforcement boundary.** `buildGenerationContext` → `safeParse`
  runs the node refines; the client refine is best-effort (and stale for the
  workflow node, which has no deps). Don't let a refactor drop the server path.
- **Server/client `ext` parity.** The two ext builders must produce the same
  gating shape — the shared builder (P1) is the durable fix.
- **Resolution differs per gate** (`global` vs per-user member/mod/testing). The
  registry's `scope` must encode this; don't flatten it away.
- **Cache invalidation.** Mod writes purge `generation-status` (edge) and
  invalidate `getGenerationConfig` (client). `getGenerationConfig` is
  `staleTime: Infinity`, so active sessions only refresh on reload — a known
  limitation, not something to silently change here.

## Suggested sequencing

1. **P0** co-locate config (1 PR, pure move + shim).
2. **P1** helpers (`gatedStringSchema`, disabled-badge primitive, hook collapse,
   shared ext builder) — small independent PRs.
3. **P2** registry — only if we keep adding gates; otherwise P0+P1 already make
   the next gate ~half the files.

## Out of scope

- The `canGenerate` site-wide gap (self-hosted/workflow gates not enforced in
  `getResourceCanGenerate`) — tracked separately in the self-hosted doc; a
  registry could make it cheaper to close but isn't a prerequisite.
- Behavioral changes to any gate. This is purely structural.
