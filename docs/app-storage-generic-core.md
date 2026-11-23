# App Storage: a generic collections core

**Status:** design, decided (see "Decisions"); nothing built. Production usage was measured on
2026-11-23 ("Inventory (2026-11-23)"). Code citations are to `main` at `f9cad06bca`.

App Storage (the document store behind `/api/v1/blocks/storage`, `src/server/services/apps/doc-store.ts`)
grew feature-specific primitives next to its collections: marks, counters, tallies on every document,
server-side publish, and the `report` mark. This document reduces the core to **generic collections**,
adds **one** generic feature (viewer-keyed documents), moves `report` to a platform moderation API, and
plans the migration of the data and SDK calls that use what is removed.

## Decisions

1. **The core is generic collections only**, private and shared. Removed from the core: marks
   (`$mark` / `$unmark`, declared `marks`), counters (`$inc`, declared `counters`, `write: "none"` and
   its counter documents), tallies on presented documents (`counters`, `marks`, `viewer.marks`; list
   `sort=counter:` / `sort=mark:` and `markedBy=me&mark=`), and server-side publish / unpublish.
2. **`report` leaves storage** for a platform moderation API: a document is reported by its identity;
   the count is never exposed to apps; reports feed the existing moderator queue; the rate limit, the
   "cannot be withdrawn" rule and the dismissal semantics are kept.
3. **One generic addition: viewer-keyed documents.** A shared collection may declare that its document
   key is derived by the server from the verified viewer, optionally combined with a parent key the
   client supplies, so each viewer has at most one document per (parent) key and cannot write another
   viewer's. Votes, likes, ratings and per-user entries become ordinary documents. There are no
   server-side aggregates: an app counts by listing the collection with `keyPrefix=<parent>:`, and
   there is no sort by count. A generic aggregate would be a separate, later decision.
4. **Migration: inventory first, then deprecate.** Ship the replacement, migrate each using app's data
   and SDK calls, and remove the primitives once their usage is measured at zero. The known user is
   model-benchmarking (a shared `records` collection with `marks: ["vote"]`, plus `report`).
5. **Platform policies stay as they are:** moderation hide and delete, the shared-write content scan,
   content levels, write hooks, collection schemas, `ownedModelVersions`, `showAuthor`, imports, quotas
   and rate limits, namespaces.

## Where this doc lives, and what it supersedes

Here in `docs/`, because the repo puts plans there (`CLAUDE.md`, "How to work with us") and this one
spans the site's store and REST route, the moderator surface, the registry adapter, `apps/app-data-go`
and the SDK; an app's own `DESIGN.md` covers that app only. When a step ships, the behaviour moves
into `docs/features/app-blocks.md` and the developer docs, and this plan's status line moves with it.

It changes the plan in `apps/app-data-go/WRITES-DESIGN.md` (see "Registry and app-data-go impact");
that file is updated in its own PR once this is accepted.

Out of scope: the legacy per-app stores (`app_<slug>.shared_kv` with its `votes`, `counters` and
`shared_kv_reports` tables), already refused to apps behind `app-blocks-legacy-stores-removed`
(`legacy-store-shutdown.ts`).

## The core after the change

### Collections and write policies

Unchanged, minus `write: "none"`. The core is `private` and `shared` with `write: "own"`:

| Visibility               | Key space                                     | Who writes                                                                                  |
| ------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `private`                | one per viewer (`doc.scope_uid` = the viewer) | the viewer                                                                                  |
| `shared`, `write: "own"` | one per app namespace (`scope_uid = 0`)       | eligible viewers create; only a document's author updates or deletes it (`assertMayModify`) |

`write: "none"` is removed: it exists only so counters can create unowned documents
(`APP_STORAGE_WRITE_POLICIES`, `assertShareWritable` in `doc-store.ts`). A collection whose approved
manifest still declares it is served **read-only** until a new version drops it (see "Manifest
fields"): it must never fall back to `own`.

`write: "anyone"` and `write: "owner"` are **out of scope** for this core: both are switched off at
compile time (`anyoneWrites` and `ownerWrites` are `false` in `APP_STORAGE_ENABLED_FEATURES`) and have
never run. This plan neither builds nor removes them.

A shared collection's key is today either chosen by the client (`PUT /:c/:key`, an upsert; under
`own`, the first writer of a key owns it) or minted by the server (`POST /:c`, a ULID, or the hook's
pre-generated key). Viewer-keyed collections add a third way, below.

### Operations

