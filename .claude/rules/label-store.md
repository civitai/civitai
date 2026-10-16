---
paths:
  - "**/*scan*"
  - "**/*label*"
  - "**/*appeal*"
  - "**/*moderat*"
---

# Label store

A feature where a person or a model judges content (a moderator decision, a vote, an appeal outcome,
a scanner or pipeline verdict) records it in the `label_store` schema through
`label_store.record_label` / `record_prediction`. Do not add a per-feature table of labels or decisions;
queue tables (claims, quotas, leases) stay with the feature. How to call it: `docs/features/label-store.md`.
