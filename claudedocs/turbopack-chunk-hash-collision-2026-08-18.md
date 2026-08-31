# Turbopack "assets emitted to the same output path" — root cause and options

**Date:** 2026-08-18 · **Status (updated 2026-08-30):** diagnosed, not fixed — and **option 1 is now closed, measured, at `ebb84fffd6`**. Repo is on `^16.3.1`; the doc's "Next: 16.3.0" was a forward-looking expectation, not the current version. 16.3.1 re-rolls the collision but does not fix the mechanism (see §Next 16.3.1 is a re-roll, not a fix). The peak-RSS gate on option 1 was the one thing this doc left open; it has since been measured on 16.3.1 and **the flag does not fit the builder's memory ceiling** (see §Option 1 is closed).

## Symptom

The image build fails in `pnpm run build` (`next build`, Turbopack) at the `RUN` step in
`Dockerfile` that runs the production build:

```
Error: Turbopack build failed with 2 errors:
[output]/.next/server/chunks/ssr/[root-of-the-server]__0gduaxh._.js
Error: Two or more assets with different content were emitted to the same output path
file content differs, written to:
  [output]/.next/abf442f9b482f9c2.js
  [output]/.next/5e217de9956f5326.js
```

### Read this error carefully — it is easy to misread

Two things trip people up:

1. **The two hashed files at the bottom are NOT the collision.** They are debug dumps
   Turbopack writes so you can diff the two differing contents. The colliding output path is
   the line _above_ the `Error:` — here `[root-of-the-server]__0gduaxh._.js`. A report that
   says "two `.map` files collided" has read the dump filenames.
2. **"2 errors" is one collision, not two.** The chunk and its sibling source map are
   reported separately, so a single colliding chunk yields two errors (`.js` and `.js.map`)
   whenever source maps are on (they are — `productionBrowserSourceMaps: true`).

## Root cause

An upstream Turbopack defect: a **birthday collision in the 7-character server chunk-name
hash**. Turbopack names server chunks `<namespace>_<hash>._.js`. Measured over the emitted
chunks of one build in this repo:

| Measurement           | Value                                   |
| --------------------- | --------------------------------------- |
| Server chunks emitted | 24,552                                  |
| Hash width            | 7 chars for 21,543 of them              |
| Hash alphabet         | 38 (`0-9 a-z - _`)                      |
| First hash char       | `0` 43.7%, `1` 43.2%, `2` 1.9%          |
| Largest namespace     | `[root-of-the-server]_` — 11,730 chunks |

Because the first character is bounded in practice to `{0,1,2}`, the usable space is
about `2 x 38^6` ≈ 6.0e9, roughly **5% of the nominal `38^7`**. At ~11.7k chunks in a single
namespace that is an ordinary birthday problem, and the two colliding chunks are unrelated to
each other — here a 14,266-byte chunk and a 17,606-byte chunk with disjoint module sets, both
mapped to `[root-of-the-server]__0gduaxh._.js`.

Consequences that explain everything observed:

- **Deterministic for a given module graph.** The same commit fails again on rebuild. Retrying
  a failed build, or pushing an empty commit, cannot clear it.
- **Moves to a different pair whenever the graph changes at all.** So bisecting finds a commit
  but never a responsible _file_, and reverting an unrelated file "fixes" it by perturbing the
  graph. It is not caused by whatever code was last touched.
- **Hits a subset of branches, uncorrelated with staleness** — it depends only on whether that
  branch's particular graph happens to contain a colliding pair.

