# Schema ↔ database drift detector

Parses `packages/civitai-db-schema/prisma/schema.full.prisma`, reads a live database's
`pg_catalog`, and reports every constraint the schema **declares but the database does not
enforce** — and every one the database enforces differently from what the schema promises.

The schema is not the database. Migrations in this project are applied by hand, per
environment, so a declaration can be true in the schema file and absent in the database for
a long time without anything noticing. This tool makes that gap countable.

## Run it

```bash
pnpm --filter @civitai/db-schema drift             # text report
pnpm --filter @civitai/db-schema drift --json      # machine-readable
pnpm --filter @civitai/db-schema drift --verbose   # + the list of skipped models
```

The connection comes from `DATABASE_URL` in the environment. Nothing about where a
database lives is baked into this tool, and nothing about it should be added.

**It is read-only.** Every statement is a `SELECT` against `pg_catalog`. It never writes,
never runs DDL, and never applies a migration.

Other flags:

| Flag                 | Effect                                                        |
| -------------------- | ------------------------------------------------------------- |
| `--schema <path>`    | Read a different Prisma schema                                |
| `--catalog <path>`   | Compare against a captured catalog JSON instead of connecting |
| `--dump-catalog`     | Capture the catalog as JSON and exit (pairs with `--catalog`) |
| `--db-schema <name>` | Postgres schema to introspect (default `public`)              |
| `--strict`           | Exit 1 when any drift is found. Default is always exit 0      |

`--strict` is opt-in on purpose. The database carries a real backlog of drift today, so a
gate that failed on any finding would be red on every run, and a permanently-red gate just
teaches everyone to click through it. Under `--strict` a referential action that could not
be compared also fails the run: "not measured" is not "clean".

**Exit 2 is not optional.** A comparison that visited nothing prints exactly the same clean
page as a healthy database — which is what a typo'd `--db-schema`, a wrong `DATABASE_URL`,
or a role without catalog visibility produces. The CLI checks its own coverage and exits 2
regardless of `--strict` rather than reporting a reassuring zero.

## What it checks

| Check                   | Schema side                                                | Database side                                                                   |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Foreign key present** | each owning-side `@relation(fields: […], references: […])` | a `pg_constraint` row with `contype = 'f'` on the same **ordered** column tuple |
| **Referential action**  | `onDelete` / `onUpdate`, explicit or defaulted             | `confdeltype` / `confupdtype`                                                   |
| **Column present**      | each scalar field                                          | a `pg_attribute` row on the table                                               |
| **Nullability**         | field optionality (`?`)                                    | `pg_attribute.attnotnull`                                                       |
| **Uniqueness**          | `@unique`, `@@unique`                                      | a `pg_index` row with `indisunique` and no `indpred`                            |

`@@map` / `@map` are resolved to the real table and column names throughout.

### Things worth knowing about how it decides

- **A present-but-wrong referential action is a defect class of its own.** The constraint
  exists, so nothing looks missing, but the database enforces a different rule from the one
  the schema promises. Both `ON DELETE` and `ON UPDATE` are compared.
- **Prisma's default `onDelete` is not `Cascade`.** An optional relation defaults to
  `SetNull`, a required one to `Restrict`. Reading a bare relation as a cascade
  mis-describes what a parent delete would actually do — on a required relation the truth
  is the opposite: the delete is _rejected_, not propagated.
- **`references:` is read, never assumed to be `id`.** Most relations in this schema do
  reference `id`, but several reference `projectId,position`, `serialId`, `userId`, `type`
  or `blockInstanceId`.
- **Both spellings of the relation name are accepted** — positional
  `@relation("X", fields: …)` and named-argument `@relation(name: "X", fields: …)`. Prisma
  takes both. Handling only the first was not a partial result: the six relations written
  the other way appeared in no counter and produced no finding, so the tool reported clean
  on foreign keys it had never looked at. Three of those six have no foreign key in
  production. The parser is now checked against an independently derived count of
  owning-side relations, because a floor (`> 400`) cannot see an undercount.
- **A declared column with no column in the table is its own finding**, not a nullability
  mismatch. A Prisma read touching one fails outright with "column does not exist".
- **Block attributes are read with comments stripped.** `@@map` / `@@ignore` / `@@unique`
  are matched against the model body, so a stray `// @@ignore` left behind by a revert
  would otherwise skip an entire model and every constraint on it, silently.
- **Models mapped to a view or to a table that does not exist are skipped**, along with
  models carrying `@@ignore`. They are counted and listed (`--verbose`), not reported as
  drift: there is no table for a constraint to live on.
