# Knights of New Order: the Acolyte apprenticeship

Replaces the old Trial (a 12-item run with a pass mark and a cooldown). Code: `apps/knights/src/lib/server/apprenticeship`, UI on `/play`.

## What an Acolyte does

- A continuous stream of graded items, never repeating for a player. The curated core set comes first; after that harvested rating images (`KnightsReferenceImage`, pool `trials`) are mixed with yes/no references (`KnightsYesNoReference`, active, on an active `bool` question) on a fixed rhythm. Either kind fills in when the other runs out.
- Every answer is graded against the reference. A right answer pays 100 XP on the normal level curve; a wrong one pays nothing. Acolytes are never smitten, earn no gold, and their answers decide nothing.
- Promotion to Knight happens on the answer that makes both true: level 20 and at least 75% right over the last 100 answers (a full window). A player at level 20 below the bar keeps playing; nothing resets.
- `/play` shows level progress toward Knight and an accuracy meter, no verdict per answer (only the correct/wrong sound), a recap every 20 answers listing exactly those 20 answers' misses with the right answers, the rating guide offered as help when accuracy is low, and a short moment at levels 5, 10 and 15. With nothing left to serve it says to check back soon.

## Data

Migration `20261225120000_knights_v2_apprenticeship` (applied by hand, idempotent) adds `KnightsApprenticeAnswer`: one graded answer per row, pointing at exactly one of `referenceId` / `yesNoReferenceId`, with the answer as given, the correct answer as it stood, whether it was right, the XP paid and `checkpointSeenAt` (set on the answer that closed a checkpoint once the player moved past its recap). Partial unique indexes keep a player from answering a reference twice. Deploy order: apply the migration, then the Knights app.

Accuracy, the recap and promotion read only answers since the player's last career reset (`NewOrderPlayer.startAt`); the no-repeat rule reads all of them, plus answers recorded by the old Trial in `KnightsTrialAnswer`. The old `KnightsTrialRun` and `KnightsTrialAnswer` tables are no longer written and can be dropped later.

The Redis marker `knights:trial-summary:<id>` is no longer read or written and can expire or be deleted.
