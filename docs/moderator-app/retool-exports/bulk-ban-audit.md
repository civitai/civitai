# Bulk Ban — coverage classification

All 15 queries bucketed per the migration skill's §2, before any code.

**What the app is.** Two things sharing a screen. (1) Paste a list of accounts, pick a reason, ban them
all. (2) A **ban-evasion console** — the queries that build that list in the first place: registration
IPs, email-domain clustering, and other accounts seen on the same IPs. The second half is the reason
the first half has anything to ban.

⚠️ **Several queries are saved ad-hoc investigations with hardcoded values** — specific account ids, a
specific email domain, four specific IPs. Those are a *moderator's scratchpad*, not configuration. They
are ported as **the shape with an input**, never with the literals, which would silently re-run someone
else's investigation.

## Classification of all 15

### port (9)

| Query | Notes |
| --- | --- |
| `BANAPI` | `/api/mod/ban-user` — **already wrapped** by `setBanned`, which also writes ModActivity with the real moderator id. The port loops that service rather than re-implementing the call. |
| `BanUsers` | The loop itself: sequential, `onFailure` retries the *same* id, and the whole run aborts after **5 consecutive failures**. That cap is the safety property — without it a bad token bans nothing 500 times. |
| `ListUsers` | The preflight: `WHERE id = ANY(ids) AND bannedAt IS NULL AND deletedAt IS NULL` — which of the pasted ids are actually bannable. |
| `query12` | The same, keyed by **username** instead of id. This is the second entry point, not a variant. |
| `getEmails` | ids → emails, for the preflight table. |
| `query16` | ids → usernames, for the preflight table. |
| `GetIP` | Registration IPs for the pasted set, with a count per IP. The first ban-evasion signal. |
| `GetEmail` | Email-domain histogram for the set — a disposable-domain ring shows up as one domain with a high count. |
| `UsersByIp` | Given IPs, every account that registered there. This is how the list grows from one account to a ring. |

### equivalent (2)

| Query | Covered by |
| --- | --- |
| `LogBans` | GUI write to `ReToolActions`. We log to `ModActivity` via `recordModActivity`, which `setBanned` already does per account. Retool's table is a read-only archive here. |
| `UserNotes` | GUI write to `UserNotes` — a note on each banned account. `addUserNote` (`moderation-memory.service.ts`) is the same write, and attributes by username per the skill's attribution rule. |

### ~~plumbing / ad-hoc (3)~~ — this bucket was WRONG, corrected 2026-08-10

The fidelity review found all three misfiled, in both directions. Kept here rather than rewritten
silently, because the reasoning that produced it is the reasoning to avoid.

The bucket rested on "these are saved past investigations, and their shapes fall out of what we
built". Neither half held. **No widget in the export binds any of the ban-evasion queries** — they are
all equally editor-only — so "ad-hoc" was not a distinction the export supports, and it was applied to
three of the six arbitrarily.

| Query | Was | Actually |
| --- | --- | --- |
| `GetUsers` | ad-hoc | **A workflow, and now ported.** Distinct accounts that tipped ≥50 to a set of recipients, floored at recently-created ids: a buzz-farm finder. The only query in this export that ORIGINATES a ban list rather than annotating one, and what the `BuzzCheating` ban reason fed. |
| `query15` | "falls out of the domain histogram" | **It does not, and it is now ported.** `getEmailDomains` is scoped `WHERE id IN (pasted set)`, so it can COUNT a ring but never GROW one. `query15` searches the whole `User` table by domain — the twin of the IP expansion that was ported. |
| `query13` | ad-hoc | **Covered** — usernames resolve via `resolveUsernamesToIds` and each candidate's email renders. Belongs in `equivalent`, i.e. misfiled in the opposite direction. |

Its input widget is worth noting: `textArea2` is now bound to `{{ListUsers.data.id.join('\n')}}` and
disabled, so `query12`/`query13` dangle against a repurposed widget in the current export. The build's
username entry point is a reasonable reconstruction, not observed live behaviour.

The hardcoded ids, domain and four IPs are still not carried over — parameterising them was right.

### superseded / blocked (1)

`deleteComments` — `DELETE FROM "CommentV2" WHERE id = ANY(query22.data.id)`. **`query22` does not exist
in this export**, so the input is dangling and the query cannot have run as written. It also deletes
directly against `Prod`, where the rest of the app goes through `/api/mod/retool/comment`
(`bulkCommentAction`), which is transactional and logged.

**Not ported.** Comment removal for a banned account already exists on User Lookup, through the
endpoint. Recorded rather than silently dropped.

## Decisions taken without asking

**The ban loop stays sequential with the 5-failure abort.** Parallelising it would be faster and
wrong: the cap exists so a systemic failure (bad token, endpoint down) stops the run instead of
hammering it once per account, and a partial run must report exactly how far it got.

**Every ban goes through `setBanned`, one account at a time.** That endpoint fans out to media purge,
model unpublish, notifications and cache busting; a bulk shortcut around it would be a second
definition of what banning means.

**The investigation queries take the pasted set as their input.** They ran off a hardcoded list in
Retool; here they answer "what do these accounts have in common?" for whatever is in the box.

## Open

- 🎥 **Access.** *"This one is limited to only some mods… that's good for other mods to have access to
  this too."* Ported behind `isSenior` — mass banning is the highest-blast-radius action in the app.
  Widening it is a deliberate decision, not a default.
- `ReToolActions` remains a read-only archive; nothing reconciles it with `ModActivity`.
