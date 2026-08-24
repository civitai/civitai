# Moderator database — backfill and ID consolidation

The moderator database (Retool's `retool_db`, reached through `getModeratorDb()`) was built inside
Retool, where the only identity available was the operator's **display name**. Nothing in it joins to
the main app. This file tracks the work to fix that.

It is deliberately separate from
[`retool-exports/parity-findings.md`](retool-exports/parity-findings.md), which tracks whether a Retool
*behaviour* was ported. Everything here is about **data**: rows that already exist and cannot be joined,
and columns whose type or absence forces a workaround in code. A page can be at full parity and still
sit on top of every problem below.

> **Public repo.** Record counts, column names and shapes here — never the operator names themselves,
> and never a real user id. The mapping table this work produces holds staff identities and belongs in
> the private infra repo, not here.

## The two problems

**1. Attribution is a name, not an id.** Nine columns across eight tables record *who acted* as free
text. Measured 2026-08-20: **53 distinct names** across all of them, **26 containing a space** — i.e.
"First Last" display names that are not Civitai usernames and never were.

The spoke has been writing `locals.user.username` into these columns since the port, so each one now
holds **two naming schemes**: Retool display names historically, Civitai usernames going forward.
Nothing joins on them, which is the only reason this has not broken anything yet.

**2. The subject is sometimes not an id either.** The account a row is *about* is an integer on two
tables, text on one, and absent entirely on a fourth.

## Inventory

Attribution columns — all `text`, all holding two schemes:

| Table | Column | Rows | Distinct names |
| --- | --- | --- | --- |
| `RatingChanges` | `updatedBy` | 363,488 | 12 |
| `ReToolActions` | `User` | 132,041 | 43 |
| `FrontPageTimers` | `username` | 66,701 | 16 |
| `UserNotes` | `lastUpdateBy` | 58,148 | 22 |
| `Mods_TaskTimers` | `lastUpdateBy` | 18,656 | 18 |
| `UserStrikes` | `createdBy` | 12,902 | 17 |
| `ModerationImageHelp` | `createdBy` / `handledBy` | 37 | 11 |
| `TimedMutes` | `createdBy` | 0 | — (table dropped, §C) |

Subject columns — the account the row is *about*:

| Table | Column | Type | State |
| --- | --- | --- | --- |
| `UserNotes` | `userId` | `integer` | ✅ joins to `User.id` |
| `UserStrikes` | `userId` | `integer` | ✅ joins to `User.id` |
| `TimedMutes` | `userId` | **`text`** | ✅ **moot — drop the table.** Nothing reads or writes it since 2026-08-20; timed mutes are `User.muteExpiresAt`, drained hourly by `processTimedUnmutesJob`. 0 rows, so nothing to migrate. |
| `ReToolActions` | — | — | 🔴 **no subject column at all**; the account is embedded in `ActionType` prose |

`FrontPageTimers.username` is a third case: it is usually an operator, but the Split control writes the
literal sentinel `splitQueue` there. Any name→id backfill must skip it — see `SPLIT_USERNAME` in
`front-page-timers.ts`.

## Tasks

### A. Build the name → userId map

- [ ] **Assemble the 53-name mapping**, by hand, against the main app's `User` table. The skill's
      earlier note said only 5 of 37 mapped; that figure predates this inventory and should be
      re-derived. Expect three buckets: resolves to a live account, resolves to a departed account,
      and no account ever (contractors, shared logins, `splitQueue`).
- [ ] **Store it in the private infra repo**, not here. It is a staff roster.
- [ ] **Decide what a non-resolving name becomes.** A null id loses the audit trail; a sentinel id keeps
      it and needs a documented meaning.

### B. Add id columns beside the name columns

- [ ] **Add a nullable `<column>UserId integer` next to each of the eight that survive** — all but
      `TimedMutes.createdBy`, whose table §C drops — backfill from the map, and leave the text column in
      place. Do **not** replace the text: for the ~half that never map, the name is the only record of
      who acted.
- [ ] **Repoint the spoke's writes** to populate both. Today `moderation-memory.service.ts` and
      `front-page-timers.ts` write the username only.
- [ ] **Then, and only then, join on the id.** Until the backfill lands, reads must keep matching on
      text or they silently return nothing.

### C. Fix the subject columns

- [x] ~~**`TimedMutes.userId` is `text`.** Migrate to `integer`.~~ **Superseded — drop the table
      instead.** It duplicated `User.muteExpiresAt`, which the main app already drains hourly via
      `processTimedUnmutesJob` and which is strike-aware; the side table had no consumer, so a mute
      recorded only there never lifted. As of 2026-08-20 nothing in the spoke reads or writes it. It is
      still typed — introspection takes every table — so the ban on reading it lives in a `///` comment on
      the model in `apps/moderator/prisma/schema.prisma`. It held 0 rows.
- [ ] **Drop `TimedMutes` at cutover**, once Retool is switched off. Left in place only because Retool
      can still write it while it is live.
- [ ] **`ReToolActions` has no subject column.** `getRetoolActivity` recovers the account by regex over
      `ActionType`, which is why that function needs a subject-label anchor — a bare number match
      attributed image counts and strike numbers to whichever account shared the value (id 1 matched
      22,130 unrelated rows; see `parity-findings.md`). The durable fix is a derived
      `subjectUserId integer` column, backfilled once by parsing the known phrasings:

      | Shape | Rows | Subject |
      | --- | --- | --- |
      | `ToS N images from <id>` | 44,431 | trailing id |
      | `UNMUTE: User <id>` | 29,452 | trailing id |
      | `VERIFY MUTE: User <id>` | 20,178 | trailing id |
      | `Strike number N on user <id>` / `Strike N on user <id>` | 12,969 | trailing id |
      | `BAN: UserID <id>` | 1,036 | trailing id |
      | `ToS N images from modelId <id>` | 1,013 | **a model, not a user** |
      | `Banned N accounts` | 710 | none — a count only |

      1,127 rows contain no number at all. Anything unparsed stays null rather than guessing.

### D. Decide the destination

- [ ] **The moderator database still lives on Retool's Postgres.** `getModeratorDb()` points there, which
      is what makes the incremental cutover work — Retool and the spoke read and write the same rows.
      Switching Retool off does not move the data; it just removes the second writer.
- [ ] **Decide where it lands afterwards**, and whether these tables become part of the main schema (and
      so gain real foreign keys) or stay a separate database with soft references. The answer changes
      how much of §B is worth doing: real FKs make the id columns mandatory, soft references do not.

## Ordering

§A blocks §B, and §B is only worth its cost once §D is decided — an id column that will become a foreign
key is a different piece of work from one that stays advisory. §C's `ReToolActions` backfill is
independent of all of it and is the one that removes a live regex workaround, so it is the piece with the
clearest payoff today.
