# Daily Challenge System

This document explains how the daily challenge system works in Civitai. The system runs automated AI-powered creative challenges that feature community-created models, allowing users to compete for prizes by generating images using specific resources.

## Architecture Overview

The daily challenge system consists of several key components:

- **Challenge Table**: Dedicated `Challenge` entity (not Articles) with full lifecycle management
- **Automated Jobs**: Three scheduled jobs handle challenge setup, entry processing, and winner selection
- **LLM Integration**: GPT-4O powers content generation and entry scoring
- **Scoring System**: Hybrid scoring combining AI judgment (75%) and community engagement (25%)
- **Prize Distribution**: Automated Buzz rewards for winners and participation prizes
- **Completion Summary**: AI-generated judging process and outcome stored in challenge metadata

## System Flow

### Challenge Lifecycle

1. **Setup Phase** (10 PM UTC daily): Creates new challenge with randomly selected model/resource
2. **Active Phase** (24 hours): Users submit images, entries are continuously reviewed
3. **Completion Phase** (Midnight UTC): Winners selected, prizes distributed, next challenge begins

### Scheduled Jobs

| Job | Schedule | Function |
|-----|----------|----------|
| `daily-challenge-setup` | `0 22 * * *` (10 PM UTC) | Creates upcoming challenges |
| `daily-challenge-process-entries` | `*/10 * * * *` (Every 10 mins) | Reviews and scores entries |
| `daily-challenge-pick-winners` | `0 0 * * *` (Midnight UTC) | Selects winners, distributes prizes |

## LLM Integration

The system uses GPT-4O for AI-powered content generation and scoring. LLM prompts are stored in the `ChallengeType` database table.

### LLM Functions

#### 1. Collection Details Generation
- **Purpose**: Create metadata for the challenge collection
- **Output**: Collection name and description based on the featured resource

#### 2. Challenge Content Generation
- **Purpose**: Create the challenge content (title, description, invitation, theme)
- **Output**:
  - Challenge title
  - Markdown description content
  - Invitation text to participate
  - Theme (1-2 words, e.g., "SynthwavePunk")

#### 3. Entry Review
- **Purpose**: Score each submitted entry
- **Triggered**: Every 10 minutes for new submissions
- **Output**:
  ```json
  {
    "score": {
      "theme": 0-10,      // Adherence to challenge theme
      "wittiness": 0-10,  // Cleverness of interpretation
      "humor": 0-10,      // How funny/entertaining
      "aesthetic": 0-10   // Visual quality and appeal
    },
    "reaction": "emoji",  // Laugh, Heart, Like, or Cry
    "comment": "string",  // Detailed feedback on submission
    "summary": "string"   // Concise 1-2 sentence description
  }
  ```
- The comment and reaction are posted directly to the submitted image

#### 4. Winner Selection
- **Purpose**: Pick final winners from top candidates
- **Input**: Top 10 scored entries with their summaries and scores
- **Output**:
  - List of winners with reasons for selection
  - Description of the judging process
  - Challenge outcome summary

## Scoring System

### Entry Validation

Before scoring, each submission must pass automatic filtering:

1. **Safe Content**: `nsfwLevel = 1` (SFW only)
2. **Required Resource**: Image must use the featured model/resource
3. **Recency**: Image created on or after challenge start date (prevents reusing old images)

Entries failing any check are automatically rejected.

### AI Scoring

Each accepted entry receives scores in four dimensions (0-10 each):
- **Theme**: How well the image matches the challenge theme
- **Wittiness**: Cleverness of the creative interpretation
- **Humor**: Entertainment value
- **Aesthetic**: Visual quality and artistic merit

### Final Ranking Formula

```
Weighted Rating = (AI Rating × 0.75) + (Engagement Score × 0.25)

Where:
- AI Rating = Average of [theme, wittiness, humor, aesthetic]
- Engagement Score = Normalized sum of [views, comments, reactions]
```

The engagement score is normalized using min/max scaling to a 0-10 range across all entries.

## Winner Selection Process

### Selection Steps