- **Partial unique indexes do not count.** A `WHERE`-clause index enforces uniqueness only
  over the rows it matches; a `@unique` declaration is a promise about every row.
- **Expression indexes are dropped** rather than matched by name, so a `lower(email)` index
  cannot masquerade as an index on `email`.
- **Column aggregates are selected as `text[]`, not `name[]`.** `attname` is of type `name`,
  and node-postgres has no array parser registered for `name[]` — `array_agg(a.attname)`
  arrives in JavaScript as the literal string `"{projectId,position}"`. Nothing throws,
  `.length` still answers, and every column-tuple comparison silently becomes a comparison
  of characters. `assertParsedArray` rejects an unparsed list rather than returning a
  plausible-looking catalog.
- **A catalog read that answers uniformly is rejected**, loudly, before any comparison
  happens. `NOTNULL` is a reserved word in Postgres: `SELECT a.attnotnull notnull` parses as
  the _postfix_ `IS NOT NULL` operator and returns a constant `true` for every row. The
  query succeeds and every nullable column reads as `NOT NULL`. That fabricated 626
  one-directional findings before it was caught, so `assertCatalogSanity` now fails the run
  instead.

## What it does **not** check

Not implemented. Their absence from a report is **not** evidence that they are clean —
they are not audited at all:

- check constraints
- column defaults
- column types (including length, precision and `@db.*` native types)
- enum values and enum membership
- non-unique indexes, and index method/ordering
- **primary keys** — `@id` / `@@id`. The uniqueness check covers `@unique` and `@@unique`
  only. There are 105 `@@id` declarations in this schema and none of them is verified
- **programmability** — views, functions, triggers, rules. A deployed view can emit columns
  its committed definition does not, and nothing here would see it. Two live instances:
  `BountyRank_Live` emits five `commentCount` columns its committed definition does not, and
  `BountyEntryRank_Live` ten (`tipped*`, `tippedAmount*`). The first matters because the
  table rebuilds from the view every few minutes
- columns and tables present in the database but absent from the schema (the reverse
  direction _is_ checked)
- row-level security, partition bounds
- whether a foreign key's _referenced table_ matches the one the schema names (only the
  constrained column tuple is matched)

The text report ends with this list for the same reason.

## Layout

| File                     | Role                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| `parse-prisma-schema.ts` | Schema → models, fields, mappings, relations, unique declarations  |
| `catalog.ts`             | `pg_catalog` → `DbCatalog`. The only file that talks to a database |
| `compare.ts`             | `(schema, catalog) → findings`. Pure: no I/O, no clock             |
| `report.ts`              | Findings → text                                                    |
| `cli.ts`                 | Argument handling and wiring                                       |

The differ is pure so it can be driven from fixtures, including deliberately damaged ones.

## Tests

```bash
pnpm --filter @civitai/db-schema test
```

`__tests__/fixtures/` holds a small curated schema and two catalogs — one aligned with it,
one carrying exactly one seeded defect per drift class. A dump of the real catalog would be
226 KB and would make the expectations unreadable.

The suite includes both controls at two levels — the differ and the command people
actually run — because a detector that returns nothing is indistinguishable from one wired
to nothing until you have watched it do both:

- a **negative control** — an aligned pair is compared, the run is asserted silent, one
  foreign key is then removed from the catalog and the same comparison is asserted to
  report exactly that key;
- a **positive control** on the zero — the aligned run also asserts non-zero
  _checked_ counts (4 relations, 3 unique declarations, >15 columns), so an empty finding
  list cannot come from a comparison that visited nothing;
- **the same pair at the CLI level** (`cli.test.ts` runs the real entry point as a
  process): an empty catalog must exit 2 with "not trustworthy", and a covering catalog
  must exit 0. Without the second assertion the first could be passing for any reason.

`catalog.test.ts` drives the reader with a fake query runner: it covers row decoding
(action codes, ordered tuples, unparsed arrays, expression indexes) and pins the
load-bearing SQL predicates (`indpred IS NULL`, `relkind IN ('r','p')`, `WITH ORDINALITY`,
`attname::text`). It does **not** execute the SQL. A fake runner hands the reader
already-parsed JavaScript arrays, which is precisely how the `name[]` bug above stayed
invisible to it — so a green suite here is not a claim that the queries behave correctly
against a real server. Check that by running the tool.

## Measured against the committed snapshot, 2026-08-05

`__tests__/fixtures/catalog-production-2026-08-03.json` is a point-in-time capture of the
production constraint catalogs — table and column names, nullability, foreign-key and
unique-index column tuples. Schema metadata only: no row data, and nothing about where the
database runs. Reproduce with:

