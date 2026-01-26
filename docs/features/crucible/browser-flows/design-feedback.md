# Crucible Design Feedback

This document captures design issues, bugs, and refinement opportunities identified from the browser flow screenshots.

---

## Critical Issues

### 1. Discovery Grid - Faded/Ghost Cards on Tab Switch
**Screenshots:** `04-ending-soon-tab.png`, `05-high-stakes-tab.png`, `06-new-tab.png`

When switching between tabs (Featured, Ending Soon, High Stakes, New), some cards appear faded/ghosted while others remain fully visible. This creates visual inconsistency and makes it unclear which cards are actually available or relevant to the selected filter.

**Recommendation:** All visible cards should have consistent opacity. If cards are being filtered out, they should either be hidden entirely or there should be a clear visual indicator explaining why they're dimmed.

### 2. "All Entries" Section Shows "No entries yet" Despite Having Entries
**Screenshots:** `02-03-landing-leaderboard.png`, `02-04-landing-all-entries.png`

The "Your Entries" section shows 5 entries with images, but the "All Entries (5)" section below displays "No entries yet - Be the first to submit an entry!" This is contradictory and confusing.

**Recommendation:** The "All Entries" section should display all submitted entries from all users, not show an empty state when entries clearly exist.

### 3. Rating Interface - Empty Image Areas
**Screenshots:** `04-01-rating-interface-with-stats.png`, `04-05-ended-crucible.png`

The rating/judging interface shows completely empty dark areas where the image pairs should be displayed. Users see the stats header but no content to judge.

**Recommendation:** Either show loading skeletons while images load, or ensure images are loaded before displaying the interface. If no pairs are available, show a clear message.

---

## UI/UX Refinements

### 4. Active Crucible Cards - Placeholder Images
**Screenshots:** `02-active-crucibles.png`

The "Your Active Crucibles" section shows cards with solid blue placeholder backgrounds instead of actual cover images. These appear to be test data, but the visual is jarring.

**Recommendation:** For crucibles without cover images, consider showing a generated pattern, gradient, or meaningful placeholder rather than a flat blue rectangle.

### 5. Submission Modal - Entry Counter Mismatch
**Screenshots:** `03-05-image-selected-state.png`, `03-06-image-grid-valid-invalid.png`

- In `03-05`, header shows "6 of 10" entries but button says "Submit 1 Entry"
- In `03-06`, header shows "5 of 10" but button says "Submit 0 Entries" even though images with green checkmarks are visible

**Recommendation:** The entry counter and submit button should stay in sync. Clarify whether the count refers to total submissions or just the current selection.

### 6. Submission Modal - Selection State Persistence
**Screenshot:** `03-06-image-grid-valid-invalid.png`

The first image in row 3 shows a selected state (blue border with checkmark) in `03-05` but appears deselected in `03-06`. The selection behavior is inconsistent.

**Recommendation:** Ensure click/selection state is clearly communicated and persists appropriately.

### 7. Leaderboard - Redundant "Your entry" Labels
**Screenshots:** `02-03-landing-leaderboard.png`, `02-04-landing-all-entries.png`

All 5 leaderboard positions show "@JustMaier - Your entry" which is redundant since every entry belongs to the same user. The crown icon only appears on position 1.

**Recommendation:**
- Only show "Your entry" badge on entries that belong to the current user (useful when viewing mixed leaderboards)
- Consider showing entry thumbnails in the leaderboard to differentiate between entries

### 8. Stats Grid - "BEST PLACEMENT" Shows Dash
**Screenshots:** `01-initial-state.png`, `02-active-crucibles.png`

"BEST PLACEMENT" displays "-" instead of a more meaningful empty state like "N/A" or "No placements yet".

**Recommendation:** Use consistent empty state text across all stats (e.g., "—" or "None" or descriptive text).

### 9. "Ended" Badge Inconsistency
**Screenshot:** `02-01-landing-hero.png`

The hero shows "ACTIVE NOW" badge but the footer shows "ENDED". This is contradictory.

**Recommendation:** Ensure status badges are consistent throughout the crucible detail page. If ended, the hero should reflect that.

### 10. Time Remaining Display - "Ended remaining"
**Screenshot:** `04-05-ended-crucible.png`

The time badge shows "Ended remaining" which is grammatically awkward.

**Recommendation:** Should display just "Ended" or "Competition Ended" without "remaining".

---

## Visual Polish

### 11. Discovery Card Hover States
**Screenshots:** `03-discover-grid-featured.png` through `07-sort-dropdown.png`

Cards don't appear to have visible hover states to indicate interactivity.

**Recommendation:** Add subtle hover effects (shadow lift, border highlight, or scale) to indicate cards are clickable.

### 12. Prize Pool Color Coding
**Screenshots:** `03-discover-grid-featured.png`

All prize pools show "0 BUZZ" with the same green styling. Consider dimming or graying out zero-value prize pools.

**Recommendation:** Use muted styling for 0 Buzz prize pools to differentiate from actual prize competitions.

### 13. Creation Flow - Step Indicator Active States
**Screenshots:** `05-01-step1-basic-info.png` through `05-07-step4-review-full.png`

The step indicators work well, but completed steps could use a checkmark or filled state to show progress.

**Recommendation:** Add visual differentiation between: current step, completed steps, and upcoming steps.

### 14. Dropzone Border Style
**Screenshot:** `03-04-modal-with-image-grid.png`

The drag-and-drop zone has a dashed border that could be more prominent to encourage the upload action.

**Recommendation:** Consider a more prominent dashed border or animated border on hover to make the dropzone more inviting.

### 15. Content Level Badges Consistency
**Screenshots:** `03-discover-grid-featured.png`, `02-05-landing-rules.png`

"PG" badges appear in the top-left of discovery cards but rules section shows them differently.

**Recommendation:** Ensure content level badge styling is consistent across all contexts.

---

## Suggested Enhancements

### 16. Empty State for Suggested Crucibles
**Screenshot:** `04-03-suggested-crucibles.png`

"Continue Judging These Crucibles" shows 4 suggestions with "0 pairs to judge" and "0 entries" each.

**Recommendation:** Don't suggest crucibles that have nothing to judge. Filter suggestions to only show crucibles with available pairs.

### 17. Prize Distribution Visualization
**Screenshots:** `05-04-step3-prizes.png`, `05-05-step3-prize-customization.png`

The colored bar visualization (green/teal/yellow) is helpful but the colors don't clearly indicate 1st/2nd/3rd place hierarchy.

**Recommendation:** Consider using gold/silver/bronze colors or numbered badges to make the prize tiers more intuitive.

### 18. Cover Image Preview in Creation Flow
**Screenshots:** `05-01-step1-basic-info.png`

The preview panel shows "No cover image" as text.

**Recommendation:** Show a placeholder image or icon to give better visual feedback of what the card will look like.

### 19. "Already Submitted" Tooltip Position
**Screenshot:** `03-03-already-submitted-tooltip.png`

The tooltip explaining "This image is already submitted to this crucible" appears over the dropzone area, potentially blocking interaction.

**Recommendation:** Position tooltip below or beside the triggering element to avoid blocking other UI.

---

## Summary

| Priority | Count | Categories |
|----------|-------|------------|
| Critical | 3 | Data display bugs, empty states |
| Refinement | 7 | Counter sync, labels, badges |
| Polish | 5 | Hover states, colors, indicators |
| Enhancement | 4 | Suggestions, visualizations |

**Total Issues Identified:** 19
