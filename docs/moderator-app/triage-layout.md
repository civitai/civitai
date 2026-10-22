# Triage pages — the layout

The shape every one-item-at-a-time moderation queue in `apps/moderator` takes: a list down the left, the
open item across the rest, judged in the middle and ruled from a sidebar on the right. The report queues
([`report-queue-pattern.md`](report-queue-pattern.md)) use the same columns with their own list.

| | |
|---|---|
| **Page header** | `TriagePageHeader`: title, one-line subtitle, optional search (`?q=`). The page's load returns `fullBleed` and `headerInline`, and the page is `lg:h-svh` so each column scrolls on its own. |
| **List** | `TriageShell` with `flush`: a fixed 400px column flush against the detail, one row per item (`TriageRow`), filter chips in its `listHeader`, a range footer. J/K move, digits rule. A section with tabs puts them at the top of the list (`TriageTabs` `compact`), not in a row across the page. |
| **Detail** | `TriageColumns`, inside the shell's `detail` snippet. `header` heads the middle column only, so the sidebar runs the pane's full height; `evidence` is what is being judged; `info` is the sidebar's cards (why it is here, the owner's side, history, the ruling once made); `decision` is pinned under the sidebar, and is omitted for an item already ruled. Below `xl` the columns stack and the pane scrolls as one. |
| **Decision** | `TriageDecisionBar` and `InlineReasonFields` with `compact`: buttons two to a row, reason and note on one line. A full-width bar in a sidebar stacks into a block that hides the sidebar on a 1080p screen. An action the viewer lacks the grant for is shown disabled with `denied(...)`, not left out — an absent button reads as the page having none. |

On it: Model Flags (all three tabs, via `ModelFlagDetailFrame`), rating disputes and generator
restrictions (`RestrictionTriage`). Still on the single-column `TriageDetailFrame`: CSAM text
holds and site appeals. Scam restrictions is deliberately not a triage page: nearly every row is banned,
so it is a bulk review — a reading column of each account's scanned text, all ticked, one submit that bans
the ticked as spam and lifts the rest (`$lib/server/scam-review.ts`).

Moving a page over: give its detail a `TriageColumns`, sort what it shows into `evidence` (what the
moderator looks at to decide) and `info` (context about the case), pass its bar `compact`, and check it at
1920×1080 that the sidebar's cards are not hidden behind the pinned decision.
