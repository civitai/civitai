---
name: feedback-triage
description: Turn a batch of user feedback (Discord threads, DMs, article comments, support tickets) into a triage checklist. Produces TWO artifacts — a full private one with attribution and tracker links, and a sanitized public one safe for docs/. Use when asked to triage feedback, build a feedback checklist, or record what a round of reports asked for.
---

# Feedback triage

Feedback arrives as a mess of threads and DMs. Triage turns it into a checklist someone can work from and,
later, read as a record of what was decided and why.

**This repo is public** (see CLAUDE.md → Security). Raw feedback is not publishable: it carries reporter
identities, private message content, internal ticket ids, and sometimes a named user's earnings. The
decisions are publishable, and are the part with long-term value. So every triage produces two files.

## The two artifacts

| | Private | Public |
|---|---|---|
| Where | scratchpad dir, or the private repo | `docs/` |
| Reporter names / handles | ✅ | ❌ → "a creator", "a moderator" |
| Tracker links (ClickUp etc.) | ✅ | ❌ |
| Verbatim / paraphrased DM content | ✅ | ❌ → the underlying request only |
| A named user's earnings or moderation state | ✅ | ❌ **never**, in any form |
| The work item | ✅ | ✅ |
| The decision + reasoning | ✅ | ✅ |
| Commit shas, file paths, root causes | ✅ | ✅ |
| Done/not-done state | ✅ | ✅ |

The public file is not a summary — it should carry every item and every decision note. Only provenance is
removed. If stripping attribution makes an entry meaningless, the entry was gossip, not a work item.

## Steps

1. **Collect** the raw feedback. Keep the source (thread, date) in the private file only.
2. **Dedupe.** The same complaint usually arrives from several people in different words. One item, and in
   the private file note that it was independently reported — that's evidence of priority.
3. **Classify** each item: bug, feature request, or decision needed. Separate already-shipped from open.
4. **Create tracker tasks** and put the links in the **private** file.
5. **Write both files.** Same items, same order, same headings, so they can be diffed against each other.
6. **As work lands**, update both: tick the box and add a one-line outcome note (what shipped, what was
   deliberately not done, the sha). This is the part people actually come back for.

## Sanitizing — check each before publishing

- No personal handles or display names. "alexds9 reported X" → "a creator reported X".
- No tracker ids or links.
- No message quotes, timestamps, or "he then asked…" narration.
- **No named user's financial or moderation detail** — not their earnings, payout history, transaction
  pattern, strikes, or content ratings. This is the one that is never fixable by rewording; drop the detail
  and keep only the technical finding ("a payout report traced to a display bug in `<sha>`").
- Re-read the result as a stranger: what could they do with it that they couldn't before? If the answer is
  anything but "understand the product or contribute code", cut more.

## Keeping them in sync

They drift. When you update one, update the other in the same turn. If only the private file is current,
say so in the public file's header rather than letting it silently rot.

If a public entry has been reduced to nothing useful by sanitizing, delete it from the public file rather
than leaving a stub — and note in the private file that it is private-only.