1. **Close Collection**: No new submissions accepted
2. **Rank Entries**: Sort by weighted rating
3. **Deduplicate**: One entry per user (top entry only)
4. **Final Judgment**: Top 10 entries sent to LLM for final selection
5. **Winner Prize Distribution**: Winners receive Buzz rewards (yellow Buzz)
6. **Entry Prize Distribution**: All eligible participants receive entry prizes (blue Buzz)
7. **Completion Summary**: AI-generated judging process and outcome stored in `Challenge.metadata.completionSummary`
8. **Notifications**: Winners and entry prize recipients notified via in-app notifications

### Completion Summary

When a challenge completes, the AI generates content that is stored in `Challenge.metadata.completionSummary`:

```typescript
{
  judgingProcess: string;  // HTML describing how winners were selected
  outcome: string;         // HTML summary of the challenge outcome
  completedAt: string;     // ISO timestamp of completion
}
```

This content is displayed on the challenge detail page in the Winners section.

### Prize Structure

| Position | Buzz | Points | Buzz Type |
|----------|------|--------|-----------|
| 1st Place | 5,000 | 150 | Yellow |
| 2nd Place | 2,500 | 100 | Yellow |
| 3rd Place | 1,500 | 50 | Yellow |

**Participation Prize**: Users who submit 10+ valid (accepted) entries receive 200 Buzz (blue) and 10 points.

Entry participation prizes are sent at two times:
1. **During the challenge**: When entries are reviewed and users first meet the requirement
2. **At completion**: Final sweep to ensure all eligible non-winners receive their entry prizes

Note: Winners are excluded from entry prizes (they receive the larger winner prizes instead).

## Anti-Gaming Measures

The system includes several mechanisms to ensure fair competition:

- **User Cooldown**: Creators can only be featured every 14 days
- **Resource Cooldown**: Each resource can only be featured every 90 days
- **Entry Limits**: Maximum 2× the entry requirement per user (e.g., 20 entries for 10-entry requirement)
- **Per-User Scored Cap**: Maximum 5 entries per user can be scored per challenge (`maxScoredPerUser: 5`), preventing volume-based advantage
- **Best-Entry-Per-User Selection**: Final judgment considers only each user's single best-scoring entry, ensuring fair competition based on quality not quantity
- **One Winner Per User**: Top 10 ensures diversity in final selection
- **Image Recency**: Only images created during the challenge period qualify

## Configuration

Default challenge configuration:

```typescript
{
  challengeType: 'world-morph',
  userCooldown: '14 day',
  resourceCooldown: '90 day',
  prizes: [
    { buzz: 5000, points: 150 },
    { buzz: 2500, points: 100 },
    { buzz: 1500, points: 50 }
  ],
  entryPrizeRequirement: 10,
  entryPrize: { buzz: 200, points: 10 },
  reviewAmount: { min: 2, max: 6 },
  maxScoredPerUser: 5,          // Maximum entries that can be scored per user per challenge
  finalReviewAmount: 10
}
```

## Key Files

| File | Purpose |
|------|---------|
| `src/server/jobs/daily-challenge-processing.ts` | Main job logic (setup, review, winners) |
| `src/server/games/daily-challenge/generative-content.ts` | LLM integrations |
| `src/server/games/daily-challenge/daily-challenge.utils.ts` | Config and state management |
| `src/server/games/daily-challenge/challenge-helpers.ts` | Challenge CRUD and winner management |
| `src/server/services/challenge.service.ts` | Challenge service (CRUD, manual actions) |
| `src/server/routers/challenge.router.ts` | Challenge tRPC routes |
| `src/server/schema/challenge.schema.ts` | Challenge types and validation schemas |
| `src/pages/challenges/[id]/[[...slug]].tsx` | Challenge detail page |
| `src/components/Challenge/challenge.utils.ts` | Frontend utilities |

## Database Tables

### ChallengeType
Stores challenge type definitions and LLM prompts:
- `promptSystemMessage`: Base system context
- `promptCollection`: Collection generation instructions
- `promptArticle`: Challenge content generation instructions (title, description, invitation, theme)
- `promptReview`: Entry scoring instructions
- `promptWinner`: Winner selection instructions

### Challenge State
Challenge state and configuration are stored in Redis:
- `REDIS_SYS_KEYS.DAILY_CHALLENGE.CONFIG`: Current configuration
- Custom challenges can be set via Redis with automatic end date management
