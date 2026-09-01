# BitDex app-side removal — record (2026-09-01)

What was removed from the main app when BitDex was decommissioned, and what the
removed machinery did. Kept because the *why* is not recoverable from the diff.

## Where the decommission stands

| step | state |
|---|---|
| flipt-state#80 — both cron jobs off | merged 18:48:20Z, sha `4611ebad`, Flipt `revision` confirmed equal to it |
| civitai#4552 — drop 8 ops write triggers | **open**, SQL already **applied by hand to prod ~18:56Z** |
| talos-infra#1373 / #1374 — engine teardown | merged; namespace gone 19:16:03Z |
| civitai#4555 — phase 2 (27 functions, drain trigger, 5 tables) | **open, must NOT be applied** until this removal lands |
| this branch — app-side removal | **incomplete** |

⚠️ `#4552` is applied to production but not merged. The database is ahead of
`main`. That is the one state worth knowing before anyone reasons about either.

## What was removed

18 files deleted outright: both jobs + tests, `src/server/bitdex/`, the two
internal endpoints, `bitdex-feed-serve.metrics.ts` + tests, six `bitdex-*`
service tests.

1,346 lines excised from `image.service.ts` (156 bitdex refs → 52), each block
cut by brace balance from its own declaration:

    232-242    imports                       3293-3304  BitdexCursoredPageUnavailable
    244-299    native filter helpers         3306-4123  fetchBitdexPrimary (818 lines)
    3159-3219  postFilterBitdexDocs          5209-5251  mapBitdexDoc
    3221-3247  isPublicallyPublished         5253-5532  getImagesFromBitdexPreFilter
    3249-3286  isScheduledForFuture

Verified before cutting: 11 of the 15 `_int`/`_eq`/`_and` filter helpers were
referenced *only* from inside those blocks, and `isPublicallyPublished` /
`isScheduledForFuture` had no callers outside them.

## What the removed machinery actually did

Recorded because it is not obvious from the remaining code, and phase 2 depends
on understanding it.

**`bitdexMode`** is a three-way Flipt variant (`off` / `shadow` / `primary`),
pre-evaluated in `image.controller.ts` and threaded into `getImagesFromSearch`
as an optional input field so the service does not re-evaluate the flag per
call. `useBitdex` is `mode === 'shadow' || mode === 'primary'`, so `off` — the
production value for every segment — takes neither branch.

**`primary`** bypassed Meilisearch entirely via `fetchBitdexPrimary`, then fell
through to Meili on any failure. **`shadow`** ran the same path detached and
compared the two result sets. Both are dead with the flag off, but note that a
branch not taken still executes its guard — the flag evaluation itself was on
every feed request.

**The `bdx:` cursor codec.** Cursors were encoded `"offset|bdx:JSON"`, and the
decoder split on the prefix to recover a BitDex keyset cursor. Nothing has
minted one since the flag went off for all segments, so no live client should
hold one — but that is the assumption to check rather than assume if anything
odd shows up in cursor handling after this lands.

**`postFilterBitdexDocs`** was defense-in-depth: the BitDex query used strict,
cacheable filters with no per-user OR clauses, so the result was a *superset*
that had to be narrowed locally — scheduled-vs-published, own-content,
unpublished. `isPublicallyPublished` / `isScheduledForFuture` are its two
predicates.

**`bitdexCallsObserved`** was a per-request counter distinguishing "BitDex
answered and was wrong" from "BitDex was never asked" — several `return null`
paths declined before issuing a query. Without it, `bitdex_primary_result_total`
counted requests that never contacted BitDex.

🔴 **The post-filters and the shadow comparison were the mechanism that made a
wrong feed result visible.** Removing them and observing no errors is not
evidence the feed is intact. Any check used to prove that must be broken
deliberately first, and seen to break.

## Remaining manual items, none of them mine

Rotate the BitDex Postgres credential (in git history since May); drop the
`bitdex` login role **after** `#4555` clears the functions and tables; remove
the hand-made `bitdex-admin-token` secret in `civitai-dp-prod` **with** the
audit job, not before — its secretRef is `optional: true`, so absent is the
graceful case and present-but-dead is a 401; reclaim ~430 GiB under
`/var/mnt/nvme1/bitdex`; fix the SOPS-managed comment on the `bitdex-nvme`
UserVolumeConfig; check for a hand-made Cloudflare record for
`bitdex.civitai.com`.

🪤 `/var/mnt/bitdex-nvme/buzz-db` is **buzz-db**, not BitDex, and shares
`talos-48r-b3a` with a released BitDex volume. See
`claudedocs/bitdex-decommission-2026-09-01.md` in `talos-infra`.
