# Label store

One record of every moderation judgement, from people and from models, in the Postgres schema
`label_store`. The moderation pipelines train from it and write their predictions into it.

**The rule:** any feature where a person or a model judges content writes through the store's
functions. Do not add a per-feature label table. Queue tables (claims, quotas, leases) stay with the
feature.

Migrations: `packages/civitai-db-schema/prisma/migrations/20261103120000_label_store/`, then
`20261124120000_label_store_attach_bytes/`. The schema sits
outside Prisma (the drift guard reads `public` only), so there is no Prisma model; call it with raw SQL.

## Tables

| Table | One row per | Notes |
|---|---|---|
| `subject` | distinct input judged | `subjectType` + `subjectId` (site id as text) + `contentHash`. No FK to site tables, so judgements outlive the content. Holds a snapshot of the input, a pointer to retained bytes, and a keyed owner hash for erasure. |
| `label` | human judgement | Never updated; deleted only with its subject. `labellerRef` is a keyed hash of the person, never a raw user id. |
| `prediction` | model output | Kept apart from labels. `modelRef` (model@version), per-class `scores`, `versions` (policy, threshold, preprocessing), `inputHash` of exactly what the model saw. |
| `consensus` | (subject, question) with human labels | Each person counted once, latest answer. Only moderator and knight labels count; appeal outcomes do not. A tie for the top answer gives no outcome. `trainable` when the question's `rule` is met and the subject is not excluded. `modelAgrees` compares the latest prediction. |
| `rule` | question version | Minimum human labels and whether they must be unanimous. A question with no rule never becomes trainable. |
| `change` | change a reader must apply | `label`, `prediction`, `consensus`, `subject` (bytes or a missing field changed), `exclusion`, `deletion`. Ordered by (`txid`, `id`). |
| `erased_subject`, `erased_owner` | erased subject or owner | Tombstones: recording anything for one raises (site paths log it to `record_failure`). |
| `record_failure` | judgement that could not be recorded | The count to watch. |

A **question** names what was asked and keeps different scales apart: `image.block` (block / clear) is
a different question from a rating question. Bump `questionVersion` when a question or its options
change.

## Writing

| Function | For | On bad input |
|---|---|---|
| `record_label(...)` | site code recording a human judgement | logs to `record_failure` and returns NULL; does not raise on bad input |
| `record_prediction(...)` | site code recording a model output | same |
| `submit_prediction(...)` | the authenticated prediction endpoint, on behalf of pipelines | raises |
| `submit_predictions(p_items)` | the endpoint's batch: a JSON array of `submit_prediction` arguments | refuses per item, never the batch |
| `attach_bytes(p_subject_type, p_subject_id, p_content_hash, p_bytes_ref, p_expire_at)` | pointing a subject at bytes the site keeps (no expiry when `p_expire_at` is NULL) | sets the pointer once, only on the subject with that exact `p_content_hash`; returns false (nothing changed) for an excluded subject, one that already has a pointer, or no such subject; raises on store errors |
| `exclude(p_subject_type, p_subject_id, p_reason)` | taking an item out of training | `erasure` deletes it; `safety`, `removed` and `retention` keep the judgements and drop snapshot, pHash and bytes pointer |
| `erase_owner(p_user_id)` | a user's erasure request | deletes every subject the user owns and tombstones the owner; not called on account deletion |

The nightly `appeal-decision-records` job (`sweepLabelStore`) excludes images by the same rule it applies
to appeal records; scan flags, votes and pipeline predictions also check it when they land. An image is
excluded when it, or another image sharing its stored file, matches. Deleting an appeal record takes its
image out too. The same job excludes a `model_text` subject as `removed` once its model is deleted (soft or hard),
so the owner's text goes and the judgements stay; in batches.

The functions belong to the owner of the site tables; site code that calls them directly connects as
that owner.

Pass people as user ids (`p_labeller_user_id`, `p_owner_user_id`); the store hashes them. Give every
call a `p_source_ref` that is unique to the source row: a retry with the same ref records nothing.

Wired today by triggers: scan label flags (predictions) and votes (labels), image appeal decisions, and
scan label byte copies and withdrawals. `CALL label_store.backfill_batches()` replays those source tables,
committing every 25 rows; `backfill()` does it in one transaction, for tests. Both are idempotent. A
scan flag, vote or pipeline prediction on an image the site already excludes is recorded and excluded at
once; appeal decisions are refused upstream for such images, and direct `record_*` calls wait for the
nightly sweep.

