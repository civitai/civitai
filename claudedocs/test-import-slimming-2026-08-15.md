# Unit-suite import slimming, 2026-08-15

Branch `perf/test-import-slimming`, based on `origin/main` @3863adcbb0.

The unit suite spends most of its worker time importing modules, not running tests. In the baseline
full run, `import` was 4,565s against 541s of `tests`. This branch cuts what the tests import.

## What was measured, and how

Three instruments, all under `scripts/test-perf/`:

- **`graph.mjs`** (pre-existing) — static first-party closure per test file.
- **`cuts.mjs`** — ranks import edges by how many modules leave the graph if the edge is cut. It
  builds a dominator tree: a node's subtree size is exactly what disappears when that node stops
  being reachable. `cuts <file>` roots it at one test; `union` roots it at a synthetic node over all
  1,065 unit tests, so the subtree size is what leaves the SUITE-WIDE union. `union-real` recomputes
  that honouring `vi.mock`.
- **`externals.mjs` / `ext-cost.mjs`** — which node_modules packages the suite reaches, how many test
  files reach each, and what each costs.

### Three corrections the static graph needs

A raw static graph over-counts the runtime cost by roughly 2.5x suite-wide, and by 4.3x on the one
file that was traced. Three separate reasons:

1. **`import()` is lazy.** `const X = dynamic(() => import('...'))` at module scope never runs, so
   the module behind it is never fetched. Following that edge is correct for a bundler question (a
   lazily-fetched chunk is still a compiled chunk — which is why `no-server-infra-in-app-graph`
   follows them deliberately) and wrong for a registry question. `cuts.mjs` skips them by default;
   `COUNT_DYNAMIC=1` restores the bundler view.
2. **A `vi.mock` factory without `importOriginal` cuts its whole subtree.** The mocked module and
   everything below it is never fetched.
3. **Externals are invisible to any vite-side instrument.** Vite does not transform an externalised
   dep, so a transform hook cannot see one — and by the table below they are a large share of the
   cost.

Union of first-party modules the suite actually builds, all three ways, at the head of this branch:

| view                                            | modules |
| ----------------------------------------------- | ------- |
| static, dynamic imports followed, mocks ignored | 3,317   |
| mocks honoured                                  | 2,237   |
| mocks honoured and `import()` treated as lazy   | 1,320   |

### Externals are paid per FILE

Every test file gets a fresh process under the forks pool with `isolate: true` — measured, not
assumed: four probe files at `--max-workers=1` report four distinct `process.pid`s. Node's module
cache is per process, so each file re-imports each external package cold.

Cost is therefore `cold import ms x files that reach it`, measured the way the suite pays it (one
`import()` in a brand-new node process). Top of the table as it stood before the fixes below:

| package             | files | cold ms |
| ------------------- | ----- | ------- |
| lodash-es           | 309   | 923     |
| googleapis          | 94    | 2592    |
| redis               | 198   | 910     |
| @tiptap/html        | 96    | 1497    |
| @axiomhq/axiom-node | 215   | 508     |
| @aws-sdk/client-s3  | 123   | 772     |
| instantsearch.js    | 103   | 676     |
| @tabler/icons-react | 135   | 499     |

The columns do not add up to a saving: the cold times overlap on shared transitive deps, so cutting
one package off a file that still reaches its dependencies another way refunds only part of it.

`@mantine/core` is the cautionary row — 2.5s cold, the most expensive single import in the suite, and
only 13 files reach it. Fan-in decides, not weight.

## What changed

Each of these is a module that mixed two audiences, so a consumer that wanted the cheap half was
paying for the expensive half.

| edge                                                                                                                                                                                                                 | fix                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~40 server modules imported `getEdgeUrl` from `~/client-utils/cf-images-utils`, which also defines `useEdgeUrl` — so they reached `useCurrentUser` -> the session provider -> the onboarding and buzz-purchase trees | import from `~/client-utils/edge-url`, where the pure builder already lived                                                                       |
| `server/schema/model-version.schema.ts` imported two donation-goal numbers from `components/Model/ModelVersions/model-version.utils` (a hooks module)                                                                | `shared/constants/donation-goal.constants.ts`; schema closure 605 -> 45 modules                                                                   |
| `server/schema/training.schema.ts` imported `blockedCustomModels` from `components/Training/Form/TrainingCommon`                                                                                                     | `shared/constants/training.constants.ts`; schema closure 607 -> 17 modules                                                                        |
| `server/services/post.service.ts` imported `isMadeOnSite`, a one-line delegate, from a generation-form util                                                                                                          | call `isImageMetaOnSite` in `server/utils/image-onsite` directly                                                                                  |
| `server/createContext.ts` held `publicApiContext2`, the only thing in it needing `appRouter` — putting the entire tRPC router in the graph of everything importing the file                                          | split to `server/public-api-context.ts`                                                                                                           |
| `shared/constants/currency.constants.ts` embeds the icon COMPONENTS in `CurrencyConfig`, so its one non-component consumer dragged in `@tabler/icons-react`                                                          | colours/css/classNames to `currency-theme.constants.ts`; `currency.constants` re-attaches the icons on top, so the 92 UI call sites are untouched |
| `app-settings-bootstrap.test.ts` imported `~/pages/_app` to test `_app.getInitialProps`, loading the whole provider and layout tree                                                                                  | extracted to `~/utils/app-initial-props`; `_app.tsx` assigns it, so it still ships in both bundles and still runs on client navigations           |
| `utils/array-helpers.ts` imported `uniq` from `instantsearch.js/es/lib/utils` for a function that is one `.filter()`                                                                                                 | inlined, same first-index-wins semantics; 103 files -> 0                                                                                          |
| `collection.service.ts` imported the youtube client, and therefore `googleapis`, for one mod-only function                                                                                                           | moved `enableCollectionYoutubeSupport` to `collection-youtube.service.ts`; 94 files -> 1                                                          |

