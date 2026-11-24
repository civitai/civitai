# Breaking import cycles

Every module in an import cycle reaches every other module in it, and everything those import. A
page or API route that imports any one of them pulls all of it into its import graph (its
"reach"), so a cycle in `src/` makes the graph heavier for every entry point that touches it.
Breaking cycles shrinks each entry point's reach.

Dynamic `import()` counts. The bundler still builds a dynamic import's target, as a separate
chunk, so moving an edge to a call-site `await import()` only puts off when the target loads; it
does not shrink what the build compiles.

## Find the next cut

```bash
pnpm exec tsx scripts/import-cycles.ts            # cycles, ranked cuts, page and API reach
pnpm exec tsx scripts/import-cycles.ts --cuts 50  # rank further down the list
pnpm exec tsx scripts/import-cycles.ts --json out.json  # also write the report as JSON
```

For each cycle of ten or more modules, it lists edges in the order that shrinks the cycles fastest,
with the cycle sizes left after each cut. The ranking assumes the edge disappears outright. A real
fix sometimes moves the edge rather than removing it, so re-run after each change rather than
working down an old list. The `(dynamic)` marker means the edge is an `import()`, either a
call-site `await import()` or a `next/dynamic` component. Some are earlier cycle fixes that hid the
edge from the old static-only guard; others, like the trigger files below, were never meant as cuts.

Reach is the number this work is trying to move, not the cycle count itself.

## Fix shapes

### A module imports a whole registry to use one entry

The first cut, and the most common shape near the top of the list. A registry maps keys to
implementations, so it imports every implementation. A module that reads one key from it reaches all
of them, and when any of those reaches back to the module, the registry closes a cycle.

Fix: give the entry its own module and import that. Then delete registry entries nothing reads.

Worked example: `src/components/Dialog/dialog-registry2.ts` held 23 `dynamic()` dialogs. Three
were opened, each from one component. Each opener now names only its own modal:

```ts
openDialog(
  () => import('~/components/Buzz/CryptoDeposit/BulkBonusInfoModal'),
  {},
  { id: 'bulk-bonus-info' }
);
```

The registry was deleted, along with one modal that only the registry had imported. The 164-module
client cycle split into three much smaller ones. New dialogs open with `openDialog`
(`src/components/Dialog/openDialog.ts`), so an opener names only the modal it opens and needs no
shared registry: see `.claude/rules/components.md`.

Before deleting a registry, check two things. Nothing may look an entry up by a key computed at
runtime: grep for the registry's export, not only its file name. And when an entry goes, check
that its target is still imported somewhere; if not, delete it too.

A barrel is the same shape. The `~/libs/form` barrel built every form input, the rich-text and
cosmetic inputs among them, so `SendTipModal`, which needs three plain inputs, reached the editor
and the cosmetic picker, and they reached the modal back. The plain inputs moved to
`~/libs/form/basic-inputs.ts`, which the barrel re-exports, and the modal imports that and the
`Form`/`useForm` modules directly. The 24-module client cycle split into three small ones, and 11
of its modules left cycles entirely.

### A shared piece lives in a big service

Module A imports service B for one function or constant, and B (through anything) imports A. Move
the piece into a new module that imports neither A nor B, and point both at it. Name the new module
for what the piece does, not for the service it came out of. A type-only import (`import type`) is
not an edge and needs no move.

Example: `rewards/base.reward` imported `buzz.service` for three functions. Those three, with the
multiplier helpers beside them, moved to `buzz-payout`, and the Buzz client they wrap to
`buzz-client`; `buzz.service` re-exports both, so its other callers are unchanged. Only
`base.reward` and the tests that stubbed Buzz for its payouts point at the new module: a
`buzz.service` mock no longer stands in for what `base.reward` calls. Move the pieces into one
module per caller, so each of those tests replaces its one mock with one mock and the own-module
mock ratchet does not grow.

The same move works the other way round: a widely imported service holding one function with a
heavy import. Example: `notification.service`, which most notification senders import, held
`getUserNotifications`, the one function that needs the notification detail fetchers. It moved to
`notification-feed.service`, which only the notification controller imports.

### A low-level module calls up

A shared module (a notification sender, a scan pipeline, an event hook) imports the
higher-level modules it hands work to. Two fixes, in order of preference:

1. The caller passes what is needed (the adapter, a callback), so the low-level module imports
   nothing above it.
2. The higher-level modules register themselves at an entry point (a route, a job, a
   startup module), and the low-level module reads the registration.

Example of the first: `home-block-cache.service` is imported by every writer that busts a home
block, and its read-through getter lazily imported `home-block.service` to build a missing block,
which handed every one of those writers that service's imports. The getter's only caller is
`home-block.service`, so it now passes its two builders in (`getHomeBlockCached(…, source)`), and
the cache imports the service for types only.

Example of the second: `utils/notifications.tsx` (which the tRPC client imports) rendered the
"Report this" button, which queries tRPC. `_app` registers the button with
`registerReportProblemButton`. Registration fits here because a missing registration costs only an
optional button (and its longer toast timeout); it fits badly where skipping the registered work
would lose data.

An uncut example that neither fix covers yet: `text-scan/submit.ts` reaches `moderation-adapters.ts`
through a call-site `await import()`, to apply a cleared verdict when text shrinks below the scan
minimum. The main callers of `scanEntity` (the post, bounty, collection and model services, and
text-scan's own retry adapter and route) are modules the adapters import, so they cannot pass the
adapter in, and a registration would skip the apply in any process that never loaded the registry.
Its fix needs a decision first (see "Ask first when").

## After each cut

1. Re-run `scripts/import-cycles.ts` and put the before and after numbers in the PR: modules in
   cycles, cycle sizes, page and API reach.
2. Lower the caps in `no-import-cycle-growth.test.ts` and, if that cycle shrank,
   `no-image-service-import-cycle.test.ts`. Both fail until you do.
3. Run both guards: `pnpm exec vitest run --project 'unit*' src/server/services/__tests__/no-import-cycle-growth.test.ts src/server/services/__tests__/no-image-service-import-cycle.test.ts`.
4. Where a module's import moved, update the tests that `vi.mock` it.

## Ask first when

- The fix needs a new registration mechanism, or changes the order in which modules run at startup
  (side-effect imports, top-level registration).
- A function moves from one entity's service to another's, so ownership changes.
- The top-ranked cut does not fit any shape above. Add the new shape here once it is agreed.