Wired today from site code: moderator rulings on text-scan `minor` and `poi` flags on models
(`src/server/services/text-scan/label-capture.ts`), recorded by the flag writer in the ruling's own
transaction under a savepoint. Subject `model_text` with `subjectId` = the model id and `contentHash` = the hash of the scanned text
the ruling covers, with that text as the snapshot while it is unchanged; family `text_scan`, questions
`text_scan.model.minor` / `text_scan.model.poi`, values `flag` / `clear`; a ruling on the owner's appeal is
kind `appeal`. The ref is `TextScanRuling:Model:<id>:<label>:<kind>:<value>:<textHash>:<labeller hash>`,
so a retried ruling records nothing. These questions have no `rule` row yet, so they never become
trainable.

Also wired from site code: moderator verdicts on Creator Shop listings
(`src/server/services/creator-shop-labels.service.ts`), recorded in the verdict's own transaction, after
its write, under the same savepoint helper (`recordUnderSavepoint` in `label-store.service.ts`). Subject `shop_cosmetic`, `shop_pack` or
`shop_mystery_pack`, `subjectId` = the listing id, `contentHash` = sha256 of the judged art and text
(artwork storage key, title, description; a pack's cover and members; a mystery pack's reviewed edit):
price is in the snapshot, not the hash. Family `creator_shop`; question `creator_shop.listing.review`
(`approve`, `request_changes`, `reject`, `revert`) or `creator_shop.listing.takedown` (`takedown`); the
moderator's note is the `reasonNote`. `attach_bytes` points the subject at the artwork
(`cf-image:<key>`, no expiry). The ref is `CreatorShopReview:<listingId>:<history entry at>:<value>`
(`CreatorShopTakedown:<listingId>:<at>`), shared with the temporary backfill endpoint
`POST /api/admin/temp/creator-shop-label-backfill` (deleted after the production run), which records past verdicts from each listing's review history. Listings reviewed before that history
existed get one label inferred from their status, ref `CreatorShopReviewInferred:…` and `inferred: true`
in the snapshot; filter them out by ref prefix. A deleted listing is excluded as `removed`; a takedown is
not excluded. No `rule` rows yet.

Also wired from site code: Knights of New Order rating votes (`apps/knights/src/lib/server/conversion/labels.ts`), written
by the tick once graded, never for a held player. One `knight` label per vote: subject `image`
(`contentHash` = hash of the image url), family `knights`, the Knights question key and version (`knights.image.nsfwLevel`),
the chosen option as the value, ref `KnightsVote:<itemId>:<labeller hash>`. Each choice question gets a `rule` row
(`minHuman` = its `votesToResolve`, not unanimous). Yes/no answers are written by the same pass, as given rather than when
graded, one `knight` label per answer: subject `image`, question `knights.yesno.<producer question id>`, value `yes` or `no`, ref
`KnightsYesNoVote:<producer question id>:<labeller hash>`. Each answered question gets its own `rule` row (`minHuman` = the axis
question's `votesToResolve`, not unanimous), so the store's `consensus` computes its majority.

Pipelines submit predictions to `POST /api/mod/label-store/predictions` as a moderator holding the
moderator-app permission `labelStore.submitPrediction`. Images only, up to 500 per call; each comes back
recorded, a duplicate, or rejected with a reason. The ref is stored as `pipeline:<sourceRef>` under family
`pipeline`, so it never collides with a site producer's. The endpoint's reference is on `/moderator/api`.

```sql
SELECT label_store.record_label(
  p_subject_type => 'model_text', p_subject_id => '123', p_content_hash => label_store.text_hash($text),
  p_family => 'my_feature', p_question => 'my_feature.question', p_value => $answer,
  p_labeller_kind => 'moderator', p_labeller_user_id => $modId,
  p_source_ref => 'MyFeatureDecision:' || $decisionId, p_labelled_at => now(),
  p_snapshot => jsonb_build_object('text', $text), p_owner_user_id => $ownerId
);
```

## Reading

Readers get a role that can select five views and nothing else: `labels_feed`, `predictions_feed`,
`changes_feed`, `training_examples` (trainable subjects with outcome and bytes pointer) and
`pipeline_failures` (trainable subjects the model got wrong). Pull `changes_feed` by
`("txid", "id") > (cursor)` in that order, and apply each row to keep a copy of the labels, predictions and
trainable examples. The view holds back rows of transactions still running, so a cursor never skips one;
a long transaction on the primary delays the feed until it ends.

The reader role is created outside this repo; the migration's grant block is re-run once it exists.
There is no writer role: predictions come in through an authenticated site endpoint.
