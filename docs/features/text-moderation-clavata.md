# User-Generated Text Moderation through Clavata

This document explains how Civitai moderates user-generated text content using the Clavata AI moderation service. The system automatically scans text content across the platform for policy violations, spam, harassment, and other harmful content.

## Architecture Overview

The text moderation system consists of several key components:

- **Clavata Integration**: AI-powered content moderation service
- **Job Queue System**: Queues content for moderation processing
- **Word/URL Blocklists**: Pre-filtering using configurable blocklists
- **Report Generation**: Automatic report creation for policy violations
- **Redis Configuration**: Dynamic policy and entity management
- **Multi-Entity Support**: Moderation across different content types

## Core Components

### Clavata SDK Integration (`src/server/integrations/clavata.ts`)

#### Primary SDK
```typescript
export const clavataSDK = env.CLAVATA_TOKEN
  ? new Clavata({ apiKey: env.CLAVATA_TOKEN })
  : undefined;
```

#### Streaming Evaluation
```typescript
export const clavataEvaluate = async function* (
  request: EvaluateRequest,
  confidenceThreshold = 0.5
) {
  // Streams moderation results with confidence scoring
  // Filters results above threshold
  // Returns structured tags and outcomes
}
```

#### Legacy API Client
Fallback implementation with direct API calls for image processing and synchronous operations.

### Environment Configuration

Required environment variables in `src/env/server-schema.ts`:

```
CLAVATA_ENDPOINT: z.url().optional(),     // API endpoint URL
CLAVATA_TOKEN: z.string().optional(),     // Authentication token
CLAVATA_POLICY: z.string().optional(),    // Default policy ID
CLAVATA_SCAN: z.enum(['off', 'shadow', 'active']).default('shadow'),
```

**Scan Modes**:
- `off`: No scanning performed
- `shadow`: Scanning performed but no actions taken (logging only)
- `active`: Full moderation with report generation and actions

## Supported Content Types

The system moderates text content from multiple entity types:

### Primary Entities (Job Queue Based)
```typescript
const queues = {
  Comment: { fields: { content: true } },
  CommentV2: { fields: { content: true } },
  User: { fields: { username: true } },
  UserProfile: { fields: { bio: true, message: true } },
  Model: { fields: { name: true, description: true } },
  Post: { fields: { title: true, detail: true } },
  ResourceReview: { fields: { details: true } },
  Article: { fields: { title: true, content: true } },
  Bounty: { fields: { name: true, description: true } },
  BountyEntry: { fields: { description: true } },
  Collection: { fields: { name: true, description: true } },
};
```

### Special Entities (Direct Processing)
```typescript
const special = {
  Chat: { fields: { content: true } },  // Real-time chat moderation
};
```

Each entity type can have:
- **Multiple fields** moderated per entity
- **Custom ID keys** for non-standard primary keys
- **User tracking** for attribution and reporting

## Moderation Workflow

### 1. Content Ingestion
Content enters the moderation pipeline through two paths:

#### A. Job Queue System
- **Trigger**: Database triggers populate `JobQueue` table
- **Type**: `JobQueueType.ModerationRequest`
- **Processing**: Batch processing every 5 minutes
- **Entities**: All primary content types

#### B. Real-time Processing
- **Trigger**: Direct processing on content creation
- **Type**: Chat messages specifically
- **Processing**: Immediate scanning with time-based chunking
- **Grouping**: Multiple messages per chat combined for context

### 2. Pre-filtering with Blocklists

Before sending to Clavata, content is pre-filtered using configurable blocklists. This is currently off, but can easily be turned back on in redis.

#### Word Blocklist Processing
```typescript
function adjustModWordBlocklist(word: string) {
  // Generates multiple regex patterns for:
  // - Plural forms (nouns)
  // - Verb conjugations (past, present, gerund, participle)
  // - Character substitutions (i→[i|l|1], o→[o|0], etc.)
  // - Word boundary matching
}
```

#### URL Blocklist
- Domain and URL pattern matching
- Configurable through Redis
- Prevents spam and malicious link distribution

#### Blocklist Configuration
Stored in Redis under `REDIS_SYS_KEYS.ENTITY_MODERATION`:
- `WORDLISTS`: Array of wordlist names
- `URLLISTS`: Array of URL blocklist names
- `RUN_WORDLISTS`: Boolean to enable/disable pre-filtering

### 3. Clavata AI Processing

#### Request Structure
```typescript
const contentData = batch.map(({ id, value, userId }) => ({
  metadata: { id, type, userId, value },
  content: { value, $case: 'text' },
  contentType: 'text',
}));
```

#### Policy-Based Evaluation
- **Dynamic Policies**: Different policies per entity type
- **Confidence Thresholds**: Configurable scoring thresholds
- **Batch Processing**: Up to 100 items per batch
- **Streaming Results**: Real-time result processing

