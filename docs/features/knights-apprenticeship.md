# Knights of New Order: the Acolyte apprenticeship

Replaces the old Trial (a 12-item run with a pass mark and a cooldown). Code: `apps/knights/src/lib/server/apprenticeship`, UI on `/play`.

## What an Acolyte does

- A continuous stream of graded items, never repeating for a player. The curated core set comes first; after that harvested rating images (`KnightsReferenceImage`, pool `trials`) are mixed with yes/no references (`KnightsYesNoReference`, active, on an active `bool` question) on a fixed rhythm. Either kind fills in when the other runs out.
- Every answer is graded against the reference. A right answer pays 100 XP on the normal level curve; a wrong one pays nothing. Acolytes are never smitten, earn no gold, and their answers decide nothing.
- Promotion to Knight happens on the answer that makes both true: level 20 and at least 75% right over the last 100 answers (a full window). A player at level 20 below the bar keeps playing; nothing resets.
- `/play` shows level progress toward Knight and an accuracy meter, no verdict per answer (only the correct/wrong sound), a recap every 20 answers listing exactly those 20 answers' misses with the right answers, the rating guide offered as help when accuracy is low, and a short moment at levels 5, 10 and 15. With nothing left to serve it says to check back soon.

## Data

Migration `20261225120000_knights_v2_apprenticeship` (applied by hand, idempotent) adds `KnightsApprenticeAnswer`: one graded answer per row, pointing at exactly one of `referenceId` / `yesNoReferenceId`, with the answer as given, the correct answer as it stood, whether it was right, the XP paid and `checkpointSeenAt` (set on the answer that closed a checkpoint once the player moved past its recap). Partial unique indexes keep a player from answering a reference twice. Deploy order: apply by hand, in this order, `20261224120000_knights_v2_yesno_reference`, `20261225120000_knights_v2_apprenticeship`, `20261226120000_knights_v2_drop_trial_tables`, `20261227120000_knights_v2_block_reason` and `20261228120000_knights_v2_fervor_window`, then deploy the Knights app.

Moderators manage the yes/no references on the `yes-no` tab of the moderator app's Knights of New Order trials page (`/knights-of-new-order/trials`): add a pair (image id or image page URL, question, answer, optional explanation), toggle it active or inactive, or delete it. There is no edit yet; change a pair by deleting and adding it again.

Migration `20261229120000_knights_v2_answer_snapshot` (by hand, idempotent; apply before deploying the Knights and moderator builds that read it) makes an answer outlive its reference. Each answer also stores the `imageId` and `questionKey` it was given for, and both reference foreign keys are `ON DELETE SET NULL`, so deleting a yes/no pair or the image behind one never changes a player's counts, window, recap or promotion. The no-repeat rule matches on that image and question, so a pair deleted and added again is not served twice. A recap miss whose reference is gone shows no explanation. In the moderator app a yes/no pair that has answers can only be deactivated, never deleted; its answer and explanation can be edited.

Accuracy, the recap and promotion read only answers since the player's last career reset (`NewOrderPlayer.startAt`); the no-repeat rule reads all of them.

The Redis marker `knights:trial-summary:<id>` is no longer read or written and can expire or be deleted.
