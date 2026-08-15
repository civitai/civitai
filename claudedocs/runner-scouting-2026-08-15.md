# Is vitest the right runner? Scouting Bun and node:test

Recorded 2026-08-15. Measurement and a recommendation; no migration was attempted.

**Recommendation: stay on vitest — but the reason overturns the cost model we had been optimising
against.** The per-module constant is *not* inherent to our module graph. On files all three runtimes
can load, a runner without vite-node loads the same graph ~1600x faster.

## The measurement

Same first-party module graph, fresh process per measurement, warm FS cache:

| target (static closure) | vitest `collect` | bun | node + tsx |
|---|---|---|---|
| `model-substitution` (84 modules) | **5298 ms** | 3.3 ms | 8.5 ms |
| `challenge.constants` | — | 4.0 ms | 10.4 ms |
| `placement` | — | 3.7 ms | 122.7 ms |
| `image.schema` | — | 68.6 ms | 514 ms |
| `utils/metadata/audit` | — | 162.6 ms | 1755 ms |

🔴 **A per-module ratio published here earlier is RETRACTED.** It divided `collect` by
`inventory.json`'s static module counts, and that artifact was later found wrong by up to 75x and
selectively so — it followed lazy `dynamic(() => import())` edges that never execute and ignored
`vi.mock` factories. Four files reported ~1,810 modules and actually load 13–26; the honest suite
union is 1,321, not 3,230. Any figure of the form `ms per module` computed before that rebuild is
unusable, mine included.

What replaces it: vitest's per-module constant against the honest graph is **~43.6 ms** (aidan's
refit, from 15). No counterpart is quoted for bun, because its denominator came from the same broken
artifact. The per-file wall clock above needs no denominator and is the load-bearing number.

**So the cost is the module runner, not the modules.** That is consistent with the tracer result from
this morning — 569 module *bodies* executing in ~0.4 s against a 25.4 s import phase — and it locates
the missing time in vite-node's per-module fetch/instantiate, not in compile-and-evaluate as we had
been assuming. The two hypotheses make the same prediction for pool choice, which is why swapping
pools did not distinguish them; a different runtime does.

⚠️ **Read the limits before quoting any of it.** These probes import one graph in one process, with no
test framework, no mock interception, and no isolation between files. vitest's `collect` includes the
setup file, the mock machinery, and a fresh registry per test file. The gap is real but it is not
apples to apples, and nothing here shows bun *running our tests* faster — only loading our modules
faster.

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
so a bare import throws `Invalid environment variables` under bun *and* node. Satisfying it with a
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
two-project split's *existence* is runner-independent. A cheaper runner could change the size of the
residue, not remove it.

## Recommendation

**Stay on vitest.** The measured win is real but unrealisable: it exists on the stratum bun can load,
bun cannot load the stratum where the time actually is, and the crossing cost is a rewrite of 3,883
mock sites plus six pieces of first-party tooling.

**But retarget the optimisation.** The finding is that per-module cost is vite-node overhead rather
than the graph, which says:

- shrinking the graph (fewer modules per worker) attacks a term whose real work is a fraction of a
  millisecond per module — the leverage is in how many times vite-node *instantiates* a module, not in
  how many modules exist;
- `isolate: false` is the only lever that removes instantiations rather than reducing their count,
  which is consistent with it being the largest measured effect all day (collect 4565 s → 280 s);
- it is worth asking upstream-shaped questions — whether vitest can cache instantiated modules across
  files within a worker — before assuming the ceiling is where we put it.

**What would change this recommendation:** bun resolving the `use-sidecar` class of package-exports
failure, plus a mechanical `vi.mock` → `mock.module` codemod with the same refusal discipline as the
canonical-mock one. Both are plausible; neither exists today.
