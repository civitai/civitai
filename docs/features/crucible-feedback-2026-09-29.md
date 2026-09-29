# Crucible preview feedback — 2026-09-29

Feedback from the first tester round on the preview build and two product walkthroughs. Items that cover abuse vectors or moderation gaps are tracked privately and are left out here.

Not bugs (preview environment): the preview runs no scheduled jobs, so crucibles there never activate on schedule, finalize, or pay out; it serves the SFW domain only; and its model search index lags production.

## Triage

Decisions:
- **Creation limits match challenges:** good standing and a minimum creator score, 5 per rolling 24h, and a cap on active plus scheduled crucibles by membership tier.
- **Entries must be media published after the crucible starts.**
- **Creators can't enter their own crucible.**
- **D16 (new):** the owner can edit everything before start and the name, description and cover while active; nothing once ended.

**P0, before the next tester round:** B1, B2, B3, B4, B12, B15, D1, D2, creation limits, entry recency, no self-entry.
**P1, before launch:** B5, B7, B9, B10, B11, B13, B14, B18, B19, B22, B23, B24, B26, D17, D4, D6 (manual % input, Buzz per place), D8, D11, D12, D16.
**P2, later:** B8, B17, B25, D5, remaining D6 items, D14.

Second walkthrough (confirmed; nothing is cut):
- Confirmed: the creation limits, the D16 edit rules, and splitting unfilled places among the winners (B29).
- **P1 add:** B32, B29, B30, B31, B19, D18–D28, D31.
- **Later:** D29, D30.

## Bugs

- [x] **B1. Create fails with a generic error when Max total entries exceeds the column range**, and `0` (no limit) is rejected. The Buzz debit is refunded correctly. → Fixed: server caps max total entries at 2–100,000 (int4-safe); the form accepts 0/empty as "no limit".
- [x] **B2. Prize distribution validation:** it saves over 100%, allows under 100% with no stated destination for the remainder, and gives no reason when Next is blocked. → Fixed: split must total exactly 100% (server + form); an inline message says why Next is blocked, in both edit and closed views.
- [x] **B3. A crucible whose slug is `judge` routes to the judging page** instead of its detail page. → Fixed: `getCrucibleUrl` never emits the reserved `judge` slug (it becomes `judge-crucible`).
- [x] **B4. The submit modal's eligibility check ignores required resources** (the server enforces them). → Fixed: new `crucible.checkEntryEligibility` answers recency and required models per image with the same rule submission uses; the modal header no longer says "Any model".
- [x] **B5. The resource picker resets on every open**, so several versions can't be added in one go. → Fixed: the picker (shared `ModelVersionMultiSelect`) keeps the current picks and adds several versions per open via the modal's multi-select. Challenge creation gets the same control.
- [x] **B7. The judge page occasionally stalls mid-session** until refreshed. → Fixed (root cause unconfirmed; recovery instead): per-side load state with a 20s timeout, Retry/Skip on a failed side, votes locked until both sides load, and an error state when the pair request fails.
- [ ] **B8. The vote highlight persists after a click.**
- [x] **B9. Mobile judging crops pair images to strips** and sometimes renders none. → Fixed: stacked on portrait phones, side by side in landscape, `object-contain` throughout.
- [x] **B10. Mobile create flow:** Next doesn't scroll to the top; sliders are hard to use on touch. → Fixed: Next/Previous/step tabs scroll the wizard top into view; sliders got a % input (D6a).
- [x] **B11. Wide covers are obscured by the header card**; cards and entries crop to portrait. → Hero fixed: the whole cover shows (`object-contain` over a blurred fill). Entry cards keep the 4:5 crop with the chosen D25 layout.
- [x] **B12. Names have no length limit** and overflow the header and judge page. → Fixed: server caps name/description at 100/500; hero and judge done-screen wrap/truncate unbroken strings.
- [x] **B13. The detail hero card shows the creator's initials instead of their avatar.** → Fixed: crucible selectors fetch `profilePicture` (`simpleUserSelect`) and the hero/leaderboard render `UserAvatar`.
- [x] **B14. The description edit is lost when navigating back and forth in the wizard.** → Could not reproduce with the wizard's own buttons; likely browser Back/Forward, which B23's saved draft now covers.
- [x] **B15. Cancelled crucibles remain in the public list.** → Fixed: default feed excludes Cancelled; an explicit Cancelled filter returns nothing unless the caller moderates.
- [ ] **B17. The submit modal's generator tab was empty; uploads showed no progress.**
- [x] **B18. Video judging autoplays both clips with sound**; mute controls are small. → Fixed: no autoplay; hover (mouse) or tap plays one clip and pauses the other; clips start muted with a 44px mute toggle.
- [x] **B19. Entries per user can exceed max total entries**; it's a fixed select, not a number. Decided: an open number input, max 20 for now. → Fixed: number input, 1–20 (`CRUCIBLE_MAX_ENTRIES`); the server already rejects a per-user limit above max total entries.
- [x] **B20. Max entry fee silently clamps.** → Superseded by D2 (1,000 max).
- [x] **B22. Past its end time a crucible still reads as active** (badge, "Ending soon", judging entry point) until the finalize job runs. → Card, hero badge and detail-page actions read `endAt` (no judging or entering once past it); judge page shows an ended state and stops requesting pairs.
- [x] **B23. Reloading the create wizard loses all progress.** → Fixed: `useFormStorage` draft (`crucible_new`) holds form values, step and uploaded cover; "Restore unsaved changes?" on reload; cleared on create.
- [x] **B24. "Continue judging" suggestions include crucibles with nothing to judge,** or that have already ended. → Fixed: `crucible.getJudgingSuggestions` returns only Active crucibles ending in the future, with ≥2 entries the viewer can judge, inside the viewer's browsing level, excluding blockers.
- [x] **B25. The done screen says every pair was rated when there were simply too few entries to judge.** → Fixed: "Nothing for you to judge yet" when the only entries are the viewer's.
- [ ] **B26. Investigate:** the video submit modal marks nearly every video ineligible on a PG crucible.

