---
paths:
  - "**/*scan*"
  - "**/*label-store*"
  - "**/label-store/**"
  - "**/*label_store*/**"
  - "**/*appeal*"
  - "**/*moderat*"
  - "**/creator-shop-label*"
---

# Label store

A feature where a person or a model judges content (a moderator decision, a vote, an appeal outcome,
a scanner or pipeline verdict) records it in the `label_store` schema through
`label_store.record_label` / `record_prediction`. Do not add a per-feature table of labels or decisions;
queue tables (claims, quotas, leases) stay with the feature. How to call it: `docs/features/label-store.md`.

Pipelines submit predictions through `POST /api/mod/label-store/predictions` (moderator grant
`labelStore.submitPrediction`), never a DB login. A new routine in `label_store` needs its own
`REVOKE EXECUTE ... FROM PUBLIC`: schema default privileges cannot remove the PUBLIC default.
