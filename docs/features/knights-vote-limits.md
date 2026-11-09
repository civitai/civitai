# Knights vote limits

Votes (rating, yes/no answers, hidden checks) are paced per player. Two layers apply, and the second is authoritative.

## Redis check, before the vote transaction

`createVoteGate` (`apps/knights/src/lib/server/vote-limits/gate.ts`) wraps the one `?/vote` action in `routes/play/+page.server.ts`, after the muted
check and form validation, so only real vote attempts count. Moderators are never paced.

- It runs as one atomic Lua `EVAL` per vote. Keys share a `{userId}` hash tag, so it works on a cluster. Counters and the cooldown are Knights-owned
  keys under `knights:vote-limit:{userId}:*` on sys Redis.
- In flight: at most `IN_FLIGHT_CAP` (3) votes at once per player. The slot is freed in `finally`; one that is never freed (a check that timed
  out and was abandoned, a crashed request) expires 30 s after it was taken. Over the cap is a 429 marked `busy` (no lockout): the page sends votes one at a time from a queue (`createSerialQueue`, `routes/play/optimistic.ts`) and resends a busy vote after 0.4 s, 1.2 s and 3 s, so only a script reaches the cap. A reached limit is the 429 "judging too quickly" answer with `lockoutSeconds`.
- Windows: a counter per minute, hour and day, each with its expiry set inside the script. Tripping one sets the old game's fixed cooldown:
  minute 10 min, hour 1 h, day 24 h. While it runs every vote is refused before a transaction starts.
- `/play` and `/play/next` read the lock through `lockoutFor` (`runtime.ts`): the later of the cooldown's remaining TTL and the ledger's
  `voteLockUntil`, so the countdown matches the refusal.
- Limits: the original game's sysRedis key `new-order:config` (`{ perMinute, perHour, perDay }`, tuned by moderators), cached 60 s in
  `config.ts`. A missing, unreadable or invalid value keeps `VOTE_LIMITS` (`queue/vote-rate.ts`).
- Redis down or silent: the gate is skipped (with a 5 s breaker, so votes do not each wait on it) and the ledger check decides. Failing votes
  because a cache is unavailable would be worse than leaning on the database.

## Ledger check, inside the transaction

`pacingGate` (`queue.service.ts`) takes the per-player advisory lock and calls `voteLockUntil`, which counts `KnightsVote`. `queueDeps.voteLimits`
is a getter over the same live-limits cache. Note that spreading `queueDeps` (`{ ...queueDeps }`) copies the limits as they are at that moment.

## Tests

`gate.test.ts` runs the real scripts in Lua (wasmoon) through `fake-redis.ts`, over an in-memory store with a clock the test moves.