Second walkthrough:
- [x] **B30. On the detail page, the card under the cover hero is misaligned** with the rest of the content. → Fixed: the hero uses the same `Container size="xl"` as the page body (it was `max-w-7xl`).
- [x] **B31. The status label at the bottom of a crucible card is barely visible.** Remove it, since the top badge already shows status, and give that badge an "Ending soon" state. → Fixed: the bottom label is gone; the top badge comes from `getCrucibleStatusBadge`, which reads `endAt` too — "Ending soon" inside the last 24h, "Ended" once past `endAt` before the finalize job runs.

## Decisions / requests

- [x] **D1. Durations: 24h free, 3 days free, 7 days 1,000 Buzz; drop 8h.** → Done: 24h free, 3 days free, 7 days 1,000; 8h removed.
- [ ] **D2. Entry fee 10–1,000.** Yellow or green Buzz; green limits content levels to SFW, as challenges do. → Fee range done (10–1,000, always charged). Yellow/green split deferred to P1.
- [ ] **D3. Seeded pool max stays 10M** (matches challenges).
- [x] **D4. Label the start date's time zone.** → Done: "Times are in your local time (TZ)" on the start date and the review schedule.
- [ ] **D5. Nav placement: top-level entry or user menu.**
- [ ] **D6. Prize setup UX:** manual % input, a rebalance action, Buzz shown per place, place ranges, slider colours distinct from Buzz types, and whether a later place may out-earn first. → D6a done: a 0–100% input per place beside its slider, and each place's Buzz "from your seed" and "if full". Ranges, rebalance and slider colours (D6b) still open.
- [x] **D8. Minimum for max total entries**, and explain the 0- and 1-entry outcomes in the UI. → Done: a note under Max Total Entries explains the 0-entry refund and the pro-rata split with fewer entries than places. Minimum stays 2.
- [x] **D9. Restrict entries to media created after the start?** → Done: media created before the crucible started is refused (server + modal).
- [x] **D10. May creators enter their own crucible?** → Done: creators cannot enter their own crucible (server + detail page).
- [ ] **D11. Moderator editing of title, description and rating; owner cancel of a scheduled crucible; cancelled crucibles hidden from non-moderators.** → D11b: moderator edit + owner cancel before start done with D16 (rating editing server-only for now). D11a async text moderation still open.
- [ ] **D12. Explain influence in the UI**, decide snapshot vs live weighting, and reset it at launch. → UI explanation done: influence is 10 × √(pairs rated), unweighted; the fake streak text and default of 100 are gone. Snapshot-vs-live and the launch reset are still open.
- [ ] **D14. Remaining-pairs counter; image/video filter on the list.**
- [ ] **D17. Should required resources be limited to models available in the generator?**
- [x] **D15. Image and video can't be mixed in one crucible** — decided.
- [ ] **D16. Editing: the owner edits freely before start and name, description and cover while running; nothing once ended.** → Server done: `crucible.update` (owner until the end; resources only before start and only swapped, never added or removed; content levels moderator-only; moderators any time) and owner cancel before start (refunds setup fee + seed). UI: a "Manage Crucible" panel with name/description edit and cancel. Cover, resources and rating editing have no UI yet.

