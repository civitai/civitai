# Retool moderator → Civitai user id

Retool records attribution as free-text display names (`lastUpdateBy`, `createdBy`, `handledBy`,
`ReToolActions.User`). Mapping those to real user ids is what keeps "who wrote this note" from being
lost for most of 69,100 records.

**The mapping table itself is not held in this repository.** It pairs staff members' real names with
their Civitai accounts, which is personal data about identifiable people — and this repository is
public. It lives in the private infrastructure repo instead:

> `claudedocs/moderator-id-mapping.md` in `civitai/talos-infra`

Ask in `#moderation` if you need access. Everything below is the part that carries no personal data:
the coverage figures, the variants that still need a human answer, and how to apply the mapping when
the backfill is written.

New rows written by the moderator app use the moderator's **Civitai username** instead of a free-text
name, so the column holds two naming schemes until the backfill runs — see
[retool-db-tables.md](retool-db-tables.md).

## Coverage against the live data

Across `UserNotes` + `UserStrikes` — **69,100 attributed records, 37 distinct identifiers**:

| | records | share |
| --- | --- | --- |
| exact name match | 50,027 | 72% |
| short form or variant — **needs confirmation** | 14,756 | 21% |
| unmapped | 4,317 | 6% |

## Variants to confirm before the backfill

Retool stores several people under more than one identifier. These are inferred, not given, and the
identifiers are held with the mapping in the private repo. Two need a human answer rather than a
guess, and both are recorded there:

1. **The largest variant accounts for 6,100 records** — it looks like one person under a changed
   Retool display name, but it is inferred. Getting it wrong misattributes 6,100 notes.
2. **Two supplied spellings do not match the data character-for-character** — one differs by a single
   letter, one by accents. Match case- and accent-insensitively, or correct the mapping.

## Unmapped — 4,317 records

"Not listed means the records can probably be removed", per the moderation team. One entry does not
look disposable: a single former moderator accounts for **3,888 records — 90% of the unmapped total**.
Deleting that discards 3,888 moderator notes, and a former moderator missing from the list is far more
likely than 3,888 junk rows. Confirm before treating it as removable.

Excluding that one identifier, genuinely unmapped volume is **434 records (0.6%)** — that part is safe
to drop.

## Applying it

The backfill is not written yet. When it is:

1. Match case- and accent-insensitively, or the two spelling mismatches above silently fall through.
2. Resolve variants to their canonical person first, then to the userId.
3. Write to a new id column rather than overwriting the text — the original string is the only evidence
   if a mapping turns out wrong.
4. Report what did not match rather than dropping it silently.

Regenerate the coverage figures with
[`retool-db.mjs`](../../../.claude/skills/retool-migration/retool-db.mjs).
