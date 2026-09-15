# Crucible Discovery Page - Browser Flow

## Flow Name
`crucible-discovery-review`

## Purpose
Automated browser flow for reviewing the Crucible Discovery page at `/crucibles`. This flow captures the key UI elements and interactions for visual review.

## How to Run

```bash
# Run with member profile (default)
curl -X POST http://localhost:9222/flows/crucible-discovery-review/run \
  -d '{"profile": "member"}'

# Run headless
curl -X POST http://localhost:9222/flows/crucible-discovery-review/run \
  -d '{"profile": "member", "headless": true}'
```

## Flow Steps

1. **Scroll to filter tabs section** - Scrolls the Featured tab into view
2. **Click Ending Soon tab** - Switches to Ending Soon sort
3. **Click High Stakes tab** - Switches to High Stakes (Prize Pool) sort
4. **Click New tab** - Switches to Newest sort
5. **Open sort dropdown** - Opens the sort dropdown showing all options
6. **Close sort dropdown** - Presses Escape to close the dropdown

## UI Elements Captured

### Header Section
- Civitai logo and navigation
- Search bar
- Create button
- User profile/Buzz balance

### User Welcome Section
- "Welcome back, [username]!" greeting
- User stats cards:
  - Total Crucibles
  - Buzz Won
  - Best Placement
  - Win Rate

### Your Active Crucibles Carousel
- Cards showing crucibles user has entered
- Prize Pool and Time Left info
- View/Submit buttons

### Discover Crucibles Section
- Filter tabs: Featured, Ending Soon, High Stakes, New
- Sort dropdown: Prize Pool, Ending Soon, Newest, Most Entries
- Crucible grid cards with:
  - Rating badge (PG, etc.)
  - Active status badge
  - Cover image
  - Creator name

## Screenshots Location
Screenshots are saved to the session directory during flow execution:
`.browser/sessions/{sessionId}/screenshots/`

## Notes
- Flow requires `member` profile for authenticated user experience
- The page uses client-side routing so URL updates with sort parameters
- Images load lazily as sections scroll into view