#### Result Processing
```typescript
const tags = reports
  ?.map((r) => ({
    tag: r.name,                    // Violation type
    confidence: Math.round(r.score * 100),  // Confidence percentage
    outcome: r.result,              // Pass/Fail result
    message: r.message,             // Explanation
  }))
  .filter((t) => t.confidence > confidenceThreshold * 100)
  .sort((a, b) => b.confidence - a.confidence);
```

### 4. Report Generation and Actions

#### Automatic Report Creation
When content violates policies:

```typescript
const report = await createReport({
  type: ReportEntity[type],           // Entity type
  id: metadata.id,                    // Entity ID
  userId: -1,                         // System user
  isModerator: true,                  // Bypass normal restrictions
  reason: ReportReason.Automated,     // Automated report flag
  details: {
    externalId: item.externalId,      // Clavata job ID
    externalType: ExternalModerationType.Clavata,
    entityId: metadata.id,
    tags: item.matches,               // Violation tags
    userId: metadata.userId,          // Content author
  },
});
```

#### Report Metadata Storage
```typescript
await dbWrite.reportAutomated.create({
  data: {
    reportId: report.id,
    metadata: {
      tags: item.tags,        // Detailed Clavata tags
      value: metadata.value,  // Original content (for review)
    },
  },
});
```

### 5. Analytics and Tracking

#### ClickHouse Tracking
```typescript
await tracker.moderationRequest({
  entityType: type,
  entityId: metadata.id,
  userId: metadata.userId,
  rules: item.matches,
  date: new Date(),
});
```

#### Prometheus Metrics
```typescript
clavataCounter?.inc(batch.length);  // Track API usage
```

## Configuration Management

### Redis-Based Configuration

All moderation configuration is stored in Redis for dynamic updates:

#### Policy Configuration
```json
{
  "default": "policy-id-123",
  "Comment": "comment-specific-policy",
  "Chat": "chat-policy-strict",
  "Model": "model-content-policy"
}
```

#### Entity Control
```
{
  "Comment": false,     // Disable Comment moderation
  "Chat": true,         // Enable Chat moderation
  "User": false         // Disable User moderation
}
```

#### Blocklist Management
- **Word Lists**: Named collections of blocked terms
- **URL Lists**: Named collections of blocked domains/patterns
- **Dynamic Updates**: No deployment required for changes

### Job Scheduling

Three main moderation jobs run automatically:

#### 1. Queue Processing Job
```typescript
const modQueueJob = createJob('entity-moderation-queues', '*/5 * * * *', modQueue);
```
- **Frequency**: Every 5 minutes
- **Function**: Process JobQueue entries
- **Scope**: All queued entities

#### 2. Chat Processing Job
```typescript
const modChatJob = createJob('entity-moderation-chat', '*/5 * * * *', modChat);
```
- **Frequency**: Every 5 minutes  
- **Function**: Process recent chat messages
- **Scope**: Chat messages since last run

#### 3. Cleanup Job
```typescript
const clearAutomatedJob = createJob('entity-moderation-clear-automated', '0 6 * * *', clearAutomatedReports);
```
- **Frequency**: Daily at 6 AM
- **Function**: Delete old automated reports
- **Retention**: 14 days

## Special Handling

### Chat Message Aggregation
Chat messages are processed differently due to their real-time nature, and context-aware requirements:

```typescript
const badMessagesByChat = badMessages.reduce((acc, cur) => {
  const key = `${cur.chatId}`;
  if (!acc[key]) {
    acc[key] = `[${cur.userId}]: ${cur.content}`;
  } else {
    acc[key] += ` | [${cur.userId}]: ${cur.content}`;
  }
  return acc;
}, {} as Record<string, string>);
```

- **Grouping**: Multiple messages per chat combined
- **Context**: Provides conversation context to AI
- **User Attribution**: Preserves individual message authors
- **Batch Processing**: Reduces API calls

### Collection Content Filtering
Special handling for repetitive default collection content:

```typescript
// Skip common default collection names/descriptions
if (type === 'Collection') {
  if (['Bookmarked Articles', 'Liked Models', 'Bookmarked Model'].includes(text)) 
    return false;
}
```

### NSFW Content Handling
Special logic for content that's NSFW but not violating other policies:

```typescript
const onlyNSFW = item.matches?.length === 1 && item.matches[0] === 'NSFW';
const allowedNSFWTypes: AllModKeys[] = ['Bounty', 'Model'];

if (item.result === 'FALSE' || (onlyNSFW && !allowedNSFWTypes.includes(type))) {
  // Skip report creation for NSFW-only content on allowed types
}
```

## Development Guidelines

### Adding New Entity Types

1. **Add to EntityType enum** (if not exists)
2. **Configure queue entry**:
   ```
   NewEntity: {
     fields: { fieldName: true, anotherField: true },
     selector: dbRead.newEntity,
     idKey: 'id',         // Optional, defaults to 'id'
     userIdKey: 'userId', // Optional, defaults to 'userId'
   },
   ```
3. **Set up database triggers** to populate JobQueue
4. **Configure Redis policies** for the new entity type
5. **Test with sample content**
