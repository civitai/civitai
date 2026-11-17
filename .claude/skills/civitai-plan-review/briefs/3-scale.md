ANGLE: Does it hold at Civitai's real volumes and on its hottest paths?

LANE_TASKS:
1. Size the data it touches: rows in each table it reads or writes, rows per day of the event it reacts to, and the peak rate over a rolling 10 and 60 minute window across at least a week. Rerun from the replica or ClickHouse; compare with the plan.
2. Every new query: is there an index for it (read the schema and, where safe, EXPLAIN on the replica)? Any N+1, unbounded list, missing page or cap, or full scan? Is it on the feed path, the image page, or generation submit?
3. Caches: does it read through an existing cache, add a new one, or bust one? Stampede risk on a bust? Who busts it on write?
4. Downstream load: orchestrator jobs, Buzz ledger writes, ClickHouse inserts, search reindexing, notifications, emails. What does it multiply, and which cost grows fastest?
5. What happens when a dependency (orchestrator, Redis, ClickHouse, a provider) is slow or down mid-operation: hang, retry storm, or fail open?
