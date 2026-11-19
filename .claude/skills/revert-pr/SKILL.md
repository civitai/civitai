---
name: revert-pr
description: Decide whether a merged PR should be reverted or fixed forward, before reverting anything. Use whenever you are about to revert a merged PR or commit, pull one out of a release, or are asked to — including "it isn't ready", "its preconditions aren't met" or "hold it for the next release".
---

# Revert or fix forward

A revert undoes everything a PR did to fix one thing about it, and someone has to land it again
later. Fixing that one thing is usually smaller. Revert only when it is the fastest safe option,
and work that out before opening one.

## 1. What happens if it ships as it is?

Read the code and the deploy notes, and say what breaks. A revert is for real harm:

- something is broken in production, or will be once it deploys;
- data is lost or exposed, or will be once it deploys.

These are not harm on their own: a deploy step that has not run, a precondition that one more
change would meet, a review concern, a release going out soon. A release deadline decides how fast
the fix has to be, not whether to revert: if shipping the PR breaks nothing, the release ships with
it.

## 2. What is the forward fix?

Name the smallest change that removes the problem: the missing backfill, the guard, the config
value, an existing feature flag turned off, a step added to the deploy notes. Estimate it against
the revert plus its re-land. When step 1 found no harm, the forward fix wins whatever it costs.

Check what a revert would not undo: an applied migration, data already written, a deploy step
already run. Reverting the code over them can leave a worse state than either version.

## 3. Ask before reverting

Unless step 1 found harm that cannot wait, put both options to the person who asked for the revert
and to the PR's author: what you found, the forward fix and its cost, and the revert. They decide.

## 4. If you still revert

The revert PR body says:

- the harm the revert prevents, in one sentence (step 1);
- the forward fix that was considered, and why it was not taken;
- what has to be true to re-land it, and who checks.

If the first line cannot be filled in, do not open the revert.
