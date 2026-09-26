# Shelf life — what a store screenshot must NOT photograph

A store gallery is re-shot rarely and reviewed by a moderator each time, so every shot is
load-bearing for months. **A screenshot's shelf life is the shelf life of the least durable
thing visible in it.** Photograph the product's *structure*; never a specific dataset, the
operator's account state, or an empty state.

This file is the rule plus the measurement that produced it. The per-app "is there anything
worth shooting at all" survey is a different question and lives in
`.claude/skills/app-capture/reference/per-app-content-2026-08-16.md`.

## The three classes, and why each one rots

| class | why it rots | example measured on model-benchmarking |
|---|---|---|
| **user-generated content** | any row a user can add, vote on or delete | the `beauty` prompt — removed from the live app within days of the shot |
| **account state** | changes on the operator's next action | the `4,182,701 BUZZ` chip in the header |
| **empty / unpopulated state** | reads as "nobody uses this", which is worse than one shot | `not generated yet` in 2 of the grid's 4 cells |

Only the third is visible to a store visitor as a *defect*. The first two are invisible to
the audience and obvious to you — which is exactly the trap: they generate an urge to
re-curate that buys the listing nothing. **Weigh a drift fix by what a stranger would see.**

## 🔴 Removing ONE shot is almost never the fix — enumerate before you curate

Measured 2026-08-19 on the live `model-benchmarking` gallery (3 shots, all captioned). The
stale `beauty` entry was believed to be confined to the lead Grid shot. It was not:

| defect | shot 0 (Grid) | shot 1 (Combinations) | shot 2 (Prompts) |
|---|---|---|---|
| stale `beauty` entry | column header + cell | — | **top card, `INCLUDED` badge** |
| operator Buzz chip | ✅ | ✅ | ✅ |
| empty state | 2 of 4 cells `not generated yet` | 1 row | 2 prompts |

Dropping shot 0 would have removed **one of two** instances of the defect it targeted, left
the *more* legible instance in place, fixed neither of the other two classes, and cost the
only image showing the product's payoff — a filled comparison grid, which is what the
listing's tagline ("Settle it with a grid.") promises. Net loss on every axis.

**So: before removing a shot for a drift defect, open every OTHER shot and check whether the
same defect is in it.** A gallery is one narrative shot in one session against one dataset;
a defect in the dataset is almost always in more than one frame. The cost of the check is
three image reads.

## 🔴 Partial curation is more work than a wholesale re-shoot, not less

`--caption` exists only on `add-screenshot` — **there is no caption-update subcommand**, so
changing anything about an existing captioned shot is remove + re-add regardless. A gallery
is therefore effectively immutable: any change is a wholesale replacement, and "fix one shot
now, the rest later" costs two moderator reviews to reach a state one review would have
given. Batch it.

## Pre-attach checklist

Run this against every frame before `attach.sh`, not after:

- [ ] No account chip, balance, username, avatar or email anywhere in the frame.
- [ ] No dataset row that a user can delete — or, if unavoidable, one seeded specifically for
      capture and expected to persist.
- [ ] No `not generated yet` / `no results` / `0 items` / skeleton placeholder.
- [ ] Every cell, row or card that the caption's claim depends on is populated.
- [ ] The narrative works with each shot read alone — a store visitor may see only the lead.

The header chip is the one people miss, because it is the same chrome in every state and
stops registering after the third frame. Grep the frame for it deliberately.

## When the app cannot be re-shot

An app blocked by an open defect (generation broken, a fail-closed control) cannot produce a
populated frame, so a re-shoot is blocked with it. **Park the gallery unchanged and record
the blocking issue numbers** — do not part-curate in the meantime. An unchanged coherent
gallery beats a half-curated one, and the whole set has to be replaced in one pass anyway.
Worked instance: `claudedocs/handoff-app-listing-polish-and-coverage.md`.