| Route (under `/api/v1/blocks/storage`)                              | Op                                            | Change                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`                                                             | info                                          | `counters`, `marks` leave each collection; `keyedBy` is added, and `open` on a viewer-keyed collection (its migration switch); `rate.marksAndCountersPerMinute` and `rate.reportsPerDay` leave `limits.rate` |
| `GET /:c`                                                           | list                                          | `markedBy`, `mark`, `sort=counter:*`, `sort=mark:*` removed                                                                                                                                                  |
| `POST /:c`                                                          | create                                        | refused on a viewer-keyed collection                                                                                                                                                                         |
| `POST /_get/:c`                                                     | get many                                      | unchanged                                                                                                                                                                                                    |
| `GET /:c/:key`                                                      | get                                           | unchanged                                                                                                                                                                                                    |
| `PUT /:c/:key`, `DELETE /:c/:key`                                   | put, delete                                   | refused on a viewer-keyed collection (use `@me`)                                                                                                                                                             |
| `GET`, `PUT`, `DELETE /:c/@me`                                      | the viewer's document                         | **new**, `keyedBy: "viewer"`                                                                                                                                                                                 |
| `GET`, `PUT`, `DELETE /:c/@me/:parent`                              | the viewer's document for `parent`            | **new**, `keyedBy: "parent+viewer"`                                                                                                                                                                          |
| `PATCH /:c/:key` (`$inc`, `$mark`, `$unmark`)                       | tallies                                       | **removed**                                                                                                                                                                                                  |
| `POST /:c/:key/counters/:name`, `PUT`/`DELETE /:c/:key/marks/:name` | tallies (already deprecated)                  | **removed**                                                                                                                                                                                                  |
| `POST /_publish/:to`, `POST /_unpublish/:to`                        | publish (behind `app-blocks-storage-publish`) | **removed**                                                                                                                                                                                                  |

`@me` cannot collide with a key: `@` is outside the key grammar (`DOC_STORE_BOUNDS.key`,
`[A-Za-z0-9._:-]{1,128}`), so `matchStorageRoute` can route it before key parsing. It joins
`STORAGE_RESERVED_SEGMENTS`. A three-segment path is unused today.

List after the change: one `where[<index>]` equality, `sort=[-]key|createdAt|updatedAt|<index>`,
`author=me`, `keyPrefix`, `limit`, `cursor`, all combinable as today (`list` in `doc-store.ts`).

### The presented document

`PresentedDoc` (`doc-store-api.ts`) after the change. `level` and `ratingStatus` appear only while
content levels are on for the app, as today; `username` only on a `showAuthor` collection:

```json
{
  "key": "01JD3Q8M5Z4X2V7K9C6B1N0RTA:gq4z7m2k5w6c3t6y7b2d4f7h3j",
  "data": { "value": 1 },
  "version": 2,
  "level": 1,
  "ratingStatus": "rated",
  "createdAt": "2026-11-23T10:00:00.000Z",
  "updatedAt": "2026-11-23T10:05:00.000Z",
  "author": { "kind": "user", "isViewer": true, "username": "someone" }
}
```

`author.kind` is `user` or `app`; `counter` is removed with counter documents (`DocAuthor`,
`PresentedAuthor`). `counters`, `marks` and `viewer` are removed. During the compatibility window
(rollout step 3) they are still sent, as `{}`, `{}` and `{"marks": []}` (`null` for an anonymous
viewer), on collections that declare no marks or counters, so a client reading them does not break
before it upgrades.

The internal route (`via === 'service'`, used by app-data-go) keeps adding `seq` and `recordId` to
write answers; `markSeq` goes with the tally ops.

### Viewer-keyed documents

**Declaration.** One new field on a shared collection:

```json
"storage": {
  "collections": {
    "records": { "visibility": "shared", "write": "own", "indexes": { "createdBy": "string" } },
    "votes": {
      "visibility": "shared",
      "write": "own",
      "keyedBy": "parent+viewer",
      "schema": { "type": "object", "properties": { "value": { "type": "integer", "minimum": -1, "maximum": 1 } }, "additionalProperties": false }
    }
  }
}
```

- `keyedBy`: `"viewer"` (at most one document per viewer in the collection) or `"parent+viewer"`
  (at most one per viewer per parent key). Absent: today's keys.
- Shared collections only, and only with `write: "own"`; the parser refuses it on a private
  collection (already one key space per viewer) and with any other write policy.
- **Immutable once approved:** submit refuses adding, removing or changing `keyedBy` on a collection
  that ANY approved version of the app declared (a collection dropped and declared again is still the
  same stored key space), because it changes what every stored key means. Declare a
  new collection instead. This is a new check beside the schema-migration diff
  (`storage-schema-migrations.ts`).

**Key derivation.** The key is never taken from the request:

- `parent`: 1 to 96 characters of `[A-Za-z0-9._-]` (the key grammar without `:`), not only dots
  (`DOT_ONLY_KEY`). A ULID, or any document key without `:` of at most 96 characters, fits; a key
  that has a `:` or is longer does not. `:` is excluded on purpose: were it allowed,
  `keyPrefix=a:` would also match parent `a:b`'s documents.
- `d` = the first 128 bits of HMAC-SHA256 over the length-prefixed tuple (app id, namespace,
  collection, mode, parent or empty, viewer user id), under a server-held derivation key, as 26
  characters of lowercase RFC 4648 base32 without padding.
- The key is `d` (`keyedBy: "viewer"`) or `<parent>:<d>` (`"parent+viewer"`): at most
  96 + 1 + 26 = 123 characters, inside the existing grammar, so the table, indexes, cursors, feeds and
  URNs need no change. Because `:` is not in the parent grammar, `keyPrefix=<parent>:` lists exactly
  one parent's documents.
- Why a keyed digest and not the user id: every reader of a shared collection sees its keys, and no
  response may carry a numeric user id (`presentDocs`; the storage contract's runner rule in
  `public/schemas/app-block/storage-contract.v1.json`). A digest per (collection, parent) also keeps one
  viewer's documents unlinkable across parents and apps unless the collection declares `showAuthor`.
- The digest is keyed (HMAC), not a plain hash: user ids are small integers, so an unkeyed hash of one
  is reversed by hashing every id.
- What the derivation key protects is that unlinkability only. Authorization never depends on it:
  every `@me` op resolves the viewer from the verified token, and raw-key writes to a viewer-keyed
  collection are refused, so knowing the key grants no write.
- **Anonymous viewers are refused:** every `@me` op, reads included, answers `401 sign_in_required`
  (`requireViewer`). Reads of the collection by key or by list are open to anonymous viewers as on any
  shared collection.

**Semantics of each op.**

| Op                                            | Behaviour                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /:c/@me[/:parent]`                       | the viewer's document, or `404 not_found`                                                                                       |
| `PUT /:c/@me[/:parent]` `{data, ifVersion?}`  | upsert at the derived key, exactly a `put` (`writeDoc`): `ifVersion: 0` means must not exist; `200` with the presented document |
| `DELETE /:c/@me[/:parent]` `[?ifVersion=N]`   | exactly a `delete` (`remove`): tombstone, refunds, `{deleted}`                                                                  |
| `POST /:c`, `PUT /:c/:key`, `DELETE /:c/:key` | `400 invalid_request`, `details.reason: "viewer_keyed"`                                                                         |
| `GET /:c/:key`, `POST /_get/:c`, `GET /:c`    | unchanged reads; `author=me` lists the viewer's own documents, `keyPrefix=<parent>:` one parent's                               |

"Did I vote on these?" is `GET /:c?author=me` (or `&keyPrefix=<parent>:`), served by
`doc_author_idx`. "How many votes does a record have?" is counted by listing the collection with
`keyPrefix=<parent>:`. There is no count op and no sort by count.

**Interaction with each platform policy** (all unchanged; this is where each one applies):

- `write: "own"`: the viewer is always the author of the key they address, so `assertMayModify`
  always passes for their own key and no other key is reachable to them.
- Publish scope and trust gate: a `@me` PUT is a shared create or update, so it needs
  `apps:storage:publish` and passes `assertTrusted`; a `@me` DELETE needs only `apps:storage`, as any
  delete.
