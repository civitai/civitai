# Is vitest the right runner? Scouting Bun and node:test

**Status (added 2026-08-21):** Recommendation unchanged — stay on vitest. The measurement was single-shot and not re-run; the ~20x ratio on the like-for-like file is a point estimate.

Recorded 2026-08-15. Measurement and a recommendation; no migration was attempted, and no box time
was used — every probe is a single-process module import, not a suite run.

> **Two corrections were made to this document after first publication, and both are stated in place
> below rather than silently edited out.** (1) A per-module ratio derived from `inventory.json`'s
> static counts is retracted; that artifact over-counted by up to 75x, selectively. (2) The headline
> comparison was not like-for-like — it set vitest's `collect` for a _test file_ against a probe
> importing only the _source module_ beneath it, which is a smaller graph. The gap was overstated as
> ~1600x; it is ~20x. **The recommendation did not change under either correction.**

**Recommendation: stay on vitest — but the reason overturns the cost model we had been optimising
against.** The per-module constant is _not_ inherent to our module graph. On the one file all three
runtimes can load, bun loads the same 82-module closure ~15-20x faster than vitest's `collect`.

## The measurement

**The like-for-like row is the test file, not the source module.** vitest's `collect` loads the
whole test-file closure — the file, its imports, and `vitest` itself. An early version of this doc
compared that against a probe importing only the _source_ module underneath it, which is a different
and much smaller graph. Corrected:

| target                       | real closure | vitest `collect` | bun                               | node + tsx                         |
| ---------------------------- | ------------ | ---------------- | --------------------------------- | ---------------------------------- |
| `model-substitution.test.ts` | 82 modules   | **5298 ms**      | **259 ms** (median of 5: 250–262) | ✗ cannot import `vitest` under CJS |

So **~20x on the one file all three could be asked to load**, not the three orders of magnitude an
earlier draft claimed.

Source-module-only probes, which are _not_ comparable to `collect` and are kept only to show the
runtimes' floor:

| source module             | bun      | node + tsx |
| ------------------------- | -------- | ---------- |
| `model-substitution.ts`   | 3.3 ms   | 8.5 ms     |
| `challenge.constants.ts`  | 4.0 ms   | 10.4 ms    |
| `placement.ts`            | 3.7 ms   | 122.7 ms   |
| `image.schema.ts`         | 68.6 ms  | 514 ms     |
| `utils/metadata/audit.ts` | 162.6 ms | 1755 ms    |

🔴 **A per-module ratio published here earlier is RETRACTED.** It divided `collect` by
`inventory.json`'s static module counts, and that artifact was later found wrong by up to 75x and
selectively so — it followed lazy `dynamic(() => import())` edges that never execute and ignored
`vi.mock` factories. Four files reported ~1,810 modules and actually load 13–26; the honest suite
union is 1,321, not 3,230. Any figure of the form `ms per module` computed before that rebuild is
unusable, mine included.

Refit against aidan's honest `closures.json` (`mode: 'real'`), joined to the `pre-ctl` full run:

```
  1065 files, 104,797 real module-instances, collect 4729 s
  vitest   45.1 ms per module-instance      (agrees with aidan's independent 43.6)
  bun       3.2 ms per module-instance      (82-module closure in 259 ms)
```

~14x per module, on the one file both can load — consistent with the per-file figure above, as it
must be.

**The 45.1 is worth more than the comparison it was computed for.** aidan refit the same constant
independently, from a different artifact by a different route, and got **43.6**. Two wrong
denominators would not have agreed, so the pair is the only independent confirmation the honest graph
has — and everything downstream that divides by a module count rests on it.

**What both of this document's errors had in common**, since the pattern generalises past this
question: each was a denominator error, and each produced a number that was right about the thing it
measured and wrong about what that thing was. The second was catchable alone by asking what `collect`
actually includes before dividing by anything. It is easy to check that two _runtimes_ are comparable
and forget to check that the two _quantities_ are.

