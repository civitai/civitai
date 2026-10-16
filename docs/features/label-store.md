# Label store

One record of every moderation judgement, from people and from models, in the Postgres schema
`label_store`. The moderation pipelines train from it and write their predictions into it.

**The rule:** any feature where a person or a model judges content writes through the store's
functions. Do not add a per-feature label table. Queue tables (claims, quotas, leases) stay with the
feature.

Migration: `packages/civitai-db-schema/prisma/migrations/20261101120000_label_store/`. The schema sits
outside Prisma (the drift guard reads `public` only), so there is no Prisma model; call it with raw SQL.

## Tables

| Table | One row per | Notes |
|---|---|---|
| `subject` | distinct input judged | `subjectType` + `subjectId` (site id as text) + `contentHash`. No FK to site tables, so judgements outlive the content. Holds a snapshot of the input, a pointer to retained bytes, and a keyed owner hash for erasure. |
| `label` | human judgement | Append-only. `labellerRef` is a keyed hash of the person, never a raw user id. |
| `prediction` | model output | Kept apart from labels. `modelRef` (model@version), per-class `scores`, `versions` (policy, threshold, preprocessing), `inputHash` of exactly what the model saw. |
| `consensus` | (subject, question) with human labels | Each person counted once, latest answer. `trainable` when the question's `rule` is met and the subject is not excluded. `modelAgrees` compares the latest prediction. |
| `rule` | question version | Minimum human labels and whether they must be unanimous. A question with no rule never becomes trainable. |
| `change` | change a reader must apply | `label`, `prediction`, `consensus`, `exclusion`, `deletion`, in id order. |
| `record_failure` | judgement that could not be recorded | The count to watch. |

A **question** names what was asked and keeps different scales apart: `image.block` (block / clear) is
a different question from a rating question. Bump `questionVersion` when a question or its options
change.

## Writing

| Function | For | On bad input |
|---|---|---|
| `record_label(...)` | site code recording a human judgement | logs to `record_failure`, returns NULL; never fails the caller's write |
| `record_prediction(...)` | site code recording a model output | same |
| `submit_prediction(...)` | pipelines, through the writer role | raises |
| `exclude(subjectType, subjectId, reason)` | taking an item out of training | `erasure` deletes it; other reasons keep the judgements and drop the content |
| `erase_owner(userId)` | user erasure | deletes every subject the user owns |

Pass people as user ids (`p_labeller_user_id`, `p_owner_user_id`); the store hashes them. Give every
call a `p_source_ref` that is unique to the source row: a retry with the same ref records nothing.

Wired today by triggers: scan label flags (predictions) and votes (labels), image appeal decisions, and
scan label byte copies and withdrawals. `label_store.backfill()` replays those source tables and is
idempotent.

```sql
SELECT label_store.record_label(
  p_subject_type => 'model_text', p_subject_id => '123', p_content_hash => label_store.text_hash($text),
  p_family => 'text_scan', p_question => 'model_text.minor', p_value => 'keep',
  p_labeller_kind => 'moderator', p_labeller_user_id => $modId,
  p_source_ref => 'TextScanDecision:' || $decisionId, p_labelled_at => now(),
  p_snapshot => jsonb_build_object('text', $text), p_owner_user_id => $ownerId
);
```

## Reading

Readers get a role that can select five views and nothing else: `labels_feed`, `predictions_feed`,
`changes_feed`, `training_examples` (trainable subjects with outcome and bytes pointer) and
`pipeline_failures` (trainable subjects the model got wrong). Pull `changes_feed` by `id > cursor` and
apply each row in order to mirror the store.

The reader and writer roles are created outside this repo; the migration's grant block is re-run once
they exist.