- Rate limits: a `@me` PUT spends the shared-write budget (`DOC_STORE_SHARED_WRITE_BUDGET`: burst 30,
  300 per day per viewer per app); a DELETE spends the `write` bucket.
- Content scan: the shared-write scan runs on `data` and on the **parent only**, not on the derived
  key: the digest is not client text, and scanning random base32 could trip a term list by chance.
  Today the scan is handed the put's key (`moderate` in `doc-store-api.ts`), so this is a change at
  that call.
- Hooks: the hook is called with `op` `put` or `delete` and the derived key, plus one additive request
  field, `parent` (string or null), so a hook can check the parent without parsing the key.
- Schema and `ownedModelVersions`: checked on every PUT, as any put.
- Content levels: a vote is a shared document, so it is `pending` until rated and visible only to its
  author meanwhile (`sharedDocLevelVisible`). A body with no text rates PG (`doc-rater.service.ts`,
  `too-short`), but asynchronously, so a count by listing can lag new votes (Risks).
- Moderation: hide, unhide, delete and the report API apply as to any shared document. A PUT to a key a
  moderator hid answers `404 not_found` (`writeDoc`'s VISIBLE rule), so that viewer cannot re-vote on
  that parent while it is hidden.
- Quotas: each document counts toward the app's shared ceiling and its author's per-viewer ceiling
  (`DEFAULT_DOC_STORE_LIMITS`: 1,000 documents per viewer per app by default, private documents
  included). Marks count toward neither today (Risks, open question 3).
- Imports: through a `readwrite` import a `@me` op runs in the source app as the viewer; the digest
  uses the source app's id, so the viewer reaches the same document as in the source app.
- Account wipe: viewer-keyed documents are user-authored shared documents, so `wipeAccount` deletes
  them as it deletes every authored shared document, and the viewer's `usage_user` row is how the wipe
  finds the namespace.
- Registry export (`registry: "public"`): exported as any document; the key is opaque.

**Errors.** One new code, `removed` (`410`), for the removed routes during their last release
(rollout step 5): added to `StorageApiCode` and `STORAGE_ERROR_STATUS` (`doc-store-api.ts`) and to the SDK's
`StorageErrorCode`, which reports it as "this operation no longer exists" rather than retrying.
Otherwise no new code. New `details.reason` values on `400 invalid_request`: `viewer_keyed`
(a raw-key write, or a create), `parent_required` (`/@me` on a `parent+viewer` collection),
`parent_not_allowed` (`/@me/:parent` on a `viewer` collection), `invalid_parent`; and
`401 sign_in_required` for an anonymous `@me`. Every other refusal is today's error table
(`STORAGE_ERROR_STATUS`).

## What is removed, and what replaces it

### Routes, ops, parameters

| Removed                                                                                             | Where                                | Replacement                                                                                                                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATCH /:c/:key` with `$inc` / `$mark` / `$unmark` (`parseTallyPatch`)                              | `doc-store-api.ts`                   | a viewer-keyed collection (`PUT /:c/@me/:parent`); counters: nothing                                                                               |
| `POST /:c/:key/counters/:name` (deprecated, `LEGACY_TALLY_HEADERS`)                                 | same                                 | as above                                                                                                                                           |
| `PUT` / `DELETE /:c/:key/marks/:name` (deprecated)                                                  | same                                 | `PUT` / `DELETE /:c/@me/:parent`; for `report`, the report API                                                                                     |
| `POST /_publish/:to`, `POST /_unpublish/:to` (`runPublish`, `runUnpublish`, `isPublishRouteServed`) | same                                 | the client reads its private documents and writes shared ones one by one (`put`, `delete`), as the SDK already advises when publish is unavailable |
| list `sort=counter:<n>`, `sort=mark:<n>`, `markedBy=me`, `mark=<n>` (`parseListQuery`, `parseSort`) | `doc-store-api.ts`, `doc-store.ts`   | `author=me` and `keyPrefix` on the viewer-keyed collection; no "top N by count"                                                                    |
| info `counters`, `marks` per collection; `rate.marksAndCountersPerMinute`, `rate.reportsPerDay`     | `presentDeclaration`, `run` (`info`) | `keyedBy`; the report limit is documented with the report API                                                                                      |

### Manifest fields

| Removed                             | Where                                                                                                                                                                                                                                                           | Replacement |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `counters`, `marks` on a collection | `COLLECTION_KEYS`, `parseTallyNames`, `APP_STORAGE_TALLY_NAME_RE`, `APP_STORAGE_MAX_COUNTERS`, `APP_STORAGE_MAX_MARKS`, `APP_STORAGE_BUILTIN_MARKS` in `block-storage.constants.ts`; `public/schemas/app-block/v1.json` and its byte-mirrors in the CLI and SDK | `keyedBy`   |
| `write: "none"`                     | `APP_STORAGE_WRITE_POLICIES` and its cross-field rule                                                                                                                                                                                                           | nothing     |

**These stay parseable forever in approved history.** Approved manifests are replayed for their shape
with every feature on (`APP_STORAGE_ALL_FEATURES_ON`), and `deriveCollectionMajors` skips a manifest
whose storage does not parse, which would shift every later major of the app. So submit refuses them
(a new feature switch, off) while the parser keeps accepting them on replay. `v1.json` marks them
`deprecated` rather than deleting them.

🔴 **A declared `write: "none"` is served read-only, never ignored.** The serving path parses the
approved manifest with every feature on (`declaredStorage` in `doc-store-declared.ts`), and the store
reads an absent policy as `own` (`coll.config.write ?? 'own'` in `assertCollection`). So dropping
`none` from the parsed declaration, or mapping it to "absent", would make the collection writable by
every eligible viewer under `own`: today `live-characters`' `plays` and `custom-generators`' (and its
fork's) `generator_marks`. And refusing `none` in the serving parse would make the whole app's storage
answer `503` (`declaredStorage` refuses an unparseable manifest). Instead the parser keeps `none` as a
policy, and the store keeps refusing every viewer document write to it (create, put, delete, `@me`)
with `403 write_policy`, exactly as `assertShareWritable` does today, after the counter ops are gone,
until an approved version drops the declaration. This branch is **permanent**: step 5 does not remove
it, because restoring an older approved manifest (a rollback) can bring the declaration back. `marks`
and `counters` still declared are inert (their ops answer `410`), which changes no write policy.

### Store code, types and tables

| Removed                                                                                                                                                                                                                               | Notes                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `increment`, `mark`, `unmark`, `stampMarkSeq`, `withMarkHead`, `SQL_TAKE_MARK_SEQ`, the tally and mark SQL, the tally sort and `markedBy` join in `list` (`doc-store.ts`)                                                             | lock order goes back to (1) document, (2) `usage_app`, (3) `usage_user`             |
| `previewPublish`, `publishCopies`, `unpublishCopies`, `readPublishTargets`, `readPublishRows`, `assertPublishKeys`, `assertPublishPair`, `assertNotHooked`, `DOC_STORE_PUBLISH_BOUNDS`, the `Publish*` types                          | `classifyPublish` stays: the free unchanged put (`putIfUnchanged`) uses it          |
| `DocRecord.counters`, `.marks`, `.viewer`; `DocAuthor` `counter`; `DocListQuery.markedBy`, `.mark`; `REPORT_MARK`; `DOC_STORE_BOUNDS.incrementMax`; `AccountWipeNamespaceResult.counterDocsReleased`, `.marks` (`doc-store.types.ts`) |                                                                                     |
| `HookOp` `increment`, `mark`, `unmark`; `Tally` in `apps/storage-hook-runner/src/contract.ts`                                                                                                                                         | hooks keep `create`, `put`, `delete`                                                |
| `DOC_STORE_TALLY_RATE_LIMIT_MAX`, `DOC_STORE_PUBLISH_BUDGET`, buckets `tally` and `publish` (`shared-storage-rate-limit.ts`)                                                                                                          | the `report` bucket moves to the report API, same numbers and key                   |
| `civitai_app_block_doc_store_tally_ops_total` (`recordStorageTallyOp`)                                                                                                                                                                | kept until removal: with `app_storage_requests_total`, it is the zero-usage measure |
| Flipt flag `app-blocks-storage-publish`                                                                                                                                                                                               |                                                                                     |
| Counter documents' special cases: `SQL_WIPE_RELEASE_COUNTER_DOCS`, the rater's `counter` status, "counters you started" in `src/shared/utils/app-storage-usage.ts`                                                                    |                                                                                     |
| `appdata.doc_tally` (with `mark_seq`, `doc_tally_top_idx`)                                                                                                                                                                            | final manual DDL, after usage is zero                                               |
| `appdata.doc_mark` rows other than `report` (the table, its indexes and policies stay)                                                                                                                                                | **kept** as the report store; only its non-report rows are deleted                  |
| `appdata.mark_head`                                                                                                                                                                                                                   | same                                                                                |
| `'counter'` in the `doc_author_kind` CHECK                                                                                                                                                                                            | narrowed once no row has it                                                         |
| `appdata.doc.reports_dismissed_at`                                                                                                                                                                                                    | **kept**: the report API uses it unchanged                                          |

### SDK (`packages/civitai-sdk/src/doc-store` in the app starters repo)

| Removed                                                                                                                   | Replacement                                |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `StorageDocument.counters`, `.marks`, `.viewer`; `DocumentAuthor` `{kind: 'counter'}`                                     | nothing                                    |
| `DocumentListQuery.markedBy`, `.mark`, the `counter:` / `mark:` sorts                                                     | `author: 'me'`, `keyPrefix`                |
| `StorageCollection.update` and its op types (`StorageIncrementOp`, `StorageMarkOp`, `StorageUnmarkOp`, `StorageUpdateOp`) | `getMine`, `putMine`, `deleteMine` (below) |
| `increment`, `mark`, `unmark` (already `@deprecated`)                                                                     | same                                       |
| `publish`, `unpublish`, `StoragePublish*`, the local `publish_unavailable` code                                           | `get` + `put` / `delete`                   |
| `StorageCollectionInfo.counters`, `.marks`; `StorageLimits.rate.marksAndCountersPerMinute`, `.reportsPerDay`              | `StorageCollectionInfo.keyedBy`            |

Added: `collection(c).getMine(parent?)`, `.putMine(data, { parent?, ifVersion? })`,
`.deleteMine({ parent?, ifVersion? })`, a `parentOf(key)` helper, and `app.moderation.report({ collection,
key, from? })`. The SDK's fake (`doc-store/fake.ts`) and local preview implement the same, and the
storage contract (`storage-contract.v1.json`) gains viewer-keyed cases and loses the tally and publish
ones, so the fake and the host stay pinned to one behaviour.

## The report moderation API

**Endpoint.** `POST /api/v1/blocks/moderation/reports`, its own page beside the storage catch-all and,
like it, behind `withBlockScope`:

```json
{ "collection": "records", "key": "01JD3Q8M5Z4X2V7K9C6B1N0RTA", "from": "other-app" }
```

`from` is optional (open question 8). The answer is `200 {"reported": true}`, the same whether or not
the viewer had already reported the document; no count, ever.

**Identity.** (app, namespace) from the verified token, as every storage call; then `collection` and
`key`. Only a declared shared collection is reportable (`collection_not_declared`, or
`invalid_request` for a private one), and only a visible document (`404 not_found` otherwise, as a
`report` mark answers today, `SQL_SHARE_LOCK_DOC`).

**Auth.** The block token, as for the report mark today: a signed-in viewer (`401 sign_in_required`
for an anonymous one), the `apps:storage` scope every app with collections already holds
(consent-exempt), and the shared-write trust gate (`assertTrusted`). No publish scope for a report on
the app's own documents, as today; through an import, today's rule applies (open question 8). A site-session path for host chrome is open question 5.

**Rate limit.** The `report` bucket as today, 20 per viewer per app per day
(`DOC_STORE_REPORT_RATE_LIMIT_MAX`), under the same Redis key shape, so windows in flight carry over at
cutover. The marks-and-counters bucket a report also spends today goes away with that bucket.

**Kept semantics.** A report is one per (document, viewer). It cannot be withdrawn: the API has no
delete (today `refuseReportWithdrawal`). Hooks never see reports (today an exemption in
`requireHookPass` and `gateHook`; after the change, structural). Deleting a document deletes its
reports, as `remove` and the moderator delete delete its marks today.

**Storage and the moderator queue.** Report rows stay where they are: `appdata.doc_mark` rows with
`name = 'report'`, which the report API writes as the `report` mark does today. What changes is that
the write no longer touches `doc_tally` (today `mark` moves a `report` tally that nothing exposes), so
the dropped tally table takes nothing with it. The moderator queue already reads `doc_mark` directly
(`sqlModOpenReported`, `SQL_MOD_HIDDEN_UNREPORTED`, `SQL_MOD_OPEN_REPORTS`), so it is unchanged; only
`SQL_MOD_GET` loses its tally sub-select, and `reportsTotal` in the moderator audit row counts the
document's `report` rows instead of reading the tally. No new table, policy or copy: production holds
0 report rows ("Inventory (2026-11-23)"). Whether `doc_mark` is later renamed to say what it then
holds is open question 13.

**Dismissal.** Unchanged: `reports_dismissed_at` stays on `appdata.doc`; a report counts as open when
made after it.

**What the reporter loses** is "I reported this" in `viewer.marks` (open question 7).

**Account wipe.** Unchanged: the wipe's enumeration (`listAccountNamespaces`) still reads `usage_user`
and `doc_mark`, so a viewer who only reported is still found, and `wipeAccountNamespace` still deletes
their report rows (open question 9), without the tally decrement.

## Data migration

Every step is per app, runs in one (app, namespace) at a time through the store's own transactions
(`withTx`, row-level security bound), is idempotent, and is started by a human. Every DDL change is a
manual-apply SQL file under `src/server/services/apps/migrations/`, applied by hand to each environment
with its rollback file beside it; nothing applies one automatically.

### `doc_mark` votes to viewer-keyed documents

For each (source collection `c`, mark name `m`) the inventory lists, the app ships a manifest version
declaring **one target collection `t` per mark name**, with `keyedBy: "parent+viewer"` (for
model-benchmarking: `votes`, from `records` / `vote`). One target per name because two marks by one
viewer on one document (`dataset-commons`' `up` and `down`) would derive the same key in one
collection; the app may later fold them into one document of its own shape.

**The per-target switch.** Each target `t` has its own switch, off until step 6 below, so
`dataset-commons`' two targets each open only after their own copy and verify. While it is off, `@me`
writes to `t` answer `403 write_policy`, and `GET /` reports the collection with `"open": false`. The
new app version branches on that one field: closed, it reads the old marks on `c` (still presented
during the compatibility window) and shows voting as unavailable; open, it reads and writes `t`. So
reads and writes move together, in one flip, with no second app release. Then, per target, in this
order:

1. **Check keys.** Every source key `k` must fit the parent grammar (no `:`, at most 96 characters).
   `migrateMarksToDocs` takes an optional deterministic key mapping, a table from source key to parent
   supplied by the person running the migration and stored with the run. A key that does not fit is
   mapped through it; if no mapping is given and any key does not fit, the op refuses the whole target
   before writing anything. The check runs as a dry run on every app with marks
   (`playable-collections`, `dataset-commons`, `custom-generators`, `model-benchmarking`) during
   rollout step 1's re-measure, and its result is recorded before any copy. ULIDs (`records` in
   `model-benchmarking`) always fit.
2. **Freeze.** The store refuses `$mark` / `$unmark` of `m` on `c` for that app (`410`), so no mark
   changes after this point.
3. **Copy.** A new maintenance op, `migrateMarksToDocs(appId, ns, { from: c, mark: m, to: t, data,
keyMap? })`, beside `migrateDocuments` (the schema-migration runner). For each `doc_mark` row (c, k,
   m, u, created_at), in primary-key order with a keyset cursor and a batch size, it inserts a document
   at key `<p>:<d(u, p)>`, where `p` is `k` or its mapped parent, with body `data` (a constant the
   person running it gives, checked against `t`'s schema; `{}` for a plain vote), `author_kind =
'user'`, `author_uid = u`, `created_at` = the mark's, `version = 1`, the next `seq`, its index rows,
   and usage charged to `usage_app` and `u`'s `usage_user`. `INSERT ... ON CONFLICT DO NOTHING` on the
   derived key makes a re-run a no-op. It is a platform operation like `migrateDocuments`: no hook,
   trust gate, budget or scan. A mark whose source document is hidden is copied too (the vote existed).
   It runs once, after the freeze, so it reads a set that can no longer change.
4. **Verify,** in the store, by counting rows directly (`doc_mark` rows of (c, m) against `t`
   documents, per parent and per user), never through the list API, which hides documents still
   pending a rating from everyone but their author. A mismatch stops the rollout for that target.
5. **Rate.** With content levels on, run the app's levels backfill (`app-doc-levels-backfill`) so the
   copied documents are rated before anyone reads `t` (otherwise every copied vote is pending, visible
   only to its voter).
6. **Open the switch** for `t`. Only now can a viewer add or delete a vote, so a delete is never undone
   by a copy and a new vote never breaks the verify; and the app's reads move to `t` at the same moment.

**Rollback.** Valid only before step 6. Unfreeze, revert the app to its previous approved version, and
delete `t`'s copied documents with the per-collection purge (a new maintenance op, built in rollout
step 2: `doc-store-purge.ts` has only a viewer and an app purge today) that deletes every document of
one collection in one namespace through the moderator delete path (`deleteLockedSharedDocs`, which
writes tombstones and refunds each document's author, not the caller as the author `remove` does).
`doc_mark` and
`doc_tally` were never written, so nothing needs restoring. After step 6 a rollback would lose every
vote made through `@me`, which were never written to `doc_mark`, so past that point the only way back
is forward: fix the new version.

### `doc_tally`

Mark tallies (`kind = 'mark'`) are derived from `doc_mark` and are dropped, not migrated. Counter
tallies (`kind = 'counter'`) are aggregates with no per-viewer history, so no generic document can be
built from them. The only counter data in production is `playable-collections`' `popular_plays`
`plays` (37 rows summing 64); its replacement is open question 10.

### Counter documents (`write: "none"`, `author_kind = 'counter'`)

Their `data` is always empty and their only content is their counters (above). Production holds 37,
all in `playable-collections`' `popular_plays`. They are deleted by the **per-collection purge**, the
maintenance op built in rollout step 2 for the vote rollback, run on the counter collection in rollout
step 4, per app, after that app's migration. The purge deletes every document of the collection in
one namespace through the moderator delete path (`deleteLockedSharedDocs`), not the author `remove`,
which refuses a `write: "none"` collection and refunds the caller. That path deletes each document's
tally rows and **every** `doc_mark` row on it, `report` rows included, writes tombstones, and refunds
the usage charged to `usage_app` and to the `usage_user` of the viewer whose increment created the
document (`author_uid`; nothing per user when an account wipe already cleared it). The rows it
deletes are dumped first, as the final cleanup's are, and the dump includes any (dismissed) report
rows deleted with their document. It runs only when all of these hold:

- **No increment can re-create a document.** The app's new approved version no longer declares the
  collection's counters, so the store refuses `$inc` on it (`400 invalid_request`, counter no longer
  declared), because the first increment of a counter creates its document (`SQL_INSERT_COUNTER_DOC`).
- **Every mark on the collection has been migrated.** Each of its marks' targets has passed verify
  and has its switch open (steps 3 to 6 above), because deleting a document deletes its marks, and a
  closed target's app still reads them.
- **No report on the collection's documents is open.** An open report is a `report` row newer than
  its document's `reports_dismissed_at`; a moderator resolves every open one first, so the purge
  never deletes a report nobody has looked at.

`playable-collections` is migrated as open question 10 specifies: its `played` marks are copied into
the viewer-keyed `plays` target, and only after that target's switch is open is `popular_plays`
purged. Its play figures restart from the per-user marks migrated there, not from the 64 counted
plays. The final cleanup's CHECK narrowing depends on this purge having left no row with
`author_kind = 'counter'` (below).

### Publish

Nothing to migrate: a published copy is an ordinary shared document authored by its viewer, and stays.
Only the calls go.

### Reports

Nothing to migrate: report rows stay in `doc_mark`, and production has none.

### Final cleanup

After usage is zero (rollout step 5): one manual SQL file that deletes every `doc_mark` row whose
`name` is not `report`, drops `appdata.doc_tally` and `appdata.mark_head`, and narrows
`doc_author_kind`, preceded by a dump of what it deletes, kept for a stated retention. The narrowing
comes last, and only after the file has checked that no `appdata.doc` row has
`author_kind = 'counter'` (it aborts otherwise): such a row means an app's counter documents were not
purged in rollout step 4, and the purge, not this file, deletes them. `doc_mark` and its policies
stay, as the report store. Its rollback re-creates the dropped tables empty; it cannot
restore rows without that dump, which is why it runs last.

## Manifest, schema majors and the SDK

- **Majors.** A major is minted only by a non-additive change of a collection's `schema`
  (`isAdditive`, `deriveCollectionMajors` in `storage-schema-majors.ts`). `keyedBy`, `marks`,
  `counters` and `write` are not part of `schema`, so neither adding `keyedBy` nor dropping `marks`
  bumps a major. That is why `keyedBy` is made immutable at submit instead: a major is the wrong tool
  for a change that reinterprets keys, and a new collection is the right one.
- **Submit.** Adding `marks`, `counters` or `write: "none"` to a collection is refused once the
  replacement ships; a collection that already declares them in the previous approved version may keep
  them until its data is migrated, then drop them.
- **The published schema.** `v1.json` gains `keyedBy` and marks `marks`, `counters` and the `none`
  write policy `deprecated`; the CLI and SDK mirrors are re-vendored (the drift guards pin them).
- **Deprecation headers.** The per-tally routes already send `Deprecation: @1794182400` and a `Link`
  (`LEGACY_TALLY_HEADERS`), with no `Sunset`. Step 3 adds the same `Deprecation` and `Link` to every
  other removed route (the tally `PATCH`, `_publish`, `_unpublish`) and to a list that uses a removed
  parameter. No `Sunset` date is set: removal is gated on measured usage (rollout step 5), not a
  calendar.
- **SDK.** One minor release adds the viewer-keyed methods and the report call and marks every removed
  method and field `@deprecated`; the major release after the routes are removed deletes them.

## Rollout

Each step names what ends it.

1. **Inventory.** Done 2026-11-23 ("Inventory (2026-11-23)"). Re-measured right before step 4, with
   the copy's key check run as a dry run on every app with marks; the results are recorded before any
   copy.
2. **Ship the replacement, dark.** Viewer-keyed collections (parser, store, routes, SDK minor, contract
   cases, the per-target switch), the report API (writing `doc_mark` as today) behind a per-app flag,
   `migrateMarksToDocs`, and the per-collection purge the rollback and the counter-document deletion
   depend on. Ends when the contract suite and the store's PGlite suite are green on `main` with the switches on.
3. **Deprecate.** Submit refuses new tally and publish declarations; `Deprecation` headers on every
   removed route; developer docs updated. Ends when it is deployed.
4. **Migrate the apps with data:** `playable-collections`, `model-benchmarking`, `custom-generators`
   and `dataset-commons` ("Inventory (2026-11-23)"): each one's new manifest version, then per target:
   key check, freeze, copy, verify, rate, open the switch; then, for an app with counter documents
   (`playable-collections`), the per-collection purge of its counter collection ("Counter
   documents"), once a moderator has resolved every open report on that collection's documents. The
   other apps that declare tallies hold none and only change their manifests. Ends
   per target when its switch is open and its old calls stop, and per app when none of its
   documents has `author_kind = 'counter'`, removed by a purge that ran with no open report on them.
5. **Remove when usage is zero for 7 days.** Zero means: `civitai_app_block_doc_store_tally_ops_total`
   flat (it has no app label), `app_storage_requests_total{op}` flat for `increment`, `mark`, `unmark`,
   `patch`, `publish` and `unpublish` (its `app` label names the app; `recordAppStorageRequest`), and no
   non-report `doc_mark` or `doc_tally` row written, **and** no app's approved manifest head still
   declares `write: "none"`, `marks` or `counters` (read from the enforced manifests, as the inventory
   did), so removing the code changes no live collection's meaning. Then the removed routes answer
   `410` (code `removed`, linking the guide) for one release and leave the route table after it; the code, types,
   SDK surface (major release) and Flipt flag go; the final cleanup SQL runs. Seven days and no longer
   because the inventory shows four apps with data and about 56 marks and 37 counter documents, all
   migrated or purged by step 4, so the window only has to cover clients still on an old app version.

## Registry and app-data-go impact

`apps/app-data-go/WRITES-DESIGN.md` simplifies:

- **Level streams carry plain documents:** `key`, `data`, `version`, `createdAt`, `updatedAt`, `seq`.
  No `tallies`, so a vote is a document change on the votes collection's own stream, ordered by `seq`
  like every write.
- **One sequence.** No mark sequence, no `mark_head`, no `meta.head.markSeq`, no `minMarkSeq` floor, and
  no count or held overlays: the record overlay at `seq` covers a vote as it covers any put. The lock
  order loses (1b) and (1c). The "Accepted" note that the mark head discloses report volume no longer
  applies: reports are no longer storage ops.
- **No `doc_tally` scan.** The mark-sequence range read over `doc_tally.mark_seq`, which no index covers,
  disappears.
- **The per-viewer stream** carries only the viewer's authored keys and their own documents no level
  stream gives them. Their votes are their own documents, so "viewer marks" need no stream of their
  own, and the `level: counters` stream has nothing to carry.
- **Writes service API:** the `PATCH` (`$inc`, `$mark`, `$unmark`) and `publish` / `unpublish` routes
  leave; `PUT` / `DELETE .../records/@me[/:parent]` join.
- **What does not get simpler:** counts come from listing, on the streams as on REST, and a votes
  collection can outgrow a level stream's bound (2,500 records by default in #10165) long before its
  board does. A board of thousands of items needs the later aggregate decision; this plan adds no
  exception to "reads stay on the streams".

Disposition of the work already done:

| Work                                                                             | State        | Becomes unused                                                                                                                                                  | Recommended                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #10165, adapter level streams                                                    | open, paused | `tallies` on entities, `meta.head.markSeq`, the `counters` level, `feedMarkHead`, `privateMarkHead`, `levelTallyKeys` and the mark-range poll, `presentTallies` | revise before it resumes: strip the mark half, keep level streams, `seq` heads, routing, bindings and the bound                                                                                                                |
| #10130, the mark sequence and `mark_head` migration                              | merged, dark | all of it: `mark_head`, `doc_tally.mark_seq`, `SQL_TAKE_MARK_SEQ`, `withMarkHead`, lock (1c)                                                                    | keep dark (its probe makes it inert where the migration is absent); do not apply the migration to an environment that has not applied it; remove the code with the tally ops in step 5 and drop the table in the final cleanup |
| #10128, `seq` and `recordId` in write answers; the private feed's `seq` and head | merged       | nothing                                                                                                                                                         | keep: the record overlay and floors need it                                                                                                                                                                                    |
| #10142, the signed internal route (answers `seq`, `recordId`, `markSeq`)         | merged, dark | `markSeq` in tally answers                                                                                                                                      | keep; `markSeq` goes with the tally ops in step 5                                                                                                                                                                              |
| #10143, app-data-go write routes                                                 | merged, dark | the `PATCH` operator forwarding (`patchOp` in `internal/writes/writes.go`); it never built `publish` / `unpublish` forwarding                                   | remove now if model-benchmarking's votes are migrated before its app-data-go cutover (recommended order); otherwise keep dark until its migration                                                                              |
| #10158, read-your-writes overlay                                                 | merged, dark | nothing: it ships record overlays only, and lists marks overlays and the mark floor as not built                                                                | keep                                                                                                                                                                                                                           |

## Risks

- **Votes become content.** A vote is now a shared document write, so it needs the
  `apps:storage:publish` scope (a consent prompt for users who have not granted it in that app), passes
  the trust gate, goes through the shared-write content scan, and spends the shared-write budget
  (burst 30, 300 per viewer per app per day) instead of the tally bucket (30 a minute, no daily cap). A
  heavy voter can hit limits a mark never hit (open question 4).
- **Quota.** Votes count toward the per-viewer ceiling (1,000 documents per app by default, private
  documents included) and the app's 1M-document ceiling. At today's volume nobody is near either
  ("Inventory (2026-11-23)").
- **Counts lag rating.** With content levels on, a new vote is pending until the rater job reaches it,
  so others' counts trail. The migration avoids a cliff by rating before the switch; steady state lags
  by the job's cadence.
- **Counting by listing costs.** An app counts an item's votes by listing the collection with
  `keyPrefix=<parent>:`, at most 100 per page, so a board costs one list request per item shown, plus
  one extra page for every further 100 votes on an item. Sort by count is not available. That is
  cheap at today's volume (the busiest item set in production holds 43 marks). The practical limit is
  a board page of about 50 items (about 50 list requests per page view), or any item with more than
  100 votes (one more page per further 100). **Trigger:** before migrating any app whose boards exceed that limit,
  revisit the aggregate decision for it. Until then the decision stands: no server-side aggregates.
- **Orphans.** Deleting a record leaves its votes, still charged to their voters (open question 2).
- **History replay.** Removing `marks` / `counters` from the parser outright would make old approved
  manifests fail to parse and shift every later major; they must stay parseable (see "Manifest
  fields").
- **Derivation key loss or leak.** Losing it orphans every viewer-keyed document from its `@me` routes;
  leaking it lets the holder link documents to user ids. Neither grants a write (open question 1).
- **Migration ordering.** The freeze precedes the one copy, and each target's switch opens only after
  its verify, so neither an old client's mark nor a new `@me` vote can land between them.
- **A `write: "none"` collection read as `own`** would be writable by every viewer; the store serves it
  read-only, permanently ("Manifest fields").

## Open questions

**Settled since the first draft** (no longer open):

- **No server-side aggregates.** No count read, no sum, no sort by count: apps count by listing the
  collection with `keyPrefix=<parent>:`. A generic aggregate is a separate, later decision, revisited
  only at the limit and trigger in Risks ("Counting by listing costs"). The count read and the
  WRITES-DESIGN exception it implied are dropped.
- **The key digest is keyed (HMAC)** per (collection, parent), not a stable per-app handle and not an
  unkeyed hash.
- **Report rows stay in `doc_mark`** (`name = 'report'`); no new table.
- **Removal:** zero usage for 7 days and no approved manifest head still declaring `write: "none"`,
  `marks` or `counters`, then `410 removed` for one release.

Each question below has a proposed default, which applies unless it is overruled before the step that
needs it.

1. **Rotating the derivation key.** Proposed: never rotated; it guards unlinkability only. Rotation, if
   ever needed, is a re-key migration of every viewer-keyed collection.
2. **Parent integrity.** Proposed: no existence check on write and no cascade on the parent's delete in
   v1; an app filters orphans, and a viewer can list (`author=me`) and delete their own.
3. **Do viewer-keyed documents count toward the per-viewer ceiling?** Proposed: yes, like every
   document. At today's volume no user comes near it ("Inventory (2026-11-23)").
4. **Publish scope, content scan and shared-write budget for votes.** The cost: a vote needs the
   `apps:storage:publish` consent (a prompt for users who have not granted it), is scanned, and spends
   the shared-write budget (300 per viewer per app per day) instead of the tally bucket (30 a minute).
   Proposed: unchanged (platform policies stay).
5. **A site-session report path for host chrome** (a report button outside the app's frame).
   Proposed: not in v1; block token only.
6. **A `reason` on reports.** Proposed: none in v1 (today's mark takes none, and free text would need
   its own scan); the column stays nullable.
7. **The reporter's own "reported" state** (today `report` in `viewer.marks`). Proposed: not exposed;
   the API answers `{reported: true}` idempotently and an app keeps local state.
8. **Reports through imports (`from`).** Proposed: today's rule, unchanged. A report through an
   import is an authoring op (`importOpOf`), so it needs a `readwrite` import and the viewer's
   `apps:storage:publish` grant in the source (`assertImportTallyPublishScope`), and is filed against
   the source app's document. A read-only import cannot report.
9. **A reporter's account wipe.** Proposed: their reports are deleted, as today.
10. **`playable-collections`' replacement shape** (`popular_plays`: `write: "none"`, mark `played`,
    counter `plays`, the only counter data in production). Proposed: a viewer-keyed `plays`
    collection, `keyedBy: "parent+viewer"`, where the parent is the played item's key and each
    document is `{ "count": n }`, which that viewer raises with `PUT .../@me/<item>` and
    `ifVersion`. The 43 `played` marks become those documents with `count: 1`. An item's "played by"
    figure and its play total (the sum of `count`) are both computed by the app from a listing of
    `keyPrefix=<item>:`; there is no server-side count or sum. The 64-play counter total cannot be
    split by viewer, so it is dropped: the app's figures restart from the migrated players (43
    `played` marks), not from the 64 counted plays, and `popular_plays`' counter documents are then
    purged ("Counter documents"). The alternative, one document per play, is unbounded and spends a
    viewer's document ceiling per play.
11. **Quota during the vote copy.** Proposed: charged but never refused; users left over their ceiling
    are reported, not trimmed.
12. **Vote documents' body in the copy.** Proposed: `{}`, with an app able to name another constant
    body that its target schema accepts.
13. **Renaming `doc_mark`** once it holds only reports. Proposed: not now; revisit after the final
    cleanup, as its own manual migration.

## Inventory (2026-11-23)

Measured read-only in production on 2026-11-23. Apps are named by slug only.

**Apps.** 18 apps declare storage, all approved; none has a pending publish request. Only two declare
imports (`app-storage-demo-fork`, `custom-generators-fork`), and both hold no data.

**Declared tallies.** No app declares `report` as a mark (it is built in).

| App (slug)                         | Collection          | Marks        | Counters | `write: "none"` |
| ---------------------------------- | ------------------- | ------------ | -------- | --------------- |
| `app-requests`                     | `requests`          | `vote`       |          |                 |
| `custom-generators` (and its fork) | `records`           | `vote`       |          |                 |
| `custom-generators` (and its fork) | `generator_marks`   | `downvote`   | `anchor` | yes             |
| `dataset-commons`                  | `datasets`, `items` | `up`, `down` |          |                 |
| `live-characters`                  | `plays`             |              | `plays`  | yes             |
| `lora-matrix-tester`               | `grids`             | `vote`       |          |                 |
| `model-benchmarking`               | `records`           | `vote`       |          |                 |
| `one-click-workflows`              | `community_recipes` | `vote`       | `runs`   |                 |
| `playable-collections`             | `popular_plays`     | `played`     | `plays`  | yes             |
| `strength-finder`                  | `picks`             | `vote`       |          |                 |
| `yt-thumbnail`                     | `formats`           | `vote`       |          |                 |

**Stored data.** 512 documents in total. 56 mark rows from 18 distinct users; **0 `report` marks**.
`mark_head` is empty.

| App (slug)             | Collection      | Primitive         | Name     | Rows                  | Distinct users | Last write                          |
| ---------------------- | --------------- | ----------------- | -------- | --------------------- | -------------- | ----------------------------------- |
| `playable-collections` | `popular_plays` | mark              | `played` | 43                    | 14             | 2026-11-22 (35 in the last 30 days) |
| `model-benchmarking`   | `records`       | mark              | `vote`   | 8                     | 4              | 2026-11-15                          |
| `dataset-commons`      | `items`         | mark              | `up`     | 4                     | 1              | 2026-10-21                          |
| `custom-generators`    | `records`       | mark              | `vote`   | 1                     | 1              | 2026-11-22                          |
| `playable-collections` | `popular_plays` | counter           | `plays`  | 37 tally rows, sum 64 |                | 2026-11-22                          |
| `playable-collections` | `popular_plays` | counter documents |          | 37 (all of them)      |                | 2026-11-22                          |

Every other declared mark and counter holds 0 rows.

**Publish.** Publish was never observed in use.

**Calls.** Over the tally metric's life so far (about 7 to 14 days): `inc` 21, `mark` 21, `unmark` 0,
all on the deprecated per-tally routes, none on `PATCH`.

### What the inventory means for the plan

- **The migration volume is tiny:** about 56 mark rows and 37 counter documents (37 counter tally
  rows) across four apps. No per-user quota question arises at this size.
- **`report` has no existing rows to migrate,** and with report rows staying in `doc_mark` there is
  nothing to copy.
- **Publish has no users to migrate;** removing it touches no app's data.
- **`playable-collections` is the binding case:** the only clearly live user, and the only app using
  marks, counters and `write: "none"` counter documents together, on one collection whose keys are
  not documents anyone authored. Its replacement shape is open question 10.
- **The vote apps** (`model-benchmarking`, `custom-generators`, `dataset-commons`) carry 13 mark rows
  between them and follow the vote copy as written. The other declared-but-empty marks and counters
  only need their manifests changed.