**So the cost is the module runner, not the modules.** That is consistent with the tracer result from
this morning — 569 module _bodies_ executing in ~0.4 s against a 25.4 s import phase — and it locates
the missing time in vite-node's per-module fetch/instantiate, not in compile-and-evaluate as we had
been assuming. The two hypotheses make the same prediction for pool choice, which is why swapping
pools did not distinguish them; a different runtime does.

⚠️ **Read the limits before quoting any of it.** These probes import one graph in one process, with no
test framework, no mock interception, and no isolation between files. vitest's `collect` includes the
setup file, the mock machinery, and a fresh registry per test file. The gap is real but it is not
apples to apples, and nothing here shows bun _running our tests_ faster — only loading our modules
faster. `node + tsx` could not even import a test file: `Vitest cannot be imported in a CommonJS
module using require()`.

## What breaks, concretely

**Bun cannot load our heavy graphs at all.** Every module reaching the React/Next side dies resolving
a dependency's package exports:

```
error: ... node_modules/use-sidecar@1.1.3/node_modules/use-sidecar/package.json:41:5
```

`blocks.router` and `cosmetic-phash.service` both fail this way. So the table above is measured on the
**light stratum only** — 383 of 1065 files have no infra dependency. That is exactly the
flattering-slice trap: the runner whose win is startup was measured only where startup dominates.
⚠️ The stratum sizes came from the same retracted artifact, so treat them as indicative; "bun cannot
load these files" is a hard failure observed directly and does not rest on a count.

**Module-scope env aborts the import under every runtime.** `~/env/server` validates at module scope,
so a bare import throws `Invalid environment variables` under bun _and_ node. Satisfying it with a
synthesised env got past the gate; `cache-helpers` then **hung past 300 s** under bun, which looks
like a module-scope client construction that never settles. Not diagnosed further.

**The mock surface is the wall.** From the analyser, not a regex:

```
1053 of 1065 files import from 'vitest'
 651 files carry vi.mock, 3883 sites (3461 partial)
8053 vi.fn   3946 vi.mock   650 vi.hoisted   472 vi.clearAllMocks
 101 vi.mocked   93 vi.stubGlobal   67 vi.resetModules   65 vi.spyOn
  58 vi.setSystemTime   47 vi.useFakeTimers   47 vi.importActual
```

Bun's `mock.module` is a different API with different hoisting semantics; node:test's module mocking
is still flagged experimental. A switch is not a config change — it is a rewrite of the mocking layer
of essentially every test file in the repo.

**And the tooling is vitest-shaped**: the canonical mock system and its guard, the allowlist ratchet,
`reporter.mjs`, the dashboard, the dev-server test queue and the two-project pool split all bind to
vitest APIs or its reporter contract. None of that is wall-clock, and all of it would be rebuilt.

**One thing a switch would NOT fix.** `IS_BUILD` / `IS_DATAPACKET` are read at module scope and set
both ways by different tests. Any runner that shares a process between files has that limit, so the
two-project split's _existence_ is runner-independent. A cheaper runner could change the size of the
residue, not remove it.

## Recommendation

**Stay on vitest.** The measured win is real but unrealisable: it exists on the stratum bun can load,
bun cannot load the stratum where the time actually is, and the crossing cost is a rewrite of 3,883
mock sites plus six pieces of first-party tooling.

**But retarget the optimisation.** The finding is that per-module cost is vite-node overhead rather
than the graph, which says:

- shrinking the graph (fewer modules per worker) attacks a term whose real work is a fraction of a
  millisecond per module — the leverage is in how many times vite-node _instantiates_ a module, not in
  how many modules exist;
- `isolate: false` is the only lever that removes instantiations rather than reducing their count,
  which is consistent with it being the largest measured effect all day (collect 4565 s → 280 s);
- it is worth asking upstream-shaped questions — whether vitest can cache instantiated modules across
  files within a worker — before assuming the ceiling is where we put it.

**What would change this recommendation:** bun resolving the `use-sidecar` class of package-exports
failure, plus a mechanical `vi.mock` → `mock.module` codemod with the same refusal discipline as the
canonical-mock one. Both are plausible; neither exists today.
