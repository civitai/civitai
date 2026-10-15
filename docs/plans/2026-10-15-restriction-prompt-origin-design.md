# Generator restrictions: prompt origin and triage review

Status: implemented; in review.

## Problem

When a user's generation prompts are blocked often enough, the account is muted pending review, and
moderators rule on it at `/audit/generator-restrictions` in the moderator app. The page shows each
blocked prompt, but not where the prompt came from. A user who pressed Remix on an image that looked
fine can be muted for a prompt they never wrote, and the moderator cannot tell that apart from a
prompt the user typed. When a remix is the source, the moderator also needs the source image, so it
can be actioned on the site.

The page itself predates the triage pattern used by `/models/flag-appeals`: it pages instead of
advancing, has no keyboard flow, and spreads the ruling, ban and false-positive actions across the
detail pane.

## Goals

1. Each trigger on a generation restriction records where its prompt came from, using evidence the
   user cannot assert: a server-verified remix source, or an output of the user's own prompt
   enhancer runs.
2. The review page leads with that origin, links the remix source image, and moves to the two-pane
   triage pattern of the flag-appeals page.

Non-goals: changing when or why a prompt is blocked, changing mute thresholds, and any change to the
generator UI or the remix flow.

## Part 1: recording origin (main app)

### Data

`BlockedPromptEntry` (Redis, `promptAuditing.ts`) and the stored trigger gain one optional field:

```ts
origin?: {
  remix?: {
    imageId: number;
    verified: boolean; // server-verified source, vs the client's remixOfId claim
    promptMatch: 'identical' | 'edited' | 'unrelated' | 'unknown';
    score?: number;
  };
  enhancer?: {
    workflowId: string;
    promptMatch: 'identical' | 'edited';
    verified: false; // read from the user's own workflows, which they can modify
  };
  incomplete?: true; // a lookup failed or timed out; absence of evidence is not evidence of absence
};
```

An empty `origin` object means no evidence of either source (shown as typed by the user); an absent
field means the row predates origin tracking (shown as "Origin not recorded").

### Sources

- **Remix.** `generate` in `orchestration-new.service.ts` already computes `sourceImageIds` (signed
  provenance tokens plus on-site input URLs) before calling `auditPromptServer`. Pass it through.
  - A source in `sourceImageIds` is `verified: true`.
  - A `remixOfId` the server cannot confirm is recorded with `verified: false`.
  - `promptMatch` compares the blocked prompt with the source image's stored prompt, read through
    `imageMetaCache` (which applies `hideMeta`), using `promptDerivationHolds`. A missing or hidden
    source prompt gives `unknown`.
- **Prompt enhancer.** On a block, read the user's most recent `prompt-enhancement` workflows with
  `queryWorkflowsByTags` and compare their `enhancedPrompt` outputs with the blocked prompt. Nothing
  in the enhancer itself changes.
- **Shared prompt reuse** (copying a prompt from another image's page) already arrives as a remix
  source through the `prompt` provenance tokens, so it needs no separate origin.

### Constraints

- The origin is computed only on the block path. A generation that is not blocked pays nothing.
- Every lookup is bounded at 800ms and wrapped. A failed or timed-out lookup keeps whatever evidence
  was found, sets `incomplete`, and never fails or delays the audit decision. A present `null` is
  never written for `remix` or `enhancer`.
- `origin` is moderator-only evidence. It must never be rendered on any user-facing surface.
- The ClickHouse backfill (`backfillTriggers` in `user-restriction.router.ts`) copies the
  `remixOfId` it currently discards, as `origin.remix` with `verified: false` and
  `promptMatch: 'unknown'`.
- `RestrictionTrigger` in `apps/moderator/src/lib/server/user-restriction.service.ts` gains the same
  optional field. Older rows have none and render as they do today, with no origin line.

### Tests

- A unit suite for the origin builder: verified and unverified remix; identical, edited and
  unrelated prompts; hidden meta; enhancer match; each lookup failing.
- A block-path case in the existing `promptAuditing.*.test.ts` suites, asserting the stored entry
  carries `origin` and that a lookup failure still blocks.

## Part 2: the review page (moderator app)

### Layout

Full-height two-pane view, matching `/models/flag-appeals`.

- **Queue (left).** One row per restriction: username, time pending, trigger count, an origin
  summary chip (for example "2 remix · 1 typed") and status. The selection is mirrored to
  `?selected=` with a debounced `replaceState`.
- **Detail (right), top to bottom:**
  1. Header: user, account age, restriction age, status, links to the profile and the user lookup.
  2. Verdict summary: one line built from the triggers' origins, for example "3 of 4 blocked
     prompts came from remixes and were left unchanged".
  3. Trigger cards in an evidence grid. Each leads with its origin:
     - Remix: "Remix of #id · unchanged / edited / unrelated", a source thumbnail and an Open image
       link; a muted "unverified" badge when `verified` is false.
     - Enhancer: "Prompt enhancer output · unchanged / edited".
     - Neither: "Typed by user".
     - Below it, the existing evidence: highlighted prompt and negative prompt, matched word and
       category, input images or video.
     - For an edited or unrelated remix, an expandable diff of the source prompt against the
       submitted one.
  4. Previous generations (`UserWorkflowsPanel`), collapsed by default.
  5. The user's message and the resolution history, unchanged.

### Decisions

A sticky decision bar:

- Uphold (`1`) and Overturn (`2`), with the optional message. Rulings are optimistic and advance to
  the next undecided item. A ruling unmutes, emails and touches subscriptions, so a failed ruling
  rolls back and shows its error on the row.
- Ban opens a confirm dialog, has no hotkey, and stays gated on `audit.ban.execute`.
- Flag false positive is a secondary action in the bar.

### Navigation and filters

- J/K move between items. Shortcuts are ignored while a text field has focus.
- After decisions, the queue offers "Refresh queue (N decided)" instead of paging.
- Facet chips with counts for status and origin (has a remix, all typed).

### Reuse

The pieces both pages need (`triageKeyAction`, the typing guard, the optimistic enhancer, the card
and key-hint markup) move from `lib/minor-flags` into a shared `lib/triage`, and the flag-appeals
page imports them from there. Nothing is copied.

### Tests

- Unit tests for the verdict summary and the origin chip helpers, and for the keyboard map.
- The existing queue-order, type-filter, ruling-body and two-pane tests keep passing.
- A browser walkthrough on dev against restrictions with remix, enhancer and typed triggers.

## Rollout

The two parts ship independently. The page change handles rows with and without `origin`, so it can
merge first; new rows gain origins once the main-app change deploys.
