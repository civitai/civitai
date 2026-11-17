ANGLE: Is this the smallest change that does the job, does it ship as one finished change, and has each claim actually been verified?

LANE_TASKS:
1. For each moving part, can it be cut, merged with another, or deferred without losing what was asked? Name the 3 to 5 cuts that matter most and what each would lose.
2. How it ships: is the plan one finished change in one PR? Every phase, flag stage or back-compat shim must name its release constraint (old clients in the wild, migration ordering, an app on its own release schedule), list its removal condition, and have a removal task filed. A phase or shim with no release constraint is a must-fix, and so is work split into small PRs only to ease review.
3. Pick the 5 numbers the plan leans on hardest (row counts, rates, latencies, costs) and rerun them yourself from the replica or ClickHouse. Report yours next to the plan's, with window and count.
4. List claims stated as fact that nobody has run: where the plan says it, and what running it would take.
5. Name any acceptance check whose success could not be told apart from it never having run (a check that cannot fail), including tests that would pass with the feature removed.