## Result

Full isolated run on this branch: **1,065 files, 16,784 tests, 16 failed / 6 files** — identical to
the baseline, and the 16 are the known Windows path-separator failures that are green on Linux CI.
`blocks.router.workflow.test.ts` collected, so nothing silently vanished.

Paired full runs on `main` and this branch, same reporter, same window:

```
  main (control)   collect 6232s   wall 279.4s   16 failed
  this branch      collect 4498s   wall 210.9s   16 failed
                   collect -27.8%  wall -24.5%
```

The 306 files this branch does not touch are flat at +0.4% across that pair, which is what licenses
the aggregate — both runs saw the same box.

A second, independent method agrees. Splitting an earlier pair by whether a file's static closure
changed rather than by whether its time moved, comparing the 412 test files whose closure these
commits changed against the 653 they did not, in the same two runs:

```
  CHANGED-graph files   n=412   collect 4843s -> 3778s   -22.0%
  UNCHANGED files       n=653   collect  633s ->  720s   +13.7%  (slower)
```

That pair was taken on a busier box: the untouched files got 13.7% slower, which is why its
whole-suite wall clock looked flat. Against that headwind the touched files still dropped 22%.

### Do not read a null from the 90-file yardstick as a null

`bench.mjs` runs a fixed 90-file subset so an edit->measure loop does not need the whole box. Two
batches of the work above measured flat on it and were real in the full run — the subset simply did
not contain the files they moved. A subset can also destroy the condition that produces the cost
outright rather than merely diluting it: the component project's ~21s startup charge scales with how
many files the run matches, because `@vitest/browser` seeds `optimizeDeps.entries` from every matched
file, so a 13-file probe measured no charge at all. The subset's job is to be stable, not to be
representative of every change; a null on it means "not visible here", not "not there".

Individual movers map onto the edges: `app-settings-bootstrap` 24.7s -> 0.9s, `og-image-helpers`
12.9s -> 0.4s, `contest-entry-base-model-gate` 17.1s -> 3.8s.

The -1,065s on the changed files is what the externals table has to fit inside, and it does: the two
externals cuts predict ~314s on their own. Checking a per-file model against the whole-suite total
instead is what makes it look absent — the total was moving under the control group's headwind at the
same time.

Sum of static first-party closures across the suite went 462,497 -> 272,224 modules and files with a
closure over 1,000 modules went 371 -> 10, but read those as an upper bound on the runtime effect
for the three reasons above: a static edge that never executed costs the suite nothing.

## Measured and rejected: hoisting the `block-registry` in-body imports

Twelve test files `await import('../block-registry.service')` inside their test bodies, and they were
3.6-4.5s each in a full run. An in-body import bills the module graph to `duration` rather than
`collect`, so a collect-ranked instrument cannot see them at all — a real blind spot in every ranking
used here.

Hoisting them is safe: none of the thirteen files calls `vi.resetModules` or `vi.doMock` or mutates
env, `vi.mock` factories are hoisted above imports either way, and the service's only module-scope
state is a `null` cache initialiser. But it does not pay. Hoisting the worst of them
(`block-registry.resolve-instance`, 27 in-body imports), single file on a quiet box:

```
                collect     duration    collect+duration    wall
  in-body          52ms       2296ms             2348ms     2.7s
  hoisted        2225ms          9ms             2234ms     2.7s
  hoisted (2)    2408ms         14ms             2422ms     3.1s
```

The load moves wholesale from `duration` to `collect` and the total does not, with the two hoisted
totals straddling the in-body one. An in-body import does the same work at a different time.

The cost that is real is one 3,805-line module with a 99-module closure, loaded once per file in
thirteen separate processes — and `isolate: false` removes it for nothing, since a worker builds one
registry for all its files. The 3.6-4.5s figures were a saturated box; quiet, the whole file is 2.7s.

## Not done

- **`@aws-sdk/*` through `image.service`** (~123 files). `image.service.ts` is 8k lines and genuinely
  uses S3; separating them is a real refactor, not an accidental edge.
- **`@tiptap/html` through `article.service`** (96 files, 1.5s cold). Used in one line, and
  `collection.service -> article.service` is legitimate. The available cuts are a lazy `await
import()` — which moves a 1.2s load onto the first article render in production — or splitting
  `getArticleById`. Not a trade worth making for test time.
- **`lodash-es`** (309 files). `lodash-es/chunk.js` is 22ms against 923ms for the barrel, so
  per-symbol imports would pay well, but it is hundreds of import statements across files other work
  is touching.
- **Pre-bundling the SSR deps** (`server.deps.optimizer.ssr`) would take lodash-es, tiptap, aws-sdk
  and tabler in one config change with no source churn. The thing to check first is whether
  pre-bundling breaks `vi.mock` of an external.
