# Crucible Landing Page - Visual Comparison Findings

**Tested**: 2026-01-17
**Mockup**: `docs/features/crucible/mockups/landing.html`
**Live URL**: `http://localhost:3000/crucibles/15`

## Summary
- Critical: 0 issues
- Major: 5 issues
- Minor: 8 issues

## Screenshots
- Mockup: `.browser/sessions/74ac8e34/screenshots/002-inspect.png`
- Live (hero): `.browser/sessions/74ac8e34/screenshots/016-chunk-scroll-up-to-middle-section.png`
- Live (content): `.browser/sessions/74ac8e34/screenshots/017-chunk-scroll-down-to-stats-section.png`
- Live (bottom): `.browser/sessions/74ac8e34/screenshots/015-chunk-click-on-content-area-and-use-pagedown.png`

---

## Findings

### Major Issues

#### 1. Missing Hero Background Image
- **Mockup**: Shows a beautiful background image (`picsum.photos`) with overlay gradient
- **Live**: Plain blue gradient background only - no hero image
- **Severity**: Major
- **Impact**: Hero section looks significantly less engaging without background imagery

#### 2. Missing Leaderboard Top 3 Positions
- **Mockup**: Shows 1st, 2nd, 3rd place positions with:
  - Medal badges (gold, silver, bronze)
  - Current leader names (@aurora_flux, @portrait_wizard, @flux_artisan)
  - Scores (92 pts, 87 pts, 84 pts)
  - Prize percentages (50%, 30%, 15%)
- **Live**: Shows only "No entries yet" and "4th - 10th Place" distribution
- **Severity**: Major
- **Note**: This is **expected empty state behavior** - will resolve when entries exist

#### 3. Missing "Your Entries" Section in Main Content Area
- **Mockup**: Shows a dedicated "Your Entries" section in the main content area (left column) with:
  - "Your Entries (2 of 5)" heading with icon
  - Entry cards showing user's own entries
  - Position badges showing current rank (#3, #7)
  - Stats (likes, views)
- **Live**: Missing entirely - no "Your Entries" section in main content
- **Severity**: Major
- **Note**: May be hidden because user has no entries - **expected empty state behavior**

#### 4. Missing Entry Cards Grid
- **Mockup**: Shows "All Entries (47)" with:
  - Responsive grid of entry cards (4-5 columns)
  - Each card has: image, title, author, likes, views
  - Image zoom effect on hover
  - Infinite scroll indicator at bottom
- **Live**: Shows "All Entries (0)" with empty state:
  - Placeholder image icon
  - "No entries yet" text
  - "Be the first to submit an entry!" prompt
- **Severity**: Major
- **Note**: This is **expected empty state behavior** - will resolve when entries exist

#### 5. Stats Show Zero Values
- **Mockup**: 47 Entries, 923 Judges, 4d 12h Time Left
- **Live**: 0 Entries, 0 Judges, 7h 47m Time Left
- **Severity**: Major
- **Note**: This is **expected empty state behavior** - reflects actual data

---

### Minor Issues

#### 1. Hero Section Creator Avatar Style Difference
- **Mockup**: Circular avatar with gradient background (purple-blue), initials "CT"
- **Live**: Circular avatar with user initials "JU", solid color background
- **Severity**: Minor
- **Note**: Mockup uses stylized avatar, live uses actual user avatar system

#### 2. Status Badge Position Difference
- **Mockup**: Status badge ("ACTIVE NOW") appears above the title inside overlay card
- **Live**: Status badge appears in the same position with same styling (matches)
- **Severity**: Minor - Actually matches well

#### 3. Hero Overlay Card Width
- **Mockup**: Overlay card has max-width: 600px and appears on left side
- **Live**: Overlay card appears similar but may have different max-width
- **Severity**: Minor

#### 4. Stats Grid Layout
- **Mockup**: 3-column grid with dark card backgrounds
- **Live**: 3-column grid with same layout (matches well)
- **Severity**: Minor - Matches

#### 5. CTA Button Style
- **Mockup**: "Start Judging Now" with gavel icon, blue-to-green gradient
- **Live**: "Start Judging Now" with same gradient and gavel icon (matches)
- **Severity**: Minor - Matches well

#### 6. Sidebar "Submit Entry" Button Position
- **Mockup**: "Submit Entry" is secondary (gray) button below "YOUR ENTRIES" title
- **Live**: "Submit Entry" is prominent teal/green button below "YOUR ENTRIES"
- **Severity**: Minor
- **Note**: Live button may be more prominent which could be intentional UX improvement

#### 7. Entry Fee Display
- **Mockup**: "Entry Fee: 500 Buzz"
- **Live**: "ENTRY FEE: 10 BUZZ" (with yellow buzz icon)
- **Severity**: Minor
- **Note**: Different test data - mockup is design placeholder

#### 8. Rules Section Content Differences
- **Mockup**: Shows multiple content level badges (PG, PG-13, R), specific deadline (Jan 29, 2025), format requirements
- **Live**: Shows only "PG" badge, deadline Jan 17, 2026, max entries per user, tie-breaking rules
- **Severity**: Minor
- **Note**: Live shows accurate data from database, additional rules fields shown

---

## Empty State vs Populated State Analysis

The live page is testing against a crucible with **0 entries and 0 judges**. Many "missing" elements are actually correct empty state behavior:

| Feature | Mockup (Populated) | Live (Empty) | Correct Empty State? |
|---------|-------------------|--------------|---------------------|
| Entry cards grid | 12 sample entries | "No entries yet" placeholder | Yes - correct |
| Your Entries section | 2 user entries | Not shown | Yes - hides when empty |
| Leaderboard top 3 | Sample leaders | "No entries yet" | Yes - correct |
| Stats (entries/judges) | 47/923 | 0/0 | Yes - shows real data |
| Prize pool | 100,000 Buzz | 0 Buzz | Yes - shows real data |

---

## Matches (Working Correctly)

These elements match the mockup well:

1. **Page Header Structure**: Navigation, logo, search, user profile area
2. **Hero Section Layout**: Overlay card positioning, status badge, title, description, creator info
3. **Stats Grid**: 3-column layout with proper styling
4. **"Start Judging Now" CTA**: Full-width gradient button with icon
5. **Sidebar Layout**: YOUR ENTRIES panel, Prize Pool section, Rules section
6. **Rules & Requirements Section**: Content levels, deadline, judging info
7. **Overall 2-column Layout**: Main content (left) + sidebar (right)

---

## Recommendations

### High Priority
1. **Hero Background Image**: Implement hero image upload/display for crucibles - currently shows only gradient
2. **Verify Populated State**: Test with a crucible that has actual entries to validate entry cards, leaderboard, and user entries display correctly

### Medium Priority
3. Consider making the hero background image optional with a fallback gradient (current behavior may be intentional)
4. Test "Your Entries" section visibility when logged-in user has entries

### Low Priority
5. Minor styling tweaks to match mockup button styles more closely
6. Consider adding Format requirements to Rules section if applicable

---

## Testing Notes

- Used browser automation (Playwright) via localhost:9222
- Page uses fixed layout with internal scrolling in main content area
- Had to use keyboard navigation (PageDown/End) to scroll content
- Full page screenshots captured body but not internal scroll content
- Multiple screenshots needed to capture full page content
