ANGLE: Can it ship safely, be stopped fast, and be rolled back without stranding state?

Required whenever the plan turns anything on, runs a migration or backfill, or changes a default.

LANE_TASKS:
1. Order of operations: migrations are applied by hand; a new enum value needs the regenerated client deployed BEFORE the migration and any backfill; a release tag rolls out to prod on its own shortly after. Is the plan's order safe at every intermediate step (old code on new schema, new code on old schema)?
2. The brake: is there a flag, and does turning it off actually stop every path (jobs, webhooks, crons, other apps)? For Flipt, a boolean flag's `enabled` is the no-match default, not a master switch. Who can pull it, and how fast?
3. Rollback: what does a revert leave behind (rows, columns, cache entries, Buzz transactions, notifications already sent, files in storage)? Is the backfill reversible, and is a pre-change snapshot planned?
4. Verification after release: what read-back proves it worked in prod (a check that can fail), and who runs it when?
5. Blast radius: if it misbehaves for an hour before anyone notices, what is the worst outcome, and what alert or signal would show it?
