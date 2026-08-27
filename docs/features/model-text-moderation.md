# Model Text Moderation

**Status**: Model text — shipping dark, flags exist, ramp not started · Version names — path built, not yet enabled
**Tracking**: CU 868ktb1wb
**Last Updated**: 2026-08-25

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

- **Version names.** Scanned by a separate pipeline of their own — see
  [Version name moderation](#version-name-moderation). A version name never affects the
  model's rating; it sets a flag on the version.
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

## Rollout and reversibility — model text only

Two feature flags control the feature independently, both **failing closed** — if the flag
service is unreachable or the flag does not exist, no model is flagged.
For a path that automatically restricts other people's models, not flagging is the safe
failure.

| flag   | controls                                           | off means                                                   |
| ------ | -------------------------------------------------- | ----------------------------------------------------------- |
| submit | whether a model's text is sent for scanning at all | nothing is scanned                                          |
| apply  | whether a verdict is written to the model          | scans run and verdicts are recorded; the model is untouched |

Flags are evaluated **per model**, so a percentage rollout selects a stable subset of content
rather than following a particular author around. Neither flag gates version-name moderation,
which has none.

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

## The name harness

A **name** is a different problem from a name plus a description, and the pipeline above cannot
tell you how different. A description is where the context lives; a name is two to six words
with none, which is why the profanity filter it replaces never fired on a short title — that
detector needs density, and a title has none to measure.

So there is a separate operator harness for names, run from a script rather than from the
service. It scans a model's name **on its own**, and every published version name beneath it,
and reports what each detector made of each one. Its verdicts are therefore **not comparable**
to the pipeline's and must not be read as a preview of them.

It is a **measurement tool, not the live path.** Version names are moderated automatically on
save by the pipeline described below; the harness exists to tune the term list that pipeline
selects with, and to answer questions about the corpus that only a whole-table sweep can.

It carries two detectors so they can be compared on the same corpus:

- a **term list** — one of the lists this repository already ships, or a curated subset
  supplied at run time
- the **XGuard scan**, the same fifteen labels the pipeline sends

Running both reports how often they agree, which is the input to deciding whether names need a
scan at all or whether a short list of unambiguous terms already settles the egregious cases.

### What the lists already tell us

Two existing lists are relevant, and neither needed to be written:

- The **profanity filter's own list** already contains the words a bad title is made of. It
  never fires on titles because its verdict is a density judgement over the whole text, and a
  title gives it nothing to measure. **Its list was never the problem; its shape was.**
- A second, smaller list is **already applied to model names** today, client-side, to hide
  models from viewers who cannot see NSFW. So a name we already hide from those viewers is
  currently not flagged in the database — the two mechanisms disagree, and the flag is the one
  that loses.

The harness reports **per-term hit counts**, because "the most egregious terms" is a judgement
about which terms fire on real titles and on what. A flagged total does not show that.

⚠️ **Matching the whole word is the load-bearing part.** Measured: the profanity matcher
substring-matches, so on control names it fires on _Essex_, _Unisex_, _Sussex_, _Middlesex_ and
_Scunthorpe_ — five false positives out of six flags. The same terms matched whole-word flag
the real offenders and none of the five. Two soft lists are deliberately not offered at all:
they carry words like _booty_ and _twerk_, which are a reasonable soft signal on a prompt and a
false positive on a title, and flagging a model is not a soft outcome.

**A curated subset must not be committed here.** The shipped lists are already public, so using
them discloses nothing new — but "these are the terms we auto-flag on" is a decision rule, and
this repository is public and permanent.

### What it can change

Two writes, both off unless asked for:

- **Recording version-name findings** on the model, beside its own scan, for moderator review.
- **Flagging a model** whose own name scores at or above an operator-supplied score on one of
  the three level labels. That score has no default — "egregious" is the judgement the harness
  exists to inform.

A flip from the harness goes through the same function the moderation callback uses, so it is
the same write: the NSFW flag, the lock, the browsing-level recompute that queues the model's
search document, the origin-side response-cache bust, and the change-history entry. It is
attributed to the harness rather than to the pipeline, so a moderator can tell an operator-run
flip from an automatic one. Models already carrying a moderator lock on NSFW are skipped.

Like the backfill, it is **not** gated on either feature flag, and for the same reason.

---

## Version name moderation

A version's name renders on civitai.com in places the model's rating never reaches, and until
this existed nothing scanned it. It is a **separate pipeline** from everything above: different
text, different column, different verdict. Ramping one has no effect on the other.

### When it runs

On **create, and on rename** — not on every save. An unchanged name has already been ruled on.

### The two stages

**A curated term list decides; XGuard reviews.** The list is a local regex pass cheap enough to
run on every save, and it keeps the classifier off the overwhelming majority of names, which are
`v1.0` and `epoch2` and carry nothing to read. A name that matches a term is flagged on the spot,
and the same name is sent onward for review.

⚠️ **That order is the opposite of the model path's, deliberately.** XGuard reads a two-word title
badly — see the score-floor section below for the measurements — so it is not asked to decide. It
is asked the narrow question it is good at: given a name the list already matched, is the list
wrong? A scan can therefore only ever CLEAR the flag, never raise it, which also means a callback
arriving late cannot undo a moderator's decision.

**Failure leaves the flag on.** A submit that fails or a callback that never arrives means the
review did not happen and the list's verdict stands.

**The list is not in this repository.** It lives in system Redis, so a term that turns out to
fire on something innocent can be pulled without a deploy — and because "these are the words we
auto-flag on" is a decision rule, not configuration. An empty list is also the feature's off
switch: nothing is selected, so nothing is scanned or flagged.

### What a version scan reads

**The version name, alone.** Not its description, deliberately:

- The flag exists because the **name** is what displays. Including the description would make
  the verdict "is this version adult", which answers the wrong question in both directions — an
  adult description with a clean name would flag a version that shows nothing, and a clean
  description could talk the classifier out of a name that is bad on screen.
- The description is **already scanned one layer up**, where it sets the model's own flag — and
  a flagged model already stamps every version beneath it. Scanning it here would double-count a
  signal that is already acted on.
- Only about a quarter of versions have one, so including it would make the flag mean different
  things depending on whether a creator happened to write a description.

### Why there is no score floor

A name is too short to give the classifier much to read, so asked to *decide* it flags far too
much. That is why the term list decides instead. Asked the narrower question — is this match a
false positive — it is reliable, which is the job it is given here.

⚠️ **Do not add a floor on top of its own thresholds.** The classifier's own per-label thresholds
are the comparison this path was tuned against; a floor stacked above them would clear most of
what the list flagged. The measurements behind that sit alongside the term list, outside this
repository — a trigger list is a decision rule, not configuration (CLAUDE.md → Security).

### What happens when a version is flagged

The version's **`nsfw` flag** is set — never its level directly. The flag is an *input* to the
level derivation, so the recompute stamps the level and cannot later clobber the flag. That is
also why the version needs no lock column of its own.

The flip is recorded in the version's change history, attributed to the system.

**A flagged version does not take its model down.** The model's rating is rolled up from its
*unflagged* published versions, so a model with safe versions stays where it is. Only when every
published version is flagged does the model itself become NSFW.

**A version under the system account is never flagged.** The level derivation has no branch for
an unflagged system-owned version, which makes setting the flag there a one-way door — so the
database refuses the write outright.

### The callback

None was built. Every text scan already reports to one shared webhook that dispatches by entity
type, so this pipeline is one registration in that registry — which also gives it the retry
behaviour and the audit record that every other scanned entity gets.

### Not yet enforced everywhere

A flagged version is stamped, and the surfaces that filter a version by its level react
immediately. Not every surface that renders a version name filters on it yet; the remaining work
is tracked in the version-NSFW plan §4.

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
