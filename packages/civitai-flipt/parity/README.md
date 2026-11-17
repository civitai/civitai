# Node <-> Go Flipt parity

Node evaluates flags in-process with `@flipt-io/flipt-client-js` (a wasm build of Flipt's Rust
engine). The Go services are to adopt `go.flipt.io/flipt-client` (the same engine, run by wazero, no
CGO). Percentage rollouts hash the entity id inside the engine, so the two only agree when they
run the same engine source. This directory checks that, before either side is upgraded.

| File                      | What                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `snapshot.json`           | The fixture flag state, in the body format of Flipt's `GET /internal/v1/evaluation/snapshot/namespace/default`, which both clients load. Boolean thresholds, variant distributions, segments on every context key Node sends, disabled flags, flags with no rules. |
| `expected.json`           | GENERATED. The corpus (flag, entity id, context) and the result the pinned Node client gives for each case, plus the client pair it was recorded for.                                                                                                              |
| `latest-divergences.json` | GENERATED. The cases on which the newest JS and Go clients differ from `expected.json`, and what they answer instead.                                                                                                                                              |
| `evaluate.mjs`            | How a JS client's response is reduced for comparison (`go/parity_test.go` reduces Go's the same way).                                                                                                                                                              |
| `js-client-check.mjs`     | Checks any installed JS client version against its record.                                                                                                                                                                                                         |
| `go/`                     | The Go test, its own module so no service depends on the Go client before it adopts it.                                                                                                                                                                            |

## The checks

- **Node** (`src/__tests__/parity.test.ts`, lint.yml `Package unit tests`): builds the corpus
  deterministically (seeded; contexts from the real `buildFliptContext`, plus raw contexts with
  missing keys and string edge cases such as `"True"`, `"1"`, `" true"`, `"0042"`, `"1e3"`; entity
  ids picked on both sides of every rollout bucket edge), evaluates it with the installed client and
  requires `expected.json` to equal the result exactly. Changing the Node client, the snapshot or
  the corpus without regenerating the file is red.
- **Go** (`go/`, feed-go.yml job `flipt-parity`): the pinned Go client must evaluate every case in
  `expected.json` to the recorded result, and must be the release `expected.json` names. Changing
  the Go client alone is red.
- **Newest clients** (same job): the newest Go and JS releases must each differ from
  `expected.json` on exactly the cases in `latest-divergences.json`, with exactly those results, so
  they agree with each other.

Regenerate `expected.json`:

```sh
FLIPT_PARITY_WRITE=1 pnpm --filter @civitai/flipt exec vitest run src/__tests__/parity.test.ts
```

Without Node locally: on a mismatch the Node test prints the regenerated file as gzip+base64
between `FLIPT-PARITY-EXPECTED-BEGIN` and `FLIPT-PARITY-EXPECTED-END` in the CI log
(`base64 -d | gunzip > expected.json`). Regenerate `latest-divergences.json` from the
`flipt-parity-latest-divergences` artifact of the `flipt-parity` job.

## Engine versions

Both SDKs are built in `flipt-io/flipt-client-sdks` from the `flipt-evaluation` crate at the tagged
commit (`package/wasm/sdks/*.go`), so the engine a release embeds is that crate's tree at its tag.
Tree hashes of `flipt-evaluation/` at each tag:

| Tree       | JS (`@flipt-io/flipt-client-js`) | Go (`go.flipt.io/flipt-client`) |
| ---------- | -------------------------------- | ------------------------------- |
| `4ca8443a` | 0.2.0 (pinned here)              | v1.0.0, v1.1.0, **v1.1.1**      |
| `2d6adeb1` | 0.3.0                            | v1.2.0, v1.3.0, v1.3.1          |
| `0b12f43d` | 0.7.0 (newest)                   | **v1.6.0** (newest)             |

So the pinned pair is JS 0.2.0 with Go v1.1.1 (the newest Go release on the same tree), and the
newest pair is JS 0.7.0 with Go v1.6.0.

Hashing, in both trees: a boolean threshold rollout matches when
`crc32(entityId + flagKey) % 100 < percentage`; a variant picks its distribution by
`crc32(flagKey + entityId) % 1000` against cumulative bucket edges. What changed between the two
trees is how those edges are built: the pinned one sums `trunc(rollout * 10)`, so a distribution
list whose tenths do not add up to exactly 1000 leaves the top buckets matching nothing; the newest
one normalises the rollouts to their sum, rounds each edge, and pins the last edge to 1000. The
reason reported for a disabled boolean flag with no rollouts also changed (`DEFAULT` to
`FLAG_DISABLED`).

Measured on this corpus (CI, 1678 cases): Go v1.1.1 returns the Node 0.2.0 result on every case.
Go v1.6.0 differs on 97, all listed in `latest-divergences.json`:

- `bool-disabled-no-rollouts`, 40 cases: same `enabled: false`, reason `DEFAULT` becomes
  `FLAG_DISABLED`.
- `variant-under-100` (30% + 20%), 48 cases: entities in buckets 500-999 matched nothing and now
  get `a` or `b`; some in 300-499 move from `b` to `a`.
- `variant-thirds` (33.33/33.33/33.34), 4 cases: bucket 999 matched nothing and now gets `three`;
  bucket 666 moves from `three` to `two`.
- `variant-uneven` (10.05/89.95), 5 cases: bucket 999 matched nothing and now gets `large`; bucket
  100 moves from `large` to `small`.

Boolean thresholds (including 33.3%), segment matching and the string edge cases, and distributions
whose tenths are exact (50/50, 12.5/37.5/50, 0/100) agree between the two trees on every case.

The JS SDK refuses an empty or whitespace-only `entityId` before the engine sees it; the Go SDK
does not. The corpus never sends one (Node always sends a user id or `anonymous`); a Go adapter has
to apply the same guard.
