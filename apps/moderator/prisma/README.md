# The moderator database's schema

The database is the source of truth, not this schema. It was built by Retool over years of GUI edits,
so `schema.prisma` is **introspected**, never authored, and there are no migrations here — the main
app's rule (write the SQL, apply it by hand) applies to this database too.

```bash
pnpm run db:moderator:pull       # DB -> schema.prisma
pnpm run db:moderator:generate   # schema.prisma -> src/lib/server/moderator-db/{types,enums}.ts
```

Only `prisma-kysely` runs; there is no Prisma Client for this database. `getModeratorDb()` is Kysely,
and the generated `DB` type is what it is parameterised on.

## Three things you have to know before running the pull

**`MODERATOR_DATABASE_URL` needs `?sslmode=disable`.** Connections go through a tunnel that terminates
TLS, so Prisma negotiating its own gets `P1011: Error opening a TLS connection`. Kysely at runtime does
not care; this is an introspection-only requirement, which is why it is written here and not in
`.env.example`.

**A comment at the top of `schema.prisma` will not survive** — re-introspection drops free-standing
comments. `///` doc comments attached to a model, field or enum value are preserved, so anything that
must last goes on the thing it describes. That is why this file exists.

**`task_enum_0648e184`'s member names are hand-written.** Five of its values (`1_catchup` … `16_catchup`)
begin with a digit, and Prisma's sanitiser turns every one of them into the identifier `catchup` — five
members, one name, and the schema will not parse. They are named `catchup_1` … `catchup_16` with the real
value in `@map`. Re-introspection preserves that; if a pull ever loses it, the parse error names the
enum and this paragraph is the fix.

## What is in here that the app does not use

The pull takes all 51 tables, so the generated types describe the database rather than the subset with a
screen. Two consequences worth stating:

- **Moderators are recorded by NAME** in `createdBy` / `lastUpdateBy` / `handledBy`, not by user id. The
  types say `string | null` because that is the truth; consolidating those onto ids is tracked in
  [`docs/moderator-app/moderator-db-backfill-tasks.md`](../../../docs/moderator-app/moderator-db-backfill-tasks.md).
- **Nine of the 51 tables belong to `xguard-lab/`** (`sample`, `eval_run`, `eval_result`, `label_def`,
  `label_policy`, `label_term`, …). The lab shares this database, and its `schema*.sql` files are still
  where those tables are *authored* — a pull reads them, it does not own them. Change one there.
- **`TimedMutes` is present but must stay unread.** A timed mute is `User.muteExpiresAt` in the *main*
  database, drained hourly by `processTimedUnmutesJob`. This table duplicated that with no consumer, so a
  mute recorded only here never lifted. It is history awaiting a drop, not storage.
