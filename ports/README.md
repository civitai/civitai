# Node → Go ports

Some read endpoints of the Node app (Next.js + tRPC, `src/`) are being ported to Go services
(`apps/feed-go`, `apps/beacon-go`). [`manifest.json`](manifest.json) is the one list of them: which
endpoint, which Go service and handler, which flags route it, and where it is in its lifecycle.
[`manifest.schema.json`](manifest.schema.json) is its schema.

## Using it

- **Does my change touch a port?** `node scripts/ports/touched.mjs <file>...`, or
  `node scripts/ports/touched.mjs --base origin/main` for your branch. It prints the ports and the
  changed files that tie each one in.
- **It does.** Read the port's entry. If the change alters what the endpoint returns, change the
  Node entry and the Go handler (`goHandler`) in the same PR so both still answer the same, and
  update the Go service's golden fixtures where its README says so. The Go tests run in that
  service's own workflow.
- **A `@ported-to-go` comment** above a symbol in `src/` marks a port's Node entry. It is generated;
  do not edit or copy it.

## Fields

All hand-written: `id`, `kind` (`trpc` | `rest`), `service`, `metricEndpoint`, `status`, `routes`,
`nodeEntry` (`{ file, symbol }`; `symbol` is `default`, a top-level name, or `router.procedure`),
`goHandler`, `goRoots` (optional), `flags` (`shadow`, `transport`, `probe` Flipt keys, or null),
`holdout`, `soak`, `nodeDeletion`. The schema's `description`s say what each holds.

`metricEndpoint` is the value of the Go service's endpoint label on this port's metrics
(`feed_endpoint` on feed-go's series, `beacon_endpoint` on beacon-go's), so a port can be joined to
its parity series. The generator checks that it is one of the values the service's
`var Endpoints = []string{...}` names in its Go source, and that no two ports of a service share
one, so renaming a label in Go without updating the manifest fails CI.

After editing the manifest, run `node scripts/ports/generate.mjs` and commit what it changes. It
validates the manifest and rewrites the `@ported-to-go` markers; it never writes the manifest. It
parses source and type-checks nothing. It needs `pnpm install` (for `typescript` and `ajv`).

## Dependencies

A port's dependencies are computed from source each time they are needed, by `touched.mjs`, and
are not stored, so they cannot go stale:

- Node: repo files the Node entry reaches through runtime imports, followed from the entry symbol
  (not its whole file) and then file by file, resolved against the files git tracks. Type-only
  imports are skipped; a submodule counts as its path (its pin). These are wide: a feed endpoint
  reaches about 1,400 files, because the service layer imports widely, so many PRs touch the feed
  ports.
- Go: the service module's files in `go list -deps` of `goRoots` (default: the `goHandler`
  directories), listed for linux/amd64 without cgo, plus `goHandler`, `go.mod` and `go.sum`. This
  half needs Go on `PATH`.

## Lifecycle

| `status`        | Who answers                                                    | What else is true                                                                                                    |
| --------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `shadow`        | Node, always                                                   | Go recomputes a sample of requests and compares (`flags.shadow`).                                                    |
| `ramp`          | Go for a share of users (`flags.transport`), Node for the rest | Comparison continues.                                                                                                |
| `soak`          | Go for everyone but a Node holdout cohort (`holdout`, percent) | The holdout keeps shadow-comparing; `soak.startedAt` is set. Lasts at least 14 days.                                 |
| `node-fallback` | Go                                                             | The Node handler stays only as the fallback for shapes Go does not handle: no traffic share, no comparisons.         |
| `go-only`       | Go                                                             | The Node path is deleted (`nodeEntry: null`). Only once Go's fallback rate is about zero and a human has signed off. |

**Soak exit gate** (soak → node-fallback), all of:

1. 14 days in soak;
2. match rate ≥ 0.995 in every comparison category;
3. no open mismatch class;
4. the CI differential suite green;
5. fallback rate < 0.1%;
6. the human sign-off recorded in the manifest (`soak.signedOffBy`, `soak.signedOffAt`).

**Node deletion** (node-fallback → go-only) needs its own human sign-off, recorded separately in
`nodeDeletion` (`signedOffBy`, `signedOffAt`): signing off the soak does not sign off deleting the
Node path.

The generator enforces only what the repo can see: the fields each status needs (for example
`ramp` needs both the shadow and the transport flag; `soak` needs `holdout` and `soak.startedAt`;
`node-fallback` and `go-only` need the soak sign-off; `go-only` also needs `nodeDeletion`), that
`soak.signedOffAt` is at least 14 days after `startedAt`, and that no date is in the future (a JSON
Schema cannot compare with today, so this is a generator check, with one day of slack for
timezones). Items 2–5 are measured outside the repo and checked by the person signing off.

## CI

`.github/workflows/ports.yml`:

- `manifest` runs the generator's tests and `node scripts/ports/generate.mjs --check`, which fails
  when the manifest breaks the schema or the lifecycle checks, or when a marker is missing, stale,
  on the wrong symbol, on something that is not a port, or damaged.
- `touched` computes every port's dependencies at the PR head and at the merge base, maps the PR's
  changed files to ports, and writes them, with the files, to the job's step summary. It is
  report-only: it never fails on a touched port, nor on a dependency list it could not compute
  (those are listed in the summary).
