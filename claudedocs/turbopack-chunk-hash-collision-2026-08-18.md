# Turbopack "assets emitted to the same output path" — root cause and options

**Date:** 2026-08-18 · **Status:** diagnosed, not fixed · **Next:** 16.3.0 (`^16.3.0`)

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
   **Two blockers, both real:** it is broken on Next 16.3.0 (19 `__turbopack_context__.a is not
a function` PostCSS errors — run 3; fixed by 16.3.1, run 5), so it depends on the 16.3.1 bump
   landing first; and this flag was turned off deliberately because it costs ~+33% peak builder
   RSS against an enforced memory ceiling. That RSS cost has **not** been re-measured here and
   is the thing to check before flipping it.
2. **Re-file upstream with a public minimal reproduction.** The only route to an actual fix
   (a wider or configurable hash). The existing issue died on the missing-repro bot, so this is
   unblocked work, not a wait.
3. **Do nothing and retry failed builds** — this does not work, and is worth stating plainly so
   nobody spends time on it. The failure is deterministic per tree.

## Not verified

- The **+33% peak builder RSS** figure for option 1, against the enforced ceiling. Local peak RSS
  is dominated by the `--max_old_space_size` cap and measured ~5.6-5.7 GB for every run, so the
  local box cannot settle this. **This is the gate on option 1.**
- Whether output produced with `nestedAsyncChunking: true` is correct beyond compiling — the
  runs above were not exercised past the build.
- The absolute collision _rate_. A per-namespace birthday model over the measured chunk counts
  puts one build at roughly 1%, but distinct branches have been failing at a visibly higher rate
  than that. So either CI emits more chunks than this local build or the effective hash space is
  smaller than modelled. The _relative_ improvement in option 1 (quadratic in chunk count) does
  not depend on resolving this; any absolute rate quoted from the model does.
- Runs 4 and 5 exit non-zero after `Compiled successfully` on an unrelated local
  `Invalid environment variables` error. The compile phase — where the collision occurs — completed.
