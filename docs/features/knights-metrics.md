# Knights metrics

Moved from `apps/knights/CLAUDE.md`. Code: `apps/knights/src/lib/server/metrics.ts`, `apps/knights/src/lib/server/metrics/gauges.ts`, `apps/knights/src/routes/metrics`.

`GET /metrics` (`src/routes/metrics`) serves Prometheus text to in-cluster scrapes only. Definitions: `src/lib/server/metrics.ts`
(counters, own `prom-client` registry plus the default `process_*`/`nodejs_*` metrics) and `src/lib/server/metrics/gauges.ts`.
Labels are bounded enums, never user, image or item ids; an unexpected value is counted as `other`. Every counter
series is pre-declared, so it exports 0 before its first event. Counters are incremented where the event is written,
some inside a transaction, so a transaction that rolls back after that point can overcount by one.

| Metric                               | Labels                                                                                                               | Meaning                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `knights_votes_total`                | `kind`: rating, yesno, hidden_check                                                                                  | Votes written to the ledger (`insertVote`)                                                                                                    |
| `knights_gold_earned_total`          | `source`: vote, hidden_check, streak_bonus, acolyte_level                                                            | Gold moved to earned: settled correct votes, graded hidden checks, Watch streak bonuses, Acolyte level gold                                   |
| `knights_gold_spent_total`           | `item_kind`: buzz_pack, cosmetic, membership                                                                         | Gold reserved by new shop purchases (a purchase that fails later gives it back)                                                               |
| `knights_shop_purchases_total`       | `item_kind`; `outcome`: granted, pending, failed                                                                     | New purchases by the first answer the buyer got (replays and refusals are not counted)                                                        |
| `knights_buzz_grants_total`          | `outcome`: paid, failed, retry                                                                                       | Buzz grant attempts behind a shop Buzz pack (`settleConversion`, at purchase and on the tick's retries); retry = Buzz did not confirm         |
| `knights_escalations_total`          | `reason`: next-stage, expired, blocked, pushed-down, no-consensus, level-moved, moderator-locked, attempts-exhausted | Items handed to the next stage, or to the Inquisitors with the stored reason; expired = an unvoted item closed instead (`reason = 'expired'`) |
| `knights_items_resolved_total`       | `stage`: Knight, Templar, Paladin                                                                                    | Items resolved by a stage consensus                                                                                                           |
| `knights_hidden_checks_graded_total` | `verdict`: correct, failed, inconclusive                                                                             | Hidden checks graded                                                                                                                          |
| `knights_smites_total`               |                                                                                                                      | Smites issued                                                                                                                                 |
| `knights_career_resets_total`        | `trigger`: smites, restart                                                                                           | Career resets: done in the main app after the smite limit, or the player's own restart                                                        |
| `knights_joins_total`                |                                                                                                                      | Players who joined                                                                                                                            |
| `knights_rank_ups_total`             | `rank`: Knight, Templar, Paladin                                                                                     | Rank-ups: the apprenticeship's promotion to Knight, and rank-ups from settled votes                                                           |
| `knights_notifications_sent_total`   | `kind`: verdicts, streak, new-images                                                                                 | Daily-loop notifications the notifications app accepted, per player; alert on no increase in 26h                                              |
| `knights_unhandled_errors_total`     |                                                                                                                      | Server errors (status 500 and up) reaching `handleError` in `hooks.server.ts`                                                                 |
| `knights_tick_item_failures_total`   | `step`: writeback, payout, yesno, reset, buzz_grant                                                                  | Items that failed inside a tick step and wait for the next tick (the tick still answers 200)                                                  |

Joins, rank-ups and career resets also log one Axiom event each (`knights-player-joined`, `knights-rank-up`,
`knights-career-reset`, with its trigger), and `handleError` logs `knights-unhandled-error`.

Gauges are read by SQL on scrape, one snapshot shared by all of them and cached 60s per process, with a 5s statement
timeout. When the read fails, `knights_db_up` is 0, labelled gauges are absent and unlabelled ones are NaN; a scrape
never errors.

| Metric                                       | Labels                                                   | Meaning                                                                            |
| -------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `knights_db_up`                              |                                                          | 1 when the gauge read succeeded                                                    |
| `knights_queue_open_items`                   | `stage`: Knight, Templar, Paladin, yesno                 | Open items                                                                         |
| `knights_queue_oldest_open_age_seconds`      | `stage`                                                  | Age of the oldest open item since it was created (0 when none)                     |
| `knights_queue_newest_item_age_seconds`      | `source`: scan-sample, owner-rating, yesno-import, other | Age of the newest item per source among the newest 50,000 items (absent when none) |
| `knights_queue_overdue_items`                |                                                          | Open items more than 15 minutes past `expiresAt` (the tick should have moved them) |
| `knights_inquisitor_items`                   |                                                          | Items waiting for an Inquisitor ruling                                             |
| `knights_writeback_pending_items`            |                                                          | Resolved, not written back, `applyAttempts > 0`                                    |
| `knights_buzz_grants_stuck`                  | `state`: failed, pending                                 | Buzz grants failed in the last 24 hours, or pending for more than 15 minutes       |
| `knights_shop_purchases_stuck`               |                                                          | Shop purchases pending for more than 15 minutes                                    |
| `knights_reference_pool_items`               | `pool`: trials, hiddenCheck                              | Active reference images                                                            |
| `knights_harvest_last_run_timestamp_seconds` |                                                          | Latest `KnightsHarvestCursor.updatedAt` (NaN before the first run)                 |
| `knights_vote_partition_next_month_ready`    |                                                          | 1 when next month's `KnightsVote_YYYY_MM` partition exists                         |

Every gauge query is served by an index from `20261210120000_knights_v2_tables` or reads a table of a few rows
(`KnightsHarvestCursor`), except the newest-item gauge, which walks the primary key backwards over the newest 50,000
rows (there is no index on `source`).
