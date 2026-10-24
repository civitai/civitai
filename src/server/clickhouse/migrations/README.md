# ClickHouse migrations — how to apply one without shipping a dead feature

These are applied **manually**. Nothing auto-runs DDL here (same policy as the Postgres
migrations).

## 🔴 This applies to EVERY enum column the tracker writes, not just `actions.type`

The rest of this file is written around `actions.type` because that is where the trap was
first measured. **The mechanism is not specific to that column**, and reading it as if it
were is what let three other columns drift unnoticed until 2026-09-07:

| column               | missing value(s)             | found                                            |
| -------------------- | ---------------------------- | ------------------------------------------------ |
| `reactions.nsfw`     | `Blocked`                    | 7 of 10 rejections in a 2h38m window, real users |
| `reports.reason`     | `Spam`, `StickerPlacement`   | same sweep                                       |
| `reactions.type`     | `Post_Create`, `Post_Delete` | same sweep                                       |
| `reports.entityType` | `challenge` + 3 more         | while writing the guard below                    |

`__tests__/tracker-enum-drift.test.ts` now checks each of those columns against its
app-side domain, and enforces the same `POST-APPLY:` marker on any migration that widens
one. `2026-09-07-reaction-report-enum-widening.sql` is the worked example — read its
section 3/4 pair before widening `reactions.type` again: that column has a dependent
materialized view whose scoring list must be widened in the same operation, and applying
one without the other turns dropped rows into wrongly-signed rows.

## 🔴 Widening `actions.type` is a TWO-STEP operation. The `ALTER` alone is inert.

**Apply the DDL, then restart the tracker.** Skipping the restart ships a feature that
collects **zero rows** while every signal you would normally check says it worked.

This is not hypothetical. It has happened **twice**, and both times the migration itself was
correct:

| type                 | migration                                  | rows collected before a tracker restart |
| -------------------- | ------------------------------------------ | --------------------------------------- |
| `Announcement_Click` | `2026-09-04-announcement-click-action.sql` | **0**, for ~2.5 days                    |
| `App_Open`           | `2026-09-05-app-open-action.sql`           | **0**, until caught manually            |

`Announcement_Click`'s first row _in the type's entire history_ landed ten minutes after an
unrelated tracker restart on 2026-09-07 — 253 rows across 170 real users followed within the
day. For the 2.5 days before that, every dashboard over it read a clean, correct-looking zero.

### Why the existing "apply the DDL first" rule does not cover this

Each of these migration headers already says _"apply this BEFORE the app code that emits the
value is deployed"_, and both migrations obeyed it. **That rule is necessary and insufficient**,
because it addresses the wrong actor.

`civitai-clickhouse-tracker` builds its column serializers from the schema it reads **when its
pods connect**, and never re-reads them. A value added to the enum after those pods booted is
rejected **client-side**, inside the tracker, before ClickHouse is ever asked. So:

- the DDL verifies perfectly — the server-side enum really does carry the value;
- the app logs nothing — the tracker POST is fire-and-forget and returns success;
- the tracker's rejection is a single `warn` line in a service nobody tails;
- and the metric reads `0`, which is indistinguishable from "nobody did this yet".

Deploy ordering cannot fix a cache that predates both the DDL _and_ the deploy.

### The steps

```bash
# 1. Apply the DDL (metadata-only when appending at an unused index — no data rewrite).

# 2. Restart the tracker so it re-reads the schema. ONE POD AT A TIME; NATS buffers.
#    🔴 `kubectl rollout restart` does NOT work here — the deployment is Flux-managed
#    (kustomize-controller owns it) and force server-side apply strips `restartedAt`.
#    Delete the pods instead.
kubectl get pods -n civitai-clickhouse-tracker
kubectl delete pod <pod-1> -n civitai-clickhouse-tracker   # wait for Ready before the next
kubectl delete pod <pod-2> -n civitai-clickhouse-tracker

# 3. Confirm with a REAL event — not with the DDL, and not with a bare zero.
#    Trigger the action, then assert BOTH halves:
#      a) the tracker's flush line reads  poison=0 dlq=0
#      b) the row is queryable
kubectl logs -n civitai-clickhouse-tracker <pod> --since=5m | grep 'Flush actions'
#    then, against ClickHouse:
#      SELECT count() FROM default.actions WHERE type='<NewType>' AND time > now() - INTERVAL 1 HOUR
```

🔴 **`poison=0` immediately after a restart proves nothing** — it only says no _rejectable_ row
was in that batch. Wait for an actual attempt of the new type, or the green is vacuous.

### Detecting it retroactively

If you suspect a type has been silently dropping, compare the earliest row it ever produced
against when its migration was applied:

```sql
SELECT min(time) FROM default.actions WHERE type = '<TheType>';
```

**If that timestamp post-dates a tracker restart rather than the migration, this trap ate
everything in between.** A `min(time)` of far-future-relative-to-the-migration is the signature.

## The `POST-APPLY:` marker is enforced

Every migration that widens `actions.type`, or any of the `reactions`/`reports` enum columns
listed at the top of this file, must carry this line verbatim:

```
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.
```

`__tests__/action-type-enum-drift.test.ts` and `__tests__/tracker-enum-drift.test.ts` fail
without it — they pin the same constant. It is pinned as an exact string
rather than matched loosely on purpose: a guard that accepts any sentence mentioning "restart"
is walkable by rewording, and the whole point is that the next person copying an existing
migration inherits the step rather than inheriting only the parts that look important.

Reword it and the test goes red — that is the intended cost of a machine-checkable claim. If
the wording genuinely must change, change it in the test constant and here in the same commit.
