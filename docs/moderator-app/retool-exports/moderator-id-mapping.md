# Retool moderator → Civitai user id

Retool records attribution as free-text display names (`lastUpdateBy`, `createdBy`, `handledBy`,
`ReToolActions.User`). This is the mapping to real user ids, supplied by the moderation team
2026-08-06. Without it, "who wrote this note" is lost for most of 69,100 records.

New rows written by the moderator app use the moderator's **Civitai username** instead, so the column
holds two naming schemes until the backfill runs — see
[retool-db-tables.md](retool-db-tables.md).

## Mapping

| userId | username | Retool display name |
| --- | --- | --- |
| 5418 | `theally` | Ally Nicoli |
| 149676 | `Valstrix` | Logan Waxler |
| 203133 | `CHESHIRE_OS` | Navi_OS |
| 296765 | `Seb` | Sebastian Widlund |
| 984231 | `Temporarium` | Temporarium |
| 2023372 | `KesWasHere` | Kes Krcha |
| 2342520 | `dolirama126` | Tomas Sitar |
| 2345535 | `DazMakeArt` | Dazzer Wave |
| 11579707 | `Ellie_TheFoxyPaladin` | Ellie King |
| 11841732 | `wade_mod` | *(agent account)* |

### Former moderators

| userId | Retool display name |
| --- | --- |
| 3 | Maxfield Hulker |
| 573 | Cameron Jackson |
| 1019954 | Lars Wilstermann |
| 2709 | Joseph McPeeks |
| 4938487 | Jane Kim |

## Coverage against the live data

Across `UserNotes` + `UserStrikes` — **69,100 attributed records, 37 distinct identifiers**:

| | records | share |
| --- | --- | --- |
| exact name match | 50,027 | 72% |
| short form or variant — **needs confirmation** | 14,756 | 21% |
| unmapped | 4,317 | 6% |

## Variants to confirm before the backfill

Retool stores several people under more than one identifier. These are inferred, not given:

| identifier in data | records | assumed to be | confidence |
| --- | --- | --- | --- |
| `Valstrix Waxler` | 6,100 | Logan Waxler (149676) | **check this one** — 6k records hinge on it |
| `Logan` | 1,751 | Logan Waxler (149676) | likely |
| `Valstrix` | 135 | Logan Waxler (149676) | likely (matches the username) |
| `Sebastian` | 460 | Sebastian Widlund (296765) | likely |
| `Tomáš` / `Tomáš Sitár` | 1,535 | Tomas Sitar (2342520) | accents differ from the supplied spelling |
| `Ally Nicoll` | 776 | Ally Nicoli (5418) | **spelling differs** — Nicoll vs Nicoli |
| `Temporarium S` | 517 | Temporarium (984231) | likely |
| `Navi_OS null` | 180 | Navi_OS (203133) | likely — a null surname concatenated |
| `Cameron`, `Lars`, `Kes`, `Dazzer`, `Ally`, `Joseph`, `Jane`, `Ellie` | ~3,300 | their full-name entries | likely |

Two need a human answer rather than a guess:

1. **`Valstrix Waxler` (6,100 records)** — the supplied row is `149676 / Valstrix / Logan Waxler`, so
   this looks like the same person under a changed Retool display name. It is the single largest
   variant; getting it wrong misattributes 6,100 notes.
2. **`Ally Nicoll` vs supplied `Ally Nicoli`** and **`Tomáš Sitár` vs supplied `Tomas Sitar`** — the
   data does not match the mapping character-for-character. Match case- and accent-insensitively, or
   correct the mapping.

## Unmapped — 4,317 records

"Not listed means the records can probably be removed", per the moderation team. One entry does not
look disposable:

| identifier | records | note |
| --- | --- | --- |
| **Brittany Widlund** | **3,888** | **90% of the unmapped total.** Deleting this discards 3,888 moderator notes. Confirm before treating it as removable — a former moderator missing from the list is more likely than 3,888 junk rows. |
| Brittany | 195 | same person |
| Richard / Richard Kelly | 96 | |
| Justin Maier | 64 | |
| Paul Geraghty / Paul | 32 | |
| Bruno Henrique / Bruno Henrique Roda | 29 | |
| civitai-mod | 13 | service account, not a person |

Excluding Brittany, genuinely unmapped volume is **434 records (0.6%)** — that part is safe to drop.

## Applying it

The backfill is not written yet. When it is:

1. Match case- and accent-insensitively, or the two spelling mismatches above silently fall through.
2. Resolve variants to their canonical person first, then to the userId.
3. Write to a new id column rather than overwriting the text — the original string is the only evidence
   if a mapping turns out wrong.
4. Report what did not match rather than dropping it silently.

Regenerate the coverage figures with
[`retool-db.mjs`](../../../.claude/skills/retool-migration/retool-db.mjs).