```bash
pnpm --filter @civitai/db-schema drift \
  --catalog src/schema-drift/__tests__/fixtures/catalog-production-2026-08-03.json
```

```
declared owning-side relations : 476
checked against the database   : 445
skipped (view / absent table)  : 31
MISSING foreign key            : 37
wrong referential action       : 0   <- see below
MISSING column                 : 12
nullability checked            : 2383
nullability drift              : 11
uniqueness declarations checked: 122
missing unique index           : 1
```

61 findings in total. The 11 nullability findings are `Purchase.userId`,
`ChallengeEvent.createdById`, and nine `*Metric.updatedAt` columns. The 12 missing columns are
`ModelFlag.sfwOnly`, `UserCosmeticShopPurchases.meta`, and ten
`UserRank.thumbs{Up,Down}Count*Rank`. The single uniqueness finding is
`ImageResource(modelVersionId, name, imageId)`.

**Nullability was 246 when this tool shipped.** #3592 then marked the seven `*Rank` families'
columns optional to match the database and 235 of them went away — a real remediation, and
the reason this section is dated separately from the snapshot. Nothing observed it at the
time, because no CI job ran this package's suite; the two assertions that pinned those 235
were red on `main` from the moment #3592 merged until the packages were wired into CI.

**The `0` on referential actions is "not measured", not "clean".** This snapshot predates
that check and carries no `ON DELETE`/`ON UPDATE` data, so all 408 comparable foreign keys
report as _not comparable_ and the tool says so on its own line. A live run does measure
them: the first one found **45**, all `ON UPDATE` (declared `Cascade`, database `NoAction`),
with zero `ON DELETE` mismatches.

### Why not the checked-in `02_all_dll.sql`?

`containers/db/docker-init/02_all_dll.sql` is a real, checked-in `pg_dump`, and reusing it
instead of shipping a snapshot would be the tidier answer. Measured, it cannot serve: it is
a **dev bootstrap DDL, not a production mirror**. It defines 195 tables against production's
342, omits 178 production foreign keys, and — the part that matters — declares 25 foreign
keys production does **not** have.

Compared against the 37 missing foreign keys documented above, that dump would:

|                | count |                                                  |
| -------------- | ----- | ------------------------------------------------ |
| **contradict** | 19    | the dump has the constraint; production does not |
| **not see**    | 7     | the table is absent from the dump entirely       |
| agree          | 11    |                                                  |

All three `Club` image relations are in the contradicted 19, so pinning to it would assert
that the very foreign keys this tool found missing are present. It agrees on the `*Rank`
nullability shape (`UserRank`: 40 columns, 1 `NOT NULL`, no `thumbs*`) and on
`ModelFlag.sfwOnly` being absent — a spot check there reads as a match, which is exactly how
it looks like a usable substitute until you enumerate the foreign keys.

### A note on `/// @view`

The tool does not read the `/// @view` annotation, and does not need to. Whether a model is
backed by a view is decided from the catalog — `relkind IN ('r','p')` — so a model on a view
is skipped because the database says it is a view, not because the schema says so. That
matters, because the annotation is unreliable: the strip regex in
`scripts/prisma-migrate-with-views-workaround.mjs` requires `/// @view` to be immediately
followed by `model`, and 26 of the 32 annotated models have a blank line in between.

These totals are a fact about this schema and this snapshot together. The snapshot is frozen
and the schema is not, so the totals drift as the schema grows — a field added tomorrow has
no column in a catalog captured today. `production-snapshot.test.ts` therefore asserts the
named findings survive rather than pinning the totals, so ordinary schema work does not red
the suite for reasons that have nothing to do with this tool. Re-run the command above for
current numbers.

## In CI

The root `unit` Vitest project globs `src/**` and `scripts/**` — both root-relative — and the
`Unit tests` job runs `vitest run --project unit`, so for a while nothing in CI invoked this
package's suite, or any of the eight other `packages/*` suites. 616 tests, 81 of them this
tool's, ran only for whoever remembered `pnpm --filter <pkg> test` by hand.

They now run in the `Package unit tests` job, from the `packages/*/vitest.config.*` entries in
the root `vitest.config.mts`:

```bash
pnpm run test:packages:run          # all nine package suites
pnpm --filter @civitai/db-schema test   # just this one
```

That job is blocking, and it asserts a ledger — every workspace package that has a vitest
config and a test file on disk must appear in the results — because `--project` matching
nothing exits 0, and so does a config whose globs stopped resolving.
