# Crucible Discovery Page - Visual Comparison Findings

**Tested**: 2026-01-17
**Mockup**: docs/features/crucible/mockups/discovery.html
**Live URL**: http://localhost:3000/crucibles

## Summary
- Critical: 1 issue
- Major: 6 issues
- Minor: 5 issues

## Screenshots
- Mockup: `.browser/sessions/187fc275/screenshots/002-inspect.png`
- Live (full page): `.browser/sessions/187fc275/screenshots/010-chunk-set-larger-viewport.png`

---

## Findings

### Critical

#### 1. Missing Featured Hero Card Section
**Mockup**: Shows a large featured "Ultra Quality Challenge 2025" hero card with:
- Split layout (image left, content right)
- "Paid Placement" badge in gold
- Large prize pool display (50,000 Buzz)
- Time remaining and entries count
- "Enter Competition" and "Learn More" buttons

**Live**: No featured hero card section exists. The discovery grid goes directly from the filter tabs to the crucible card grid with no featured/promoted crucible highlight.

**Impact**: Major promotional feature for high-value crucibles is completely missing.

---

### Major

#### 1. Page Header Title Mismatch
**Mockup**: "Crucible Discovery"
**Live**: "Crucibles"
**Impact**: Different branding/naming convention. Mockup suggests this is a discovery-focused page.

#### 2. Create Crucible Button Location and Style
**Mockup**: Blue primary button "Create Crucible" with + icon in the header section, right-aligned
**Live**: "Create" button is in the top navigation bar (next to search), not in the page header section
**Impact**: Create action is less prominent and not contextually placed with the page title.

#### 3. "Your Active Crucibles" Section Layout Differences
**Mockup**:
- Shows 3 active crucible cards in a horizontal carousel
- Each card has colorful gradient background with icon
- Position badge overlay (e.g., "#3", "#1", "#7")
- Both "View" and "Submit" buttons on each card

**Live**:
- Shows only 1 active crucible card (single column, not carousel)
- Card has placeholder blue background (no image/gradient)
- No position badge visible
- Has "View" and "Submit" buttons (matches mockup)

**Impact**: Carousel layout vs single card, missing position badges.

#### 4. Discovery Grid Section Title Missing
**Mockup**: Has "Discover Crucibles" section header and "High Stakes Crucibles" subsection title
**Live**: No "Discover Crucibles" header. Filter tabs appear directly. No section title for the grid.
**Impact**: Missing contextual headers for the discovery section.

#### 5. Crucible Card Design Differences
**Mockup Cards**:
- Colorful gradient backgrounds (blue, green, orange, red, purple)
- Icon centered in card image area
- Status badge in top-right ("ACTIVE", "ENDING SOON")
- Card meta shows: Prize Pool, Time Left, Entries, Participants
- Status indicator with dot and text ("Active - Accepting entries")

**Live Cards**:
- Placeholder image areas (mostly dark/empty, some with actual images)
- "PG" badge in top-left corner (content rating)
- "ACTIVE" badge in top-right
- Creator name displayed (e.g., "JustMaier")
- Card shows: Buzz amount, time, entries
- Status dot indicator with "Ending Soon" text

**Impact**: Different card information hierarchy and visual design.

#### 6. "View Recent Results" Dropdown Missing
**Mockup**: Has a "View Recent Results" button/dropdown below the active crucibles section showing past competition results with positions and Buzz won
**Live**: No recent results section exists
**Impact**: Missing historical participation data for user engagement.

---

### Minor

#### 1. User Stats Card Styling
**Mockup**: Individual stat cards with large colored icons above label, centered layout
**Live**: Similar layout with icons but different visual styling (flatter, less prominent)
**Impact**: Minor visual difference in stat presentation.

#### 2. Filter Tabs Underline Style
**Mockup**: Active tab has blue underline indicator
**Live**: Active tab (Featured) has blue underline indicator
**Impact**: Matches! This is consistent.

#### 3. Sort Dropdown Position
**Mockup**: "Prize Pool" dropdown right-aligned with filter tabs
**Live**: "Prize Pool" dropdown right-aligned with filter tabs
**Impact**: Matches! This is consistent.

#### 4. Welcome Message Personalization
**Mockup**: "Welcome back, Alex!"
**Live**: "Welcome back, JustMaier!"
**Impact**: Correctly personalized to logged-in user. Working as expected.

#### 5. Infinite Scroll Indicator
**Mockup**: Shows "Loading more crucibles..." with spinner at bottom
**Live**: Not visible (page has enough crucibles to fill viewport)
**Impact**: Will need to scroll to verify if infinite loading works.

---

## Test Crucibles Verification

**Expected** (from PRD): 4 test crucibles - "Primary, Landscapes, Portrait Masters, Quick Challenge"

**Found on page**:
1. **Your Active Crucibles (1)**: "Visual Test Crucible - Primary" (50 Buzz, 1 hour left)
2. **Discovery Grid (8+ visible)**:
   - Test Crucible - Landing Page Comparison (0 Buzz, 2 hours)
   - Submission Test (0 Buzz, 5 hours)
   - Concurrent Test B (0 Buzz, 7 hours)
   - Concurrent Test A (0 Buzz, 7 hours)
   - Flow Test Crucible (0 Buzz, 7 hours)
   - Session Flow Test (0 Buzz, 8 hours)
   - Flow Test Crucible (duplicate, 0 Buzz, 8 hours)
   - Test Crucible (0 Buzz, 8 hours) - this one has actual cover image

**Note**: The specific 4 test crucibles mentioned in the PRD were not found. The shared-state.json file did not exist, indicating those test crucibles may not have been created by a previous test run. The page shows various other test crucibles that appear to be from different test sessions.

---

## Functional Elements Status

| Element | Mockup | Live | Status |
|---------|--------|------|--------|
| Page Header | "Crucible Discovery" | "Crucibles" | Different |
| Create Crucible Button | In header | In nav bar | Different location |
| User Welcome Section | Yes | Yes | Match |
| User Stats (4 cards) | Yes | Yes | Match |
| Your Active Crucibles | 3 cards, carousel | 1 card, single | Different |
| View Recent Results | Yes | No | Missing |
| Filter Tabs | 4 tabs | 4 tabs | Match |
| Sort Dropdown | Yes | Yes | Match |
| Featured Hero Card | Yes | No | Missing |
| Grid Section Title | Yes | No | Missing |
| Crucible Card Grid | Yes | Yes | Match (different design) |
| Infinite Scroll | Yes | Not verified | - |

---

## Recommendations

1. **Critical**: Implement featured hero card section for promoted/high-value crucibles
2. **Major**: Add "Discover Crucibles" and section titles for better content hierarchy
3. **Major**: Implement carousel for active crucibles when user has multiple
4. **Major**: Add position badges to active crucible cards
5. **Major**: Implement "View Recent Results" dropdown for user engagement
6. **Minor**: Consider moving Create button to page header for better visibility
