# Raw Retool exports

The nine app exports this migration was built from, as attached to the ClickUp subtasks under
`868kkxqpn`. Kept here because Retool access is being lost and the inventories beside them are lossy:
they render what the extractor knows how to render, and the extractor has already been wrong twice
about what mattered.

Re-inventory any of them with:

```bash
node .claude/skills/retool-migration/extract.mjs docs/moderator-app/retool-exports/raw/<app>.json
```

## These are SANITIZED, and that is not optional

This repository is public and permanent. `user-lookup-v2.json` carried a live
`Authorization: Bearer <token>` **seven times**; those are now `Bearer <REDACTED>`. Bare JWTs,
Postgres connection strings, non-`civitai.com` email addresses and Stripe-shaped keys are stripped by
the same pass.

**Never overwrite one of these with a fresh download.** Sanitize first, verify the output contains no
secret-shaped strings, and only then commit — a token in git history is disclosed permanently, and
deleting the file afterwards does not undo that.

Redaction is not limited to credentials. An internal CIDR and an abuse-domain literal are stripped
too — network topology and moderation trigger terms are both private-repo material, and the second is
one sentence from being an evasion guide. **Both were already in the committed inventories before this
directory existed, and those commits are pushed**, so they are disclosed; the redaction stops the leak
widening rather than undoing it. Neither is a credential, so there is nothing to rotate.

The inventories are generated FROM these files, so regenerate rather than hand-editing —
`extract.mjs raw/<app>.json > <app>.md` — or a redacted export will quietly grow an unredacted
inventory beside it.

**Match on the assignment, not on the shape of the value.** The first sanitiser pass here missed a
live key because it looked only for vendor prefixes and `Bearer` headers: User Lookup carries a
`const apiKey = '…'` inside a Retool `Function` body, which is escaped JS inside the JSON and looks
like nothing in particular. It was caught before the commit was ever pushed. Anything matching
`(apikey|token|secret|password|auth)\w*\s*=\s*['"]…` is now redacted regardless of what follows.

## Read the whole file, not just the SQL

Two misses came out of trusting the query list alone, both found in review rather than in the build:

- **Option sets live in widget config, not in queries.** User Lookup's buzz *Reason* picker is
  `{{buzzSendAction.value === 'send' ? SendTypes.value : DeductTypes.value}}` — two `Function`s, and
  the list is **scoped by the action**: send offers Reward/Refund, deduct offers
  Purchase/Chargeback/AuthorizedPurchase. The port offered four unrelated hardcoded values in both
  directions. (A `transactionTypes` query doing `SELECT DISTINCT type FROM buzzTransactions` also
  exists in this export, but nothing binds it to the picker — reading the query list and guessing the
  binding is how that got asserted here in the first place. **Confirm the binding.**)
- **A `Function` query is not automatically plumbing.** `TosReasons` (Bulk Image Manager and User
  Reports) is typed `Function`, which the migration skill's §2 says to bucket as Retool-side glue. It
  actually holds the eleven canned TOS removal reasons, the user-facing message for each, and the flag
  (`poi` / `minor` / `tag`) each one sets. Same for `BanReasons` in Bulk Ban.

Grep the raw JSON when something a moderator describes is absent from the inventory.