Second walkthrough:
- [x] **D18. First-visit explainer.** For a first-time visitor, replace the "Welcome back" block with one that explains what Crucible is and how you earn: a new way to play and earn Buzz, with entries judged head-to-head by people rather than by AI as in challenges. → Done: first-time visitors (logged out, or never entered) get a "Welcome to the Crucible" intro (Enter / Judge / Win) until they dismiss it.
- [x] **D19. Show rules and requirements in the details table** used on model versions and challenges. → Done: a `DescriptionTable`.
- [x] **D20. Give the prize-pool panel the challenges' growing-prize-pool treatment** rather than a bare number. → Done: teal "Growing Prize Pool" header with the shimmering total and "+fee per entry", as on challenges.
- [x] **D21. Once a user has used all their entries,** show an alert saying so in place of the disabled button, and hide the entry fee. → Done: an alert replaces the button and the entry fee is hidden.
- [ ] **D22. Audit the pairing and ELO logic:** how opponents are chosen, why pairs repeat, and how many judgments N entries need. Code: `getJudgingPair` in `crucible.service.ts`, `processVoteAtomic` in `crucible-elo.redis.ts`. → Audit done. Vote-integrity hardening shipped; pairing-quality changes (least-voted-first pairing, nearest-rating opponent, fall back to any unjudged pair before showing the end screen) are open.
- [x] **D23. "Continue judging" suggestions use the landing-page crucible card**, with the cover. → Done: suggestions render as `CrucibleCard` with a Start Judging button.
- [x] **D24. Completed crucibles get the challenges winners podium** at the top. → Done: `CruciblePodium` reuses `WinnerPodiumCard` above the completed crucible's content.
- [x] **D25. Entry card redesign:** cleaner numbers, username without "by", rank top-right; the same layout without score or rank before completion. Design options first. → Done: the "corner rank" layout (Manuel's pick) — rank chip top-right in gold/silver/bronze for the podium, avatar + username, score as one number; the top three also get the `WinnerPodiumCard` podium (D24).
- [x] **D26. Show all entries in random order** rather than newest first. → Done: while running, entries come back in a per-viewer seeded shuffle (`md5(id || seed)`, keyset-paged, cursor still the entry id); score order once final.
- [x] **D27. Add a back button to the crucible detail page**, top-left and aligned with the content. → Done: a Back button top-left in the hero, aligned with the content (`NavigateBack`, falls back to `/crucibles`).
- [x] **D28. A crucible that allows X/XXX should still appear in the PG feed**, since it may hold entries the viewer can see; entries are filtered per viewer. The feed query has no rating filter; the likely cause is the cover image being stored with the crucible's allowed-levels mask rather than its own rating. Decided: it applies on the SFW domain too, as it does for models — an NSFW model still shows there because not all its content is NSFW. → Done: the list filter already keeps a crucible whose allowed levels include the viewer's; the cover now goes through the shared cover path (`resolveCoverImageId` → `createImage` → scan) instead of a bare insert stamped with the allowed-levels mask, so it carries its own rating.
- [ ] **D29. Push notifications:** ending soon, new entries, and "N more for you to judge" for people who have judged in a crucible. Needs a per-user remaining-judgments count (see D14).
- [ ] **D30. Creator-defined eligibility prompt**, run by an LLM on each entry, to reject off-theme submissions. Later.
- [x] **D31. Put the discover feed's sort options on the same line as the title.** → Done.

## Found while fixing

- [x] **B28. The prize-customization fee is now derived from the split** rather than trusted from the client.
- [x] **B29. Unfilled prize places pay nobody** when a crucible has fewer entries than paid places. Decided: split the leftover among the winners, pro rata to their shares. → Done: `getCruciblePrizeAmount` scales each filled place by configured ÷ filled share; finalization pays it and the leaderboard shows it.
- [x] **B32. The crucible jobs never ran: the code asked Flipt for `crucible-jobs-enabled`, but the flag is `crucible-jobs`.** `finalize-crucibles` (which also activates scheduled crucibles) and `sync-crucible-scores` both return early on `isFlipt(CRUCIBLE_JOBS_ENABLED)`, and an unknown key evaluates false, so nothing would have activated, finalized or paid out, in preview or prod. → Fixed, then removed (Manuel): the crons no longer read any flag and always run once deployed; a guard test pins that. The `crucible-jobs` flag in flipt-state is now unused.
