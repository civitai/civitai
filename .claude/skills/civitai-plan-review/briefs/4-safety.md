ANGLE: What can go wrong for users, money and trust, and who could abuse it?

LANE_TASKS:
1. Money and Buzz: every place value moves. Is it idempotent, is the amount from the authoritative field, and is there a double-spend or double-grant path (retries, races, webhooks arriving twice or late)?
2. Access: which procedure rung (public, protected, moderator...) guards each new path? Can a user read or change another user's data, or reach something behind membership or a flag?
3. Minors, NSFW and moderation: does any new surface show content without the existing browsing-level and ImageGuard gating, or bypass scanning? Name the existing gate it must reuse.
4. Privacy and disclosure: PII in logs, events or ClickHouse; anything the plan would commit to the public repo that the root CLAUDE.md security list keeps private.
5. Abuse: how would a motivated user farm, spam or exhaust it (rate limits, caps, cost per action)?
