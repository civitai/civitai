# Model Text Moderation

**Status**: Shipping dark — flags exist, ramp not started
**Tracking**: CU 868ktb1wb
**Last Updated**: 2026-08-20

How a model's name and description are checked for policy violations, and what happens when
one is found.

This is a behaviour reference. It describes what the system does, not how it is built — for
the code, start from the moderation-adapter registry.

---

## Summary

Model text is scanned by XGuard, the shared text-moderation service that already covers
articles, challenges, wildcard categories and generated text output. A model whose text
describes adult content is marked NSFW automatically, and that decision is recorded where
moderators can review it.

Text moderation **raises a flag; it does not rate the model.** A model's rating comes from its
images. A text scan can only assert that the model's _stated purpose_ is adult — which is
exactly what the NSFW flag already means. It is not a substitute for image-derived levels.

---

## What gets scanned

**The model's name plus its description**, with markup stripped and whitespace collapsed into a
single string.

Scanned on **every save** — creation and edit alike, published or draft.

Not included:

- **Version descriptions and trigger words.** Those belong to a separate model-ingestion scan.
- **Moderator-authored saves.** A moderator editing a model's text is making a decision, and an
  unattended scan must never re-flip it.
- **Text that has not changed.** A save that leaves name and description untouched reuses the
  previous verdict instead of re-scanning.
- **Models with no text at all.**

## What the scan looks for

Fifteen policy labels are evaluated on every scan. They fall into two groups:

**Three labels act** — the sexual-content axis (NSFW, suggestive, explicit). Any one of them
triggering flags the model.

**Twelve are recorded for review.** They cover the non-sexual policy axes the shared pipeline
already classifies for other content types. Their results go to moderators and to the audit
log rather than driving the NSFW flag, so that how often they fire on real model text is a
measured number rather than a guess — which is the input to deciding what a later version
should do with them automatically.

Those twelve do not move a model's rating, so the scan's own top-level "blocked" verdict is
deliberately ignored: it folds them in. The rating outcome is derived only from the three.

## What happens when a model is flagged

1. The model is marked **NSFW**.
2. The NSFW property is **locked**, so an ordinary edit cannot clear it.
3. The model's **browsing level is recomputed**, which is what moves it behind the viewer's
   content settings.
4. The labels that triggered, **how confidently** each one scored against its own threshold, and
   the scan time are **recorded on the model** for moderator review.

Nothing else happens. Text moderation never removes, unpublishes, blocks or reports a model,
and a model stays visible while its scan is in flight — publishing does not wait on it.

### When a moderator has already ruled

If a moderator has locked the NSFW property, that ruling stands and the scan never overturns
it. This is load-bearing: flagging a model as depicting a minor deliberately sets NSFW to
_false_ and locks it, and an unattended scan must not undo that.

The detection is still recorded — on the model, on the scan's own record and in the audit log —
so a moderator reviewing it can see that the text scan disagreed with the standing ruling. Only
the rating and the lock are left alone.

### When the scan fails

A model's visibility does not depend on its text scan, so a failed scan leaves the model
exactly as it was. Failed scans are retried automatically for a bounded number of attempts.

## What moderators see

Each triggered label with its score and threshold, plus the scan time, visible **only** in the
moderation view. A score sitting just over its threshold marks a borderline call; one far above
it does not.

All of it is stripped from every creator-facing and public response, including the model
owner's own view of their model — this describes how detection works and is not shown to the
person being detected.

An automatic flag also appears in the model's change history, attributed to the system rather
than to whoever last saved the model.

---

## Rollout and reversibility

Two feature flags control the feature independently, both **failing closed** — if the flag
service is unreachable or the flag does not exist, no model is flagged.
For a path that automatically restricts other people's models, not flagging is the safe
failure.

| flag   | controls                                           | off means                                                   |
| ------ | -------------------------------------------------- | ----------------------------------------------------------- |
| submit | whether a model's text is sent for scanning at all | nothing is scanned                                          |
| apply  | whether a verdict is written to the model          | scans run and verdicts are recorded; the model is untouched |

Flags are evaluated **per model**, so a percentage rollout selects a stable subset of content
rather than following a particular author around.

Splitting submit from apply gives a real **shadow phase**: verdicts accumulate against live
traffic while the existing mechanisms stay solely in charge of the NSFW column. That is what
produces the comparison — does this catch what the profanity filter catches, plus what else, at
what false-positive rate — and the per-label trigger rates behind the "scan fifteen, act on
three" decision.

**While both flags are off, behaviour is exactly what it was before this feature existed.** The
mechanisms it replaces are untouched until the ramp completes, so switching the flags off is a
full rollback with no deploy.

⚠️ **Turning the apply flag on does not retroactively flag anything.** A model scanned during
the shadow phase has already had its result delivered, and nothing re-delivers it. Those models
need a re-scan or they keep their existing rating.

Turning the submit flag off is safe for scans already in flight: while the feature is dark its
pending scans are set aside rather than retried, so they keep their retry budget and resume
normally when the flag returns.

## Backfilling existing models

Existing models are brought in by an operator-run sweep that selects candidates by term match
over name and description and submits them for scanning.

**The term selects; the scan decides.** No verdict is ever inferred from the term that selected
a model, so the selector can be widened later without becoming a policy surface in its own
right. Models already carrying a moderator lock on NSFW are skipped.

The sweep is deliberately **not** gated on either feature flag, because the two situations it
exists for are exactly the two where the flags are down: re-running the set after the apply
flag goes up, and re-running it after a rollback.

A full sweep over every published model is deliberately not part of this. Size it once live
per-label trigger rates exist to extrapolate from.

---

## What this replaces

Model text was previously checked by two independent mechanisms, each with its own detector,
its own storage and its own outcome:

| Mechanism                                             | Outcome                                       |
| ----------------------------------------------------- | --------------------------------------------- |
| A profanity filter running inline on every model save | Marked the model NSFW and locked the property |
| A separate classifier running on a schedule           | Created an automated report                   |

Neither had any notion of the non-sexual policy axes the shared pipeline already classifies for
other content types.

Both continue to run alongside this feature for the whole ramp, and are removed only after the
apply flag has held. Running all three at once is safe: the two that write do so idempotently —
same field, same value, same lock.

The end state is one pipeline, one source of truth for the verdict, and one audit trail.

## Not in this version

- **Acting on the twelve recorded labels.** Revisit once the shadow-phase trigger rates exist.
- **A moderator-triggered re-scan** for re-running a model after a policy change.
- **Derived labels** — verdicts composed from combinations of other labels.
- **Bounties**, which keep their own copy of the profanity filter.

## Related

- [Article Content Scanning](../article-content-scanning.md) — the first consumer of this pipeline