Upstream report: [vercel/next.js#96976](https://github.com/vercel/next.js/issues/96976).
It was **auto-closed by a bot for a missing public reproduction link, never triaged**, so there
is no upstream fix and no release to bump to. Its measurements are independently reproduced
above.

## The discriminating experiment

The rival hypothesis was a **shared build-cache collision**: the build step mounts a shared
cache (`--mount=type=cache,target=/app/.next/cache`) and builds for different branches can
overlap, so two builds might write colliding output into one cache. That predicts the failure
needs concurrency and a warm shared cache; the hash-collision hypothesis predicts the failure
is deterministic in isolation.

**Experiment:** build the exact failing tree locally — no Docker, no BuildKit, no cache mount,
no concurrent build, `rm -rf .next` first, so a shared cache and overlapping writers are
structurally absent.

**Result: it failed, twice, identically** — same collision path, same chunk count, same 2
errors. This is a reliable reproduction, so the shared-cache hypothesis is refuted rather than
merely unsupported: the failure occurs with the cache and the concurrency removed.

Two further points that independently disfavour the cache hypothesis:

- The cache mount targets `.next/cache`, a strict _subdirectory_ of the output dir, while the
  colliding assets are emitted to `.next/server/chunks/...`, outside it.
- Turbopack's build filesystem cache is already disabled here
  (`experimental.turbopackFileSystemCacheForBuild: false`).

### Results

All runs on the same tree, cold `.next`, one build at a time:

| #   | Configuration                            | Collision errors | Compiled                   | Server chunks |
| --- | ---------------------------------------- | ---------------- | -------------------------- | ------------- |
| 1   | Next 16.3.0, config as-is (baseline)     | 2                | no                         | 24,551        |
| 2   | Next 16.3.0, config as-is (repeat)       | 2                | no                         | 24,551        |
| 3   | Next 16.3.0, `nestedAsyncChunking: true` | 0                | **no** — 19 PostCSS errors | 7,116         |
| 4   | Next 16.3.1, config as-is                | 0                | yes                        | 24,552        |
| 5   | Next 16.3.1, `nestedAsyncChunking: true` | 0                | yes                        | **7,122**     |

## Next 16.3.1 is a re-roll, not a fix

Run 4 is green, and that is **not** evidence that 16.3.1 fixes this. On 16.3.1 the mechanism is
measurably unchanged: hash still 7 characters (21,543 of 24,552), first character still bounded
(`0` 43.7% / `1` 43.2% / `2` 1.9%), largest namespace still ~11.7k, total chunk count essentially
identical (24,552 vs 24,551). Nothing that determines the collision probability moved.

What changed is the _contents_ of the graph, which re-rolls which pairs collide — exactly the
"perturb the graph and it goes away" behaviour the upstream report describes. So the bump
unblocks the branches failing today and leaves the failure rate where it was.

This matters because Next 16.3.1 is already being landed for unrelated reasons
(civitai#4075). When the current failures stop, the cause will look like that bump. It is
not, and the failures will return.

## Options

1. **Cut the server chunk count — the only lever here that attacks the mechanism.**
   `experimental.turbopackServerSideNestedAsyncChunking: true` takes the tree above from 24,552
   to 7,122 server chunks (-71%). Since P(collision) grows with the square of the chunk count,
   that is roughly a 9x reduction in expected collisions.
   **Two blockers were named here. The first cleared; the second closed the option.** It is
   broken on Next 16.3.0 (19 `__turbopack_context__.a is not a function` PostCSS errors — run 3;
   fixed by 16.3.1, run 5), so it depended on the 16.3.1 bump landing first — that landed in
   civitai#4075 and the repo is on 16.3.1. The second blocker was the peak builder RSS this flag
   costs against an enforced memory ceiling. **That has now been measured on 16.3.1 and it does
   not fit.** See §Option 1 is closed. 🔴 **Do not flip this flag.**
2. **Re-file upstream with a public minimal reproduction.** The only route to an actual fix
   (a wider or configurable hash). The existing issue died on the missing-repro bot, so this is
   unblocked work, not a wait.
3. **Do nothing and retry failed builds** — this does not work, and is worth stating plainly so
   nobody spends time on it. The failure is deterministic per tree.

## Option 1 is closed — the flag does not fit the memory ceiling

_Added 2026-08-30. This section supersedes the "not verified" peak-RSS bullet below._

The gate on option 1 was: does the flag's peak builder RSS fit under the enforced 40 GiB build
container limit? **It does not.** Three independent lines of evidence agree, and two of them
already existed in this repo when the doc above was written:

1. **Production evidence, in this repo's own history.** civitai#3458 (`0801071370`, 2026-07-30)
   enabled this flag. civitai#3807 (`c771513011`, 2026-08-11) turned it back off, and says why:
   _"the release build OOMKilled three times at 37-39 GiB"_ against the newly-enforced 40 GiB
   builder limit. So the flag had already been tried in production and had already failed. The
   only open question was whether 16.3.1 changed that.

2. **A same-commit A/B on Next 16.3.1** (2026-08-18, cold `.next`, every arm a complete `rc=0`
   build, two runs per arm, sampled externally at 4 Hz). It does not change it — the cost is
   **larger** than the ~+33% previously on record:

   | metric                | base (mean of 2) | `serverchunk` (mean of 2) |          Δ |
   | --------------------- | ---------------: | ------------------------: | ---------: |
   | `next-build` max RSS  |        15.53 GiB |                 22.20 GiB | **+43.0%** |
   | build-container peak  |        22.18 GiB |                 28.91 GiB | **+30.3%** |
   | server chunks (`.js`) |           24,596 |                 **7,177** | **−70.8%** |
   | server chunk bytes    |      530,006,443 |               297,943,127 |     −43.8% |
   | wall                  |            155 s |                     218 s |     +41.0% |

   Baseline spread was 1.4% and the `serverchunk` spread 0.5%, so the +43% effect is ~30x the
   noise floor; the two baseline runs emitted byte-identical output, which is an independent
   determinism control. The −70.8% chunk reduction reproduces this doc's run 5 and is real:
   `(7177/24596)² = 0.085`, i.e. **~11.7x fewer expected collisions**. The benefit is not in
   doubt. The cost is what closes the option.

3. **The current builder distribution, re-measured 2026-08-30** over the trailing 7 days
   (n=67 `main` builds): median **24.11 GiB**, p90 **27.72 GiB**, worst observed **28.59 GiB**
   against the 40 GiB limit. Applying the measured multiplier to the worst observed build puts
   it at **37.3–39.8 GiB** — inside the 37–39 GiB band in which the release build was OOMKilled
   three times the last time this flag was on. There is no headroom to spend.

**Also closed: dropping source maps to pay for it.** Combining the flag with
`turbopackSourceMaps: false` keeps the full −70.8% chunk reduction for roughly the noise floor
of build memory, which looks like the way out. It is not: server `.js.map` files have three
consumers in this repo, one of them a hard gate.

- `scripts/assert-compiled-branches.mjs` — a hard CI gate (made hard by civitai#4075) that
  errors out when it finds no `.js.map` under the server dir.
- `src/server/utils/errorHandling.ts` — de-minifies production server error stacks at runtime.
- `scripts/resolve-cpuprofile.mjs` — the CPU-profile de-minification path.

And the knob cannot be split: under Turbopack `experimental.serverSourceMaps` is inert
(webpack-only, per the rationale at `next.config.mjs:133-139`), so `turbopackSourceMaps` is a
single switch covering client _and_ server. There is no "keep server maps, drop the memory"
setting.

**What is left**, therefore, is option 2 (file the hash-space defect upstream — the only real
fix) plus containment: exempt this error signature from build retry, since the collision is
deterministic per tree and a retry burns a second and third full build to fail identically.

**Not the nearest risk.** Builds today sit at a worst observed 28.59 GiB against 40 GiB with the
flag off, and the module graph grows every week. Ordinary graph growth reaching the ceiling will
bite before the collision does.

## Not verified

- Whether output produced with `nestedAsyncChunking: true` is correct beyond compiling. Still
  **not** exercised — not by the runs above, not by the 08-18 A/B (which asserted `rc=0` full
  builds, i.e. compile + page data + static generation, but never ran the emitted server), and
  not by the 2026-08-30 review that closed option 1. Since the flag is not being enabled, this
  never became load-bearing; it would have to be answered before any future attempt.
- The absolute collision _rate_. A per-namespace birthday model over the measured chunk counts
  puts one build at roughly 1%, but distinct branches have been failing at a visibly higher rate
  than that. So either CI emits more chunks than this local build or the effective hash space is
  smaller than modelled. The _relative_ improvement in option 1 (quadratic in chunk count) does
  not depend on resolving this; any absolute rate quoted from the model does.
- Runs 4 and 5 exit non-zero after `Compiled successfully` on an unrelated local
  `Invalid environment variables` error. The compile phase — where the collision occurs — completed.
