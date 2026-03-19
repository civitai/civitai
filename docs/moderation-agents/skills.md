# Moderation Agent Skills

Skills are standalone scripts that agents invoke via tool-use. Each skill does one thing, takes typed input, returns typed output. Skills live outside this repo and call Civitai APIs, ClickHouse, Postgres, and the orchestrator.

## Architecture

```
skills/
  review/         # Read-only data retrieval
  orchestrator/   # External service calls (VLM, scanning, generation)
  moderation/     # Actions that change user/content state
  processing/     # Communications and note-taking
lib/
  civitai-api.ts  # tRPC API client (Bearer token auth)
  civitai-db.ts   # Civitai Postgres client (read-only for review skills)
  clickhouse.ts   # ClickHouse client
  orchestrator.ts # Orchestrator API client (Bearer token auth)
  retool-db.ts    # Retool Postgres client (for UserNotes)
  types.ts        # Shared input/output types
```

Each skill exports a single function: `execute(input) => output`. Skills share no state. An agent calls skills as it sees fit via tool-use, then reasons over results.

### Shared Libraries

All skills share a few common clients:

- **`civitai-api.ts`**: Wraps tRPC calls. Pattern: `POST ${API_URL}/api/trpc/${procedure}` with `Authorization: Bearer ${API_KEY}` and body `{ json: input }`. Response: `data.result?.data?.json`. See `mod-actions/query.mjs` for reference implementation.
- **`civitai-db.ts`**: Direct Postgres client for the Civitai database (read-only). Used by review skills that query Prisma-managed tables directly (reports, subscriptions, chat messages, etc.) when tRPC endpoints don't expose the needed data.
- **`clickhouse.ts`**: ClickHouse client for analytics queries. Connects to the same instance used by the Tracker class in `src/server/clickhouse/client.ts`.
- **`orchestrator.ts`**: Orchestrator workflow/API client. Auth: `Bearer ${ORCHESTRATOR_ACCESS_TOKEN}` to `${ORCHESTRATOR_ENDPOINT}`. Supports both OpenAI-compatible chat completions and workflow submissions.
- **`retool-db.ts`**: Direct Postgres client for the Retool database (UserNotes table).

---

## Review Skills

All read-only. Return structured data for agent reasoning.

### review/post-history

Retrieves a user's posted content across entity types.

**Input:** `{ userId: number, limit?: number, since?: Date }`
**Output:** `{ posts: Post[], images: Image[], models: Model[], articles: Article[], bounties: Bounty[] }`

**Implementation:**
- Query Postgres `Image` (where `userId`, ordered by `createdAt desc`)
- Query `Post` (where `userId`)
- Query `Model` (where `userId`)
- Query `Article` (where `userId`)
- Query `Bounty` (where `userId`)
- Include NSFW level, status, ingestion status on images
- Include model status, type on models

**Existing code:** `dbRead.image.findMany`, `dbRead.post.findMany`, etc. Standard Prisma queries.

---

### review/strike-history

@justin: pulled off on the implementation of this one. We're still cooking a new strike service, so this can be a placeholder for now.

@ai: Understood. Marking as placeholder. The existing consumer strike types (`ConsumerStrike`, `ConsumerStikesGroup`, `Flagged`) in `src/server/http/orchestrator/flagged-consumers.ts` are ready for when the new system lands. Will revisit once the strike service is defined.

Retrieves a user's strike history. **Placeholder pending new strike system.**

**Input:** `{ userId: number }`
**Output:** `{ groups: ConsumerStrikesGroup[], totalStrikes: number, unreviewedStrikes: number }`

**Implementation (current generation strikes only):**
- Call `getConsumerStrikes({ consumerId: String(userId) })` from orchestrator API
- Returns strikes grouped by status, each with: jobId, reason, dateTime, prompt, resources, image previews
- Also call `getFlagged()` to get aggregate counts
- Auth: `Bearer ${ORCHESTRATOR_ACCESS_TOKEN}` to `${ORCHESTRATOR_ENDPOINT}/v1/manager/consumers/flagged`
- Also check `UserRestriction` records in Postgres for prompt-auditing strikes

---

### review/generation-history

Retrieves a user's image generation prompts and parameters.

**Input:** `{ userId: number, limit?: number, since?: Date }` (default `since`: 30 days ago)
**Output:** `{ generations: { jobId: string, prompt: string, negativePrompt: string, params: object, createdAt: Date }[] }`

@justin: You can query this from ClickHouse. Go ahead and take a look at this table `orchestration.jobs` and you'll see what's there. It doesn't include the images that were generated there, but I do believe that it includes the job ID, and with the job ID you can query the orchestration service. You can try it out yourself by using the orchestration skill you have.

@ai: Found the `orchestration.jobs` table. It's a MergeTree table keyed by `createdAt`. Related tables include `orchestration.textToImageJobs` (successful jobs) and `orchestration.failedTextToImageJobs`. These tables track job metadata including prompts and params. For the actual generated images, we'd use the job ID to query the orchestrator service (which returns blob URLs with preview URLs). Will use the orchestration skill to test the roundtrip.

**Implementation:**
- Query ClickHouse `orchestration.jobs` where userId matches, ordered by `createdAt desc`
- Fields: jobId, prompt, negativePrompt, params, createdAt
- For generated images: use the jobId to query orchestrator service for blob results
- Also check `orchestration.textToImageJobs` for successful completions
- `orchestration.failedTextToImageJobs` for failures (useful for moderation context)

@justin: If date isn't specified, we'll want to have a default date that is something like 30 days ago, just so that we're not querying way too many jobs since the table is ordered by CreatedAt. Otherwise, we're going to be scanning a table with way too many rows.

@ai: Done. Default `since` to 30 days ago if not specified. Added to the input spec and implementation notes above.

---

### review/training-history

Retrieves a user's model training activity, including training data contents.

Three sub-commands for progressive drill-down:

**A) Training overview:** `{ userId }` → `{ trainings: { modelId, versionId, status, workflowId?, createdAt, trainingParams }[] }`
**B) Training captions:** `{ modelVersionId, limit? }` → `{ totalFiles: number, captions: { filename, caption }[] }`
**C) Training image:** `{ modelVersionId, filename }` → `{ image: base64 | url }`

@justin: I think we might actually want to open up the zip archive that's in the model file where it's training data because that's going to contain the caption for images and we'll be able to actually get a sense of what it is they're training on. So it's like, yes, we would go grab the information about what they trained and then the agent would probably need to have another ability in here to be able to get the zip archive and get the, I guess, the captions from the images and the results of the scan associated with this training run, which I believe it could get from the orchestrator. I think that we include, like, workflow ID on here and stuff. You should take a look and see what you can find. Let me know if you're able to see kind of what I'm talking about. You could even try and download a zip file and, and open it up. Let me know if you need some sort of key to do that.

@ai: Found it all. Here's the structure:

**ModelFile metadata** contains `trainingResults` (type `TrainingResultsV2`) with:
- `workflowId` — orchestrator workflow ID
- `submittedAt`, `startedAt`, `completedAt` — timestamps
- `epochs[]` — each with `modelUrl`, `sampleImages[]` (S3 URLs)
- `history[]` — status change log

**ZIP archive** is stored in S3, referenced by `ModelFile.url` where `type = 'Training Data'`. JSZip is used for extraction — see `unzipTrainingData()` in `src/utils/training.ts`. It filters out `__MACOSX/` and `.DS_STORE`, processes only valid media types.

**Captions** come from auto-labeling via orchestrator:
- `autoTagHandler()` — WD Tagger model (tags with confidence scores)
- `autoCaptionHandler()` — Joy Caption model (natural language captions)
- Response types: `TagDataResponse` and `CaptionDataResponse` in `training.service.ts`

**Scan results** can be retrieved from the orchestrator using the `workflowId`.

The moderator review page at `src/pages/moderator/review/training-data/[versionId].tsx` shows the full pattern for downloading, extracting, and displaying training data.

@justin: There's a lot here. We'll just need to pre-digest this or make it so that it can just get specific chunks of stuff from this, because some of these data sets are going to be pretty big. Obviously, we wouldn't want to just spit out all of the images. I could see it being maybe enough to take all of the captions. We're going to have to think about how we could help it work with this stuff. as I think about it, probably what we'll need to do is, you know, have a few different commands here. One, to just kind of get the history of what they've trained, and then one, to look inside of a specific training run for the captions for it, and it can request how many captions it wants to pull. And then the ability to go fetch a specific image associated with a caption. or a specific image by ID from the dataset. So that essentially it allows it to progressively get more information as it needs to, but doesn't give it at all at once.

@ai: Good call. Restructured into three progressive sub-commands:

**Sub-command A: Training overview** — `{ userId }` → list of training runs with modelId, versionId, status, workflowId, createdAt, trainingParams. Lightweight, no ZIP download.

**Sub-command B: Training captions** — `{ modelVersionId, limit?: number }` → download the ZIP for a specific training run, extract caption files (.txt), return up to `limit` captions (default 50). Returns: `{ totalFiles: number, captions: { filename: string, caption: string }[] }`.

**Sub-command C: Training image** — `{ modelVersionId, filename: string }` → fetch a specific image from the ZIP by filename. Returns the image data (or a temporary URL to it). The agent uses this to inspect individual images flagged by suspicious captions.

This lets the agent drill down progressively: overview → captions for a run → specific images.

**Implementation:**
- **A**: Query `ModelVersion` joined with `ModelFile` where `model.userId = userId` and `trainingStatus IS NOT NULL`. Return metadata only, no S3 download.
- **B**: Download ZIP from S3 via `ModelFile.url` where `type = 'Training Data'`, extract with JSZip via `unzipTrainingData()`, read `.txt` caption files, return up to `limit`.
- **C**: Download same ZIP, extract specific file by name, return as base64 or temp URL.

---

### review/buzz-purchase-history

Retrieves a user's buzz purchase transactions.

**Input:** `{ userId: number, limit?: number, since?: Date }`
**Output:** `{ purchases: { date: Date, amount: number, type: string, fromAccountType: string, toAccountType: string, transactionId: string, description: string }[] }`

@justin: rather than using the Buzz API, you should use ClickHouse here. It has all of the transaction history, and it's going to be way faster. Here's the table: default.buzzTransactions

@ai: Confirmed. The `default.buzzTransactions` table has columns: `transactionId`, `date`, `fromAccountType`, `fromAccountId`, `toAccountType`, `toAccountId`, `amount`, `type` (tip, dues, generation, boost, reward, purchase, etc.), `description`, `details` (JSON), `externalTransactionId`. Added `since` param defaulting to 90 days ago.

**Implementation:**
- Query ClickHouse `default.buzzTransactions` where `toAccountId = userId` and type indicates a purchase/credit
- Default `since` to 30 days ago if not specified
- Filter by purchase-related transaction types (purchase, reward, etc.)
- Order by `date desc`, apply `limit`

---

### review/buzz-spending-history

Summary of a user's buzz spending patterns for quick assessment.

**Input:** `{ userId: number, since?: Date }`
**Output:** `{ summary: { totalSpent: number, byCategory: Record<string, number>, byMonth: { month: string, amount: number }[] }, recentTransactions: { date: Date, amount: number, type: string, description: string }[] }`

@ai: Per Justin's feedback, restructured this as a summary/report rather than raw transaction list. Gives agents a quick read on how active a user is and what they spend buzz on, without dumping thousands of rows.

**Implementation:**
- Query ClickHouse `default.buzzTransactions` where `fromAccountId = userId` and amount > 0
- Aggregate by `type` for category breakdown (Generation, Training, Tip, Boost, etc.)
- Aggregate by month for trend data
- Include last N recent transactions for detail
- Default `since` to 90 days ago

---

### review/report-against-history

Retrieves reports filed against a user's content, with entity details inline.

**Input:** `{ userId: number, limit?: number, since?: Date }`
**Output:** `{ reports: { id: number, reason: string, status: string, entityType: string, entityId: number, createdAt: Date, details: object, entity: EntitySummary }[] }`

@justin: I think we'll probably want to have this be populated with the actual entity details as well. Otherwise, the agent's going to need some way to go get those entity details, and I don't know that we have that skill here. I think it makes more sense to instead just kind of like populate it with, you know, if it was a model with an ID of one, then to get some basic information about that model. If it was an image, same thing, basic information about the image, etc.

@ai: Agreed. Will include an `entity` field with a type-specific summary. For models: name, status, type, download count. For images: NSFW level, ingestion status, created date. For articles: title, status. Etc. This avoids the agent needing a separate lookup skill.

**Implementation:**
- Query `Report` joined through entity tables where entity's `userId` matches
- Report reasons: `TOSViolation`, `NSFW`, `Ownership`, `Claim`, `AdminAttention`, `CSAM`, `Automated`
- Report statuses: `Pending`, `Processing`, `Actioned`, `Unactioned`
- For each report, also fetch the entity's basic info via the appropriate join table (`ModelReport` -> `Model`, `ImageReport` -> `Image`, etc.)
- Include entity name/title, status, key metrics in the response
- Apply `limit` (default 50)

@justin: We probably should add a sense property to the inputs so they can say, "what reports have been against this person in the last 90 days?"

@ai: Added `since?: Date` to the input. Agent can say "reports against this user in the last 90 days" and the skill filters by `createdAt >= since`.

---

### review/deleted-images-history

Retrieves images blocked/deleted for TOS violations.

**Input:** `{ userId: number, limit?: number, since?: Date }`
**Output:** `{ images: { imageId: number, tosReason: string, violationType?: string, nsfw: string, time: Date, tags: string[], resources: number[] }[] }`

@justin: Actually, I think the better place to look is the images table in ClickHouse where the action type is delete TOS. We're actually working on overhauling that table to add some additional properties. You can read about that [here](docs\proposals\tos-violation-logging-overhaul.md). It'll be way faster than querying PG. Essentially, we should avoid querying Postgres as much as possible, especially with large tables like images.

@ai: Read the TOS violation logging overhaul proposal. The ClickHouse `images` table has columns: `type` (enum: Create, Delete, DeleteTOS, Tags, Resources, Restore, Play), `imageId`, `ownerId`, `userId` (moderator), `nsfw`, `tags`, `resources`, `tosReason`, `mediaType`, `time`. The proposal adds `violationType` (canonical reason) and `violationDetails` (free-text context). Using ClickHouse with `type = 'DeleteTOS'` is the right approach.

**Implementation:**
- Query ClickHouse `images` where `ownerId = userId` and `type = 'DeleteTOS'`
- Returns: imageId, tosReason, violationType (once overhaul lands), nsfw level, tags, resources, time
- Order by `time desc`, apply `limit`
- Once the overhaul ships, `violationType` will provide canonical violation categories instead of the coarse `tosReason` values

---

### review/reports-by-history

Retrieves reports a user has filed (reporter credibility signal).

**Input:** `{ userId: number, limit?: number }`
**Output:** `{ reports: { id: number, reason: string, status: string, entityType: string, createdAt: Date }[], stats: { total: number, actioned: number, dismissed: number, actionRate: number } }`

@justin: This is another one where you might look and see if we've got anything in ClickHouse that can represent this as well. You might look in the codebase to see where that's happening. I'd recommend looking at the ClickHouse client first. There's this ClickHouse tracker thing in there, and it might even have something for reports already. And I don't know if it tracks whether or not they were approved or not. Maybe, you know, querying against the reports table will be fast enough here. So maybe you don't need to do that, just letting you know. And then for the stats, I assume that we'd want it to be, you know, over some amount of time, because otherwise... I don't know, maybe it's fine to not be some amount of time. Maybe it's all time. Anyways, forget what I just said about amount of time. but I assume we wouldn't want to bring in all of their reports because there could be a lot. Same with getting somebody's report history. So probably need to have a limit there.

@ai: ClickHouse has a `reports` table (tracked via `tracker.report()`), but it only records report creation events — not status changes or outcomes. So for credibility stats (actioned vs dismissed), we'd need Postgres `Report` table where `status` is stored. Given that most users won't have thousands of reports, Postgres should be fine here with a limit. Added default limit of 100.

**Implementation:**
- Query Postgres `Report` where `userId` (the reporter), ordered by `createdAt desc`, limit 100
- Compute stats: total, actioned (status = Actioned), dismissed (status = Unactioned)
- `actionRate = actioned / total` — credibility signal

@justin: No need to hit the ClickHouse table here, since all we really care is about user stats and their credibility...

@ai: Agreed. Removed ClickHouse reference. Postgres `Report` table is sufficient for credibility stats. Keeps this skill simple.

---

### review/dms

Retrieves a user's chat messages.

**Input:** `{ userId: number, limit?: number }`
**Output:** `{ messages: { chatId: number, content: string, createdAt: Date, contentType: string }[] }`

@justin: Yeah, we already have visibility into somebody's DMs, and mods occasionally do review it when we get reports. So, I think it's good to have this as a surface for the agent.

@ai: Good to know. Will use the existing chat query patterns from `entity-moderation.ts:378`.

**Implementation:**
- Query `ChatMessage` where `userId`, ordered by `createdAt desc`
- `ChatMessageType`: `Markdown`, etc.
- Default limit 50

---

### review/membership-status

Retrieves a user's subscription and membership info.

**Input:** `{ userId: number }`
**Output:** `{ subscriptions: { id: string, status: string, productId: string, productName: string, buzzType: string, currentPeriodStart: Date, currentPeriodEnd: Date, cancelAtPeriodEnd: boolean, createdAt: Date }[] }`

@justin: You can just query the customer subscription table in Postgres. I'd recommend you actually take a look at that, query the database, and kind of see what's in there. We don't need to go look at Stripe or Paddle. The reality is we're not actually actively connected to either of those. Currently, the only subscriptions that exist are prepaid ones. I guess for Civitai.Green there are subscriptions through Stripe right now, but there are not very many. But the customer subscription should give you essentially everything you need.

@ai: Confirmed. `CustomerSubscription` has: `id`, `userId`, `buzzType` (default "yellow"), `metadata` (JSON), `status`, `priceId`, `productId`, `cancelAtPeriodEnd`, `cancelAt`, `canceledAt`, `currentPeriodStart`, `currentPeriodEnd`, `createdAt`, `endedAt`. Unique on `(userId, buzzType)`. No need to hit Stripe/Paddle.

**Implementation:**
- Query Postgres `CustomerSubscription` where `userId`
- Return all subscriptions with status, period dates, cancel state
- Join `Product` table on `productId` for product name and value

@justin: I think we will want the product name/value, so probably are going to need to join that.

@ai: Done. Updated output to include `productName` and `productValue` from the `Product` join. Updated implementation note above.

---

### review/user-metrics

Retrieves aggregate user metrics.

**Input:** `{ userId: number }`
**Output:** `{ metrics: UserMetric, stats: UserStat, flags: { isMuted: boolean, isBanned: boolean, bannedAt?: Date, muteConfirmedAt?: Date, accountCreated: Date } }`

@justin: Yeah, there's user metrics. There's a user metric table. You can check Postgres to see for yourself. I'm sorry I didn't have the tunnel open before. It's open now so you can see.

@ai: Confirmed both tables exist:

**`UserMetric`** (keyed by `userId` + `timeframe`): `followingCount`, `followerCount`, `reactionCount`, `hiddenCount`, `uploadCount`, `reviewCount`, `answerCount`, `answerAcceptCount`.

**`UserStat`** (materialized view, keyed by `userId`): `uploadCountAllTime`, `reviewCountAllTime`, `downloadCountAllTime`, `generationCountAllTime`, `followerCountAllTime`, `thumbsUpCountAllTime`, `thumbsDownCountAllTime`, `reactionCountAllTime`.

**Implementation:**
- Query `UserMetric` where `userId` and `timeframe = 'AllTime'` for breakdown
- Query `UserStat` where `userId` for all-time aggregates
- Query `User` for flags: `muted`, `bannedAt`, `muteConfirmedAt`, `createdAt`
- Combine into a single response

---

## Orchestrator Skills

These call external services. They produce new data rather than reading existing data. All use the orchestrator service at `${ORCHESTRATOR_ENDPOINT}` with `Bearer ${ORCHESTRATOR_ACCESS_TOKEN}` auth.

### orchestrator/describe-image

Generate a text description of an image using a VLM.

**Input:** `{ imageUrl: string, prompt?: string, maxTokens?: number }`
**Output:** `{ description: string }`

@justin: will be going with option three, but we support openai chat completions, example usage below. Can also be done as a standard workflow request... We'd replace the `gpt-4o` with our custom model name

@ai: Clear. Two options: direct OpenAI-compatible endpoint (simpler) or workflow endpoint (more flexible). For this skill, the chat completions endpoint is cleaner since it's a single-turn request. We'll replace `gpt-4o` with the actual model name once confirmed.

**Implementation — Option A (chat completions, preferred):**
```
POST ${ORCHESTRATOR_ENDPOINT}/v1/chat/completions
Authorization: Bearer ${ORCHESTRATOR_ACCESS_TOKEN}

{
  "model": "<custom-model-name>",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "<prompt>"},
      {"type": "image_url", "image_url": {"url": "<imageUrl>"}}
    ]
  }],
  "max_tokens": 200
}
```

**Option B (workflow endpoint):**
```
POST ${ORCHESTRATOR_ENDPOINT}/v2/consumer/workflows?whatif=false&wait=30

{
  "steps": [{
    "$type": "chatCompletion",
    "input": {
      "model": "<custom-model-name>",
      "messages": [{ "role": "user", "content": [...] }],
      "maxTokens": 200
    }
  }]
}
```

@dev: What's the custom model name to use instead of `gpt-4o`?

---

### orchestrator/generate-image

Generate test images using a model (for Model Review Agent).

**Input:** `{ modelVersionId: number, prompts: string[], params?: Partial<GenerationParams> }`
**Output:** `{ images: { url: string, prompt: string, seed: number }[] }`

@justin: and the other AI terms. Ultimately, I'm not wanting to build these skills or have them live inside of this repo at all. We're working inside of this repo right now just so that you have the context, but ultimately these should live somewhere else. And so the probably best thing to reference would be the orchestration skill that you have because essentially we're going to be making workflow requests or whatever. And so this script would essentially facilitate in doing that. One important thing to call out is that oftentimes what people are posting are LoRa's, which are essentially just adapters to base models. So the model version ID wouldn't be a single value, it's probably multiple values. You'll want to look at the places where we kind of build generation requests to kind of understand better what the input parameters should be. I suppose we can keep this simple, and they could just pass a single model version ID, and then we can go query and then read the database and see if, you know, that's a LoRa, and if it is, which base model it's intended to use, and then go try and run it on top of that base model. So that it keeps it simple for the agent so they don't need to go figure all of that out. Because ideally this is something that's easy for them to do. I'm also not sure if we want to expose all of the generation params, because it's kind of not going to be necessary. I mean, I guess they could be there, and then we'll just have good defaults. and just worry about them trying to override them, and there's a lot of options there that kind of just won't really matter. So, I guess we expose them still in case the description or whatever outlines parameters that should be used, but for the most part, I'm hoping agents won't tinker with those.

@ai: Makes sense. The skill handles LoRA detection internally:

1. Agent passes a single `modelVersionId`
2. Skill queries Postgres to check if it's a LoRA (via `ModelVersion` -> `Model.type`)
3. If LoRA, look up the intended base model from `ModelVersion.baseModel` field
4. Build the workflow request with both resources (base model + LoRA adapter)
5. Use sensible defaults for all generation params (steps, CFG, sampler, size)
6. Agent can override params if needed, but defaults should cover 95% of cases

Will follow the orchestration skill's workflow request pattern.

**Implementation:**
- Accept single `modelVersionId`, optional `prompts`, optional `params` with defaults
- Query DB: check model type. If LoRA, resolve base model from `baseModel` field
- Build workflow request via orchestrator `/v2/consumer/workflows` endpoint
- Use `createTextToImageStep` pattern from `src/server/services/orchestrator/textToImage/`
- Default params: steps=20, CFG=7, size=512x512 (or model-appropriate defaults)
- Poll for completion or use `?wait=30` for synchronous response
- Return generated image URLs from workflow result blobs

---

### orchestrator/scan-image

Run content classification on an image.

**Input:** `{ imageUrl: string }`
**Output:** `{ contentRating: string, contentRatingConfidence: number, isBlocked: boolean, isAI: boolean, isAIConfidence: number, isRealistic: boolean, isRealisticConfidence: number, isMinor: boolean, isMinorConfidence: number, faces: Face[] }`

@justin: This is going to be a direct request to the orchestrator rather than going through anything else in this repo right now.
@justin: I just got the job spec for this from a teammate. It doesn't include WD tagging, but I don't know that we need to include that anyways.

@ai: Agreed on dropping WD tagging — the VLM skill is better for detailed content analysis. The `mediaRating` job covers everything we need: content rating, age classification, face recognition, AI detection, and realistic detection. All in one request.

**Implementation — `mediaRating` workflow step:**
```json
{
  "$type": "mediaRating",
  "input": {
    "mediaUrl": "<imageUrl>",
    "engine": "civitai",
    "includeContentRatingClassification": true,
    "includeAgeClassification": true,
    "includeFaceRecognition": true,
    "includeAIRecognition": true,
    "includeRealisticRecognition": true
  }
}
```

**Response:**
```json
{
  "contentRating": "x",
  "contentRatingConfidence": 0.999,
  "isBlocked": false,
  "isAI": true, "isAIConfidence": 0.998,
  "isRealistic": false, "isRealisticConfidence": 0.992,
  "isMinor": false, "isMinorConfidence": 0.658,
  "faces": [{
    "boundingBox": { "x1": 286, "y1": 17, "x2": 527, "y2": 249 },
    "age": "Teenager 13-20",
    "confidence": 0.658,
    "ageTopK": { "Adult 21-44": 0.247, "Child 0-12": 0.074, "Teenager 13-20": 0.658, ... }
  }]
}
```

Note: `isMinor` is true if *any* face is classified as minor. `isMinorConfidence` is the highest confidence among minor-classified faces.

---

### orchestrator/blur-image

Blur regions of an image (inclusive or exclusive bounding boxes).

**Input:** `{ imageUrl: string, blur: number, mode: 'include' | 'exclude', regions: { x1: number, y1: number, x2: number, y2: number }[] }`
**Output:** `{ blob: ImageBlob }`

@justin: This will be available through the orchestrator.

@ai: Got it. Using the `blurImage` job type. The output blob includes URL, preview URL, expiry, and dimensions.

**Implementation — `blurImage` workflow step:**
```json
{
  "$type": "blurImage",
  "input": {
    "imageUrl": "<imageUrl>",
    "blur": 20,
    "mode": "include",
    "regions": [{ "x1": 0, "y1": 0, "x2": 100, "y2": 100 }]
  }
}
```

**Response:**
```json
{
  "blob": {
    "url": "...",
    "previewUrl": "...",
    "urlExpiresAt": "...",
    "previewUrlExpiresAt": "...",
    "nsfwLevel": "...",
    "width": 512,
    "height": 512
  }
}
```

---

### orchestrator/generate-transcript

Generate a text transcript from video/audio content.

**Input:** `{ mediaUrl: string }`
**Output:** `{ transcript: string, segments: { start: number, end: number, text: string }[] }`

@justin: This is indeed forward-looking. We are already handling videos coming in, and so my thought is probably should be transcribing those or could be transcribing those as part of our moderation efforts.
@justin: We'd obviously need to join the segments to return to the agent, I guess, unless they wanted segments. But I don't know why they would care.

@ai: Will join segments into a single `transcript` string by default. Keep segments in the response too in case the agent needs timestamps for specific parts (e.g., locating a problematic section in a long video).

**Implementation — `transcribeMedia` workflow step:**
```json
{
  "$type": "transcribeMedia",
  "input": {
    "mediaUrl": "<mediaUrl>"
  }
}
```

**Response:**
```json
{
  "segments": [{ "start": 0.0, "end": 2.5, "text": "Hello world" }, ...]
}
```

Post-process: join `segments.map(s => s.text).join(' ')` into `transcript`.

---

## Moderation Skills

These change state. Each skill attempts the action. If the action falls outside auto-action bounds (see [bounds.md](bounds.md)), it returns `{ requiresApproval: true }` and the agent submits an approval request. Otherwise it executes.

@justin: rather than having it be two passes where essentially they ask for permission and then they do it, couldn't they just ask to do it and then if they don't have the permission or if they need permission we would return this thing that you mentioned here, basically saying that it requires approval, and then they would know, okay, time to submit an approval request.

@ai: Updated. The skill attempts the action directly. If bounds check fails, it returns `{ requiresApproval: true, action, reason }` and the agent submits an approval request upstream. No separate "check permissions" step.

@justin: Do we have the skill for submitting an approval request? I think obviously that's going to need to be some sort of new system. I don't think there's anywhere where they could hook into that right now, so that would have to be a new thing. So I guess that should probably be a separate document where we start planning what that looks like. We're going to need to plan the data schema and the UI, and I guess where that lives. And it would probably be good to have a few references to things that already exist in the codebase that we can use as kind of a guide for developing that.

@ai: Created a separate planning doc: [docs/moderation-agents/approval-requests.md](approval-requests.md). It covers the data schema, UI concept, API endpoints, and references existing codebase patterns (report moderation queue, generation-restrictions page) as starting points. The skill here would be `moderation/submit-approval-request` — included in that doc.

### moderation/give-strike

**Placeholder pending new strike system.**

**Input:** `{ userId: number, reason: string, evidence: { type: string, id: number }[], note?: string }`
**Output:** `{ totalStrikes: number, triggeredFlaggedUser: boolean }`

@justin: Like I mentioned up above in this doc, we are adding a new strike system, so don't worry about how to trigger a strike yet. Just know that we'll be coming back to this so you can have this essentially be a placeholder until we have the strike system ready to go.

@ai: Acknowledged. Placeholder. Will implement once the new strike system is ready. Bounds for auto-striking will be defined in [bounds.md](bounds.md).

---

### moderation/ban-user

Ban a user via the Civitai tRPC API.

**Input:** `{ userId: number, reasonCode: BanReasonCode, detailsExternal?: string, detailsInternal?: string }`
**Output:** `{ success: boolean }` or `{ requiresApproval: true, ... }`

@justin: You'll see that we already have a mod action skill in the Claude skills folder. You'll see that there it calls an API endpoint. I think we'd essentially want to do the same thing here, so that we don't have to keep all of the code that's in this repo and we don't have to try and replicate all of the side effects that happen when you ban somebody. So this is probably one of the examples where this moderation endpoint is calling an API endpoint. In fact, I think the majority of these things probably would be calling endpoints inside of the Civitai APIs.

@ai: Agreed. Will follow the `mod-actions/query.mjs` pattern: call `user.toggleBan` via tRPC. Ban reason codes: `SexualMinor`, `SexualMinorGenerator`, `SexualMinorTraining`, `SexualPOI`, `Bestiality`, `Scat`, `Nudify`, `Harassment`, `LeaderboardCheating`, `BuzzCheating`, `RRDViolation`, `Other`. The endpoint handles all side effects (session invalidation, content unpublishing, subscription cancellation).

**Implementation:**
- Check bounds (see [bounds.md](bounds.md))
- Call tRPC `user.toggleBan` with `{ id: userId, reasonCode, detailsExternal?, detailsInternal? }`
- Auth: `Authorization: Bearer ${CIVITAI_API_KEY}` (moderator account)

---

### moderation/report-ncmec

File a CSAM report with NCMEC. Always requires human approval.

**Input:** `{ imageUrl: string, userId: number, entityType?: string, entityId?: number, sourceFilename?: string }`
**Output:** `{ approvalRequestId: number }`

@justin: So, I think I kind of alluded to it above, and so did you, this need for kind of a new concept, which is, you know, the agent submitting something for human approval. And so I think, rather than using kind of this generic CSAM system that we already have in place, which, you know, cues it for some moderator to then go and look at these images and decide for themselves, you know, what, whether or not it needs to proceed. My thought is that the agent can essentially create the CSAM report and then send a permission request or whatever upstream with the safe image and the description of what it's seen and maybe even a link if they want to go look more closely. And then they approve it there and then it handles pushing it through. So now there's no human actually coming to look at this CSAM since it's not something that anybody should have to see.

@justin: maybe rather than requiring the agent to take all of those individual steps, it's one call, and the agent supplies the image that they're saying is CSAM, and that one call does that whole process. So it'll handle, you know, getting the image description, it'll handle calling blur image. The image just needs to include the bounding boxes, which I guess the agent can technically get from the media rating job or whatever, since that includes faces. But I guess maybe that could be done as part of this single request as well. But the point is that essentially all the agent should have to do is say, hey, there's CSAM in this image, or there's CSAM in this training data, and then we should be able to handle it from there.

@ai: Simplified to a single call. The agent says "CSAM in this image" and the skill handles everything internally:

1. Skill calls `scan-image` (mediaRating) to get face bounding boxes
2. Skill calls `blur-image` using those bounding boxes
3. Skill calls `describe-image` (VLM) for a text description
4. Skill prepares the NCMEC report with annotations (`generativeAi`, `infant`, `physicalHarm`, etc.)
5. Skill submits an **approval request** upstream with: blurred image, text description, review link
6. Human approves without seeing the actual CSAM
7. On approval, the report feeds into the existing `send-csam-reports` pipeline

@justin: We'll want to make sure that the agent can report training data through this as well, they'd send a single image but say it was from a specific training data zip.

@ai: Good point. Updated the input to accept training data context. The agent can pass `entityType: 'training'` with `entityId` referencing the `modelVersionId`, plus an optional `sourceFilename` to identify which image in the ZIP triggered the report. The skill handles the same scan/blur/describe flow regardless of source.

**Always requires human approval. No auto-action under any circumstance.**

**Implementation:**
- Agent input: just `{ imageUrl, userId, entityType?, entityId? }`
- Skill handles all orchestrator calls (scan, blur, describe) internally
- Prepare report using `createCsamReportSchema` format from `src/server/schema/csam.schema.ts`
- Include NCMEC annotations from `ncmec.schema.ts` (generativeAi default true)
- Submit approval request with safe materials only
- On approval: create the report via API, which feeds into the hourly `send-csam-reports` job

---

### moderation/block-content

Block a piece of content via Civitai API endpoints.

**Input:** `{ entityType: 'model' | 'modelVersion' | 'article' | 'bounty' | 'image' | 'training', entityId: number, reason: string }`
**Output:** `{ success: boolean }` or `{ requiresApproval: true, ... }`

@justin: I think that for each of these, rather than interacting directly with the database, we'll probably want to have endpoints that we can hit to ensure that we are consistent in the way that we action this. I think that a lot of these kind of already have endpoints. Some of them don't, like these ones where we would just be setting status. but I think that it probably makes sense to still have an endpoint for them just so that we can make sure that the way that it's being handled is consistent and visible inside of this main codebase. So I guess you're gonna need to send an agent to go look for kind of the current way that these things are being blocked or set as violations or whatever. And then if there isn't one, then we'll need to make new endpoints. We can hit TRPC or API endpoints.

@justin: There's already endpoints to unpublished model versions as violations, so I think that that's probably what would be used here. I'm not exactly sure where that is, but hopefully that'll be enough for you to find that. There's an unpublish as violation option in the context menu on the articles page. So I'm pretty sure there's already something there for that. You'll just need to follow that through from the UI. Probably spin up an explore agent to go get that. There isn't anything for bounty. And then for training, I don't know. I think there isn't something that can be called specifically to stop it. They just kind of stop themselves and then go in for review. So I think in this situation you wouldn't necessarily need to go block the training. You probably just don't turn it back on. So I guess there probably needs to be another skill here for approving training. and I think that there's places where that's already happening in the UI. I'm not sure. So maybe send an explore agent to see if you can find that.

@ai: Found all the endpoints. Here's the complete picture:

**Existing endpoints by entity type:**
- **Image**: `setTosViolationHandler` in `image.controller.ts:226`, or `POST /api/mod/remove-images`
- **Model**: `model.unpublish` — `unpublishModelSchema: { id, reason?, customMessage? }` in `model.schema.ts:243`
- **ModelVersion**: `model.unpublish` also covers versions, or the model-level unpublish cascades
- **Article**: `article.unpublish` — `unpublishArticleSchema: { id, reason?, customMessage? }` in `article.schema.ts:117`
- **Bounty**: No endpoint exists — **needs a new `moderatorProcedure` endpoint**
- **Training**: Training runs stop themselves and go into review. No need to block; just don't approve. See new `moderation/approve-training` skill below.

@justin: Answered about bounties at end of doc.

@ai: Noted — see open questions section. Bounty blocking needs a combination of refund + delete, or a new soft-delete state. Will track as a follow-up endpoint to build.

**Implementation:**
- Route by `entityType` to the appropriate tRPC endpoint
- Check bounds first (see [bounds.md](bounds.md))
- For images: call `image.setTosViolation` or `POST /api/mod/remove-images`
- For models: call `model.unpublish` with `{ id, reason, customMessage }`
- For articles: call `article.unpublish` with `{ id, reason, customMessage }`
- For bounties: **new endpoint needed** — flag for follow-up
- For training: not applicable here (use `approve-training` instead)

Bounds per entity type are defined in [bounds.md](bounds.md).

---

### moderation/approve-training

Approve or deny a training run that's pending review.

**Input:** `{ modelVersionId: number, action: 'approve' | 'deny' }`
**Output:** `{ success: boolean }` or `{ requiresApproval: true, ... }`

Training runs that trigger moderation flags stop automatically and enter a review queue. This skill lets the agent approve (resume) or deny (permanently block) a flagged training run.

**Implementation:**
- Check bounds (see [bounds.md](bounds.md))
- If `action = 'approve'`: call tRPC `mod.trainingData.approve` with `{ id: modelVersionId }`
- If `action = 'deny'`: call tRPC `mod.trainingData.deny` with `{ id: modelVersionId }`
- Both endpoints are `moderatorProcedure` in `src/server/routers/moderator/index.ts:62-65`
- Input schema: `getByIdSchema` (just `{ id }`)
- Handlers: `handleApproveTrainingData` and `handleDenyTrainingData`

---

### moderation/mute-user

Mute a user (restricts posting, generation).

**Input:** `{ userId: number }`
**Output:** `{ success: boolean }` or `{ requiresApproval: true, ... }`

@justin: This is another one that would need bounds. I think the bounds on this one would be specifically around the user entity. So I think probably what we're going to be looking at here when we set up a bounds document is like for each entity type, what are the boundaries that we consider before actioning it in one way or another? And probably the boundaries need to be per action as well.

@ai: Bounds for muting are defined per-user in [bounds.md](bounds.md) (user-level section). The skill checks bounds before executing.

**Implementation:**
- Check bounds (see [bounds.md](bounds.md))
- Call tRPC `user.toggleMute` with `{ id: userId }`
- Auth: moderator Bearer token

---

### moderation/confirm-mute

Confirm a pending mute (cancels subscriptions, refreshes session).

**Input:** `{ userId: number }`
**Output:** `{ success: boolean }` or `{ requiresApproval: true, ... }`

@justin: Same thing, boundary, definition needed, and probably an API endpoint that we can hit to confirm the mute.

@justin: There's the ability to confirm mutes here https://civitai.com/moderator/generation-restrictions so I assume there is an endpoint for this if you follow from that front-end

@ai: Found it. The generation-restrictions page uses the `userRestriction` router. The relevant endpoint is:

- **`userRestriction.resolve`** — `resolveRestrictionSchema: { userRestrictionId: number, status: 'Upheld' | 'Overturned', resolvedMessage?: string }`
- Located in `src/server/schema/user-restriction.schema.ts:24`
- `Upheld` = confirm the mute (equivalent to confirm-mute)
- `Overturned` = reverse the mute

**Implementation:**
- Check bounds (see [bounds.md](bounds.md))
- Look up the user's `UserRestriction` record to get `userRestrictionId`
- Call tRPC `userRestriction.resolve` with `{ userRestrictionId, status: 'Upheld' }`
- This handles subscription cancellation and session refresh

---

### moderation/action-report

Update a report's status.

**Input:** `{ reportId: number, status: 'Actioned' | 'Unactioned' }`
**Output:** `{ success: boolean }`

@justin: will want to hit the API endpoint that the frontend is calling or whatever when somebody actions a report. I don't know if there's automated behavior that happens when you action a report. I don't recall, so if you could check that, that would be great. But I would think that's why we would want to hit an API endpoint so that we can get the side effects triggered, of which I'm sure there are many either way.

@ai: Checked. The `setReportStatusHandler` calls `bulkSetReportStatus()` in `report.service.ts`, which has these side effects:

1. Updates report `status`, `statusSetAt`, `statusSetBy`
2. If status = `Actioned`: sets `previouslyReviewedCount = alsoReportedBy.length + 1`
3. Tracks mod activity via `trackModReports()` (background)
4. **If Actioned**: distributes rewards to all reporters (original + `alsoReportedBy`) via `reportAcceptedReward.apply()` (background)

So yes, hitting the tRPC endpoint is important to trigger reward distribution and mod activity tracking.

@justin: since the skill above action report gives you the ability to unaction something, isn't that the same as dismissing it? I wonder if we remove the status option from the thing above.

@ai: Good call. Merged dismiss-report into this skill. `status: 'Unactioned'` = dismissal. Removed the separate `moderation/dismiss-report` skill.

**Implementation:**
- Call tRPC `report.setStatus` with `{ id: reportId, status }`
- `Actioned` = confirmed violation (triggers reporter rewards)
- `Unactioned` = dismissed (no rewards)

---

### moderation/add-note-to-report

Add an internal note to an existing report.

**Input:** `{ reportId: number, note: string }`
**Output:** `{ success: boolean }`

@justin: I don't think there is a notes field, so this will probably need to be added. But you can check the schema in Prisma, or even just check the table in Postgres.

@ai: Checked — the `internalNotes` field **already exists** on the Report model as `String?` (nullable). No schema change needed. We just need to update it.

@justin: I believe there is because there's the ability to set notes via the report UI https://civitai.com/moderator/reports but I assume that it's probably part of a larger report save/update request.

@ai: Confirmed. The endpoint exists:

- **`report.update`** — `updateReportSchema: { id: number, status: ReportStatus, internalNotes?: string }` in `src/server/schema/report.schema.ts:167-171`
- It's a `moderatorProcedure` in `src/server/routers/report.router.ts:28`
- The schema accepts `internalNotes` as an optional nullable string

So this skill just calls `report.update` with `{ id: reportId, internalNotes: note }`. It's part of the same update endpoint that handles status changes, so we pass the existing status along with the new notes.

**Implementation:**
- Call tRPC `report.update` with `{ id: reportId, status: <current status>, internalNotes: note }`
- May need to first fetch the report's current status to preserve it when only updating notes

---

## Processing Skills

Communications and documentation that don't directly moderate.

### processing/request-identity-docs

Send a request for identity/rights documentation to a user.

**Input:** `{ userId: number, reason: string, entityType?: string, entityId?: number }`
**Output:** `{ sent: boolean }`

@justin: this is a new flow. Essentially the way that this would work is it would send a forum email, and the email would have something special in the subject line, so when the person replies to that email, we'd have something that monitors that inbox, and when that item comes back in, it will look for the session, agent session, that was associated with that, and feed that information. give them back the response and give them the ability to get the attachment. And based on that attachment, they then determine whether or not the person would be unblocked. For now, though, I think essentially what we would want to do is just have it send the email, and then we'll have humans that moderate the inbox associated with that email. And they'll handle unblocking these training runs. So in this situation, essentially, when they say, hey, give me identity docs, it's keeping it on hold. Ultimately, what should be happening here is the training run will already be probably stopped at this point unless they restart it or allow it to proceed. And so requesting identity docs just sends the email that's needed to get this process rolling to verify whether or not they can proceed with training.

@ai: Two-phase approach:

**Phase 1 (now):** Skill sends a form email with a special subject line tag (e.g., `[ID-VERIFY-{userId}-{sessionId}]`). Humans monitor the inbox and handle responses manually.

**Phase 2 (later):** Inbox monitor service watches for replies, extracts attachments, matches to agent session via subject line tag, and feeds documents back to the agent for automated review.

**Implementation (Phase 1):**
- Compose email with tagged subject line
- Send via email service (Resend, SES, or whatever Civitai uses)
- Include: reason for request, what documents are needed, reply instructions
@justin: We're currently sending via smtp using nodemailer on top of SES. Since we'd be building this in another repo we can do whatever we want. I think it'd be best for it to probably just be nodemailer for consistency.

@ai: Got it. Will use nodemailer with SES SMTP credentials. Since this lives outside the main repo, we'll add nodemailer as a dependency in the skills project. Credentials: SES SMTP username/password (IAM-generated) configured via env vars (`SES_SMTP_HOST`, `SES_SMTP_USER`, `SES_SMTP_PASS`, `MOD_EMAIL_FROM`).

---

### processing/add-moderation-note

Attach an internal moderation note to a user's profile.

**Input:** `{ userId: number, note: string, setSpamWhitelist?: boolean, setDeservedMute?: boolean }`
**Output:** `{ success: boolean, isNew: boolean }`

@justin: There's a `UserNotes` table in retool. It's a PG database: postgresql://retool:7gHdRs4QyEap@ep-green-mode-160024-pooler.us-west-2.retooldb.com/retool?sslmode=require I guess we'd just need to have this access that. Have an agent create a retool-query skill based on the postgres-query skill you have so you can check that out yourself

@ai: Will connect directly to the Retool Postgres database. The shared `retool-db.ts` library handles the connection. I'll create a retool-query skill based on the postgres-query skill pattern for exploring the schema.

@justin: Yeah, please explore via the retool-query skill. Let me know if you're blocked here...

@ai: Explored via retool-query. Here's the `UserNotes` schema:

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| `id` | integer | NOT NULL | auto-increment |
| `userId` | integer | nullable | 0 |
| `notes` | text | nullable | — |
| `lastUpdate` | timestamp with tz | nullable | now() |
| `lastUpdateBy` | text | nullable | — |
| `spamWhitelist` | boolean | nullable | false |
| `deservedMute` | boolean | nullable | false |

**Key finding**: It's one row per user, not multiple notes. The `notes` field is a single text blob (moderators append to it). `lastUpdateBy` stores the moderator's name (e.g., "Ally Nicoll").

So this skill either:
- **Updates** the existing row: append the new note to the `notes` field with a timestamp and agent identifier
- **Inserts** a new row if none exists for the user

@justin: What makes you think it's just one row per user? I'm pretty sure you can have multiple. That's why there's ID.

@ai: You're right — I re-checked and multiple users have multiple rows. Each row is a separate note entry (e.g., userId 4569096 has 3 notes from different moderators at different times). The `id` is an auto-incrementing primary key, and each row captures one note with its own `lastUpdateBy` and `lastUpdate`. My earlier query just happened to find users with single entries.

**Implementation (corrected):**
- Connect to Retool PG via `retool-db.ts` shared lib
- Always `INSERT INTO "UserNotes" ("userId", notes, "lastUpdateBy") VALUES ($1, $2, 'mod-agent')`
- Each call creates a new row — no need to check for existing or append
- Set `spamWhitelist` or `deservedMute` on the new row if applicable
- To read history: `SELECT * FROM "UserNotes" WHERE "userId" = $1 ORDER BY "lastUpdate" DESC`

---

### processing/send-dm

Send a direct message to a user on behalf of moderation.

**Input:** `{ userId: number, message: string }`
**Output:** `{ messageId: number, chatId: number }`

@justin: Currently, each mod uses their own account. However, I was just talking with the mod team about maybe setting up a little mini chat application that interacts with all chat endpoints and allows them to essentially just engage as one user. But for now, we can essentially just have the bot use its own account. The agents would essentially get an API token associated with a bot user that we've got set up on the site that allows them to use all the chat endpoints.

@ai: Got it. Agents use a dedicated bot user account with its own API token. The bot calls Civitai chat endpoints to create/send messages.

**Implementation:**
- Auth: `Bearer ${BOT_API_KEY}` (bot user's API token — the token is tied to the bot user, so the API knows who's sending)
- Find or create a chat between bot user and target user via chat tRPC endpoints
- Send `ChatMessage` with `contentType = 'Markdown'`

---

## Agent Tool-Use Pattern

Agents don't follow pre-defined pipelines. Each agent gets a system prompt defining its purpose and has all skills available as tools. The agent decides which skills to invoke based on the task.

@justin: This doesn't really reflect how I want the skills to be used. I want the agent to essentially be free. So, ultimately, what's going to happen is the agent has a system prompt, it's given a thing to review, and then all of the skills are kind of at its disposal to go and do some exploration to decide, you know, what should I do given this task? And rather than, you know, pre-running things and then giving it all of that data, I want it to pull data. that as it sees fit, rather than it being so structured like you've got it here, so that it can intuitively go select the types of things that it wants to look at. So I don't know that we need to do chaining quite like this, although I do like what you've done here. Kind of what I'm imagining then is that there's some sort of like entry script that then can hook up a variety of different things that it wants to use. So really the thing that we need to be thinking about is, you know, what does a CL and the API requests look like coming from the agent to be able to run a variety of these skills in one request. And how do those, what does the output get structured like so that they can make sense of what they just got back to? And I don't know, maybe we don't need to worry about chaining for this first pass. Maybe that's something that we can add later. But if we're going to be building these files anyways, it's probably good to start thinking about, you know, how we can have shared libraries, for making requests into the various API services or databases or whatever, so that we're not just repeating a bunch of boilerplate in CLI script after CLI script.

@ai: Rewrote this section. The key design decisions for the shared libraries:

1. **`lib/civitai-api.ts`** — Single tRPC client used by all moderation and some review skills
2. **`lib/clickhouse.ts`** — Single ClickHouse client used by review skills that query analytics
3. **`lib/orchestrator.ts`** — Orchestrator client for VLM, scanning, generation, blur, transcript
4. **`lib/retool-db.ts`** — Retool PG client for UserNotes

Each skill is a thin wrapper: validate input, call the right shared client, shape the output. The shared libs handle auth, retries, and connection management so individual skills stay small.

For the tool-use integration, we'll need to decide on the format for tool definitions (function calling schema) so the LLM can invoke them. But that's an implementation detail for when we build the agent runner.

@justin: You'll probably need a lib for civitai-db (the postgres db) as well.

@ai: Added `civitai-db.ts` to the shared libs. Read-only Postgres client for the Civitai database. Used by review skills that need to query tables directly (reports, subscriptions, chat messages, user metrics, etc.). Connection via `DATABASE_URL` env var.

---

## Open Questions

Most questions from earlier rounds have been answered. Here's what remains:

| # | Question | Affects | Status |
|---|----------|---------|--------|
| 1 | Custom VLM model name for orchestrator chat completions endpoint | orchestrator/describe-image | **Parked** — Justin will provide later |
| 2 | Bounty blocking: add soft-delete status or use refund+delete? | moderation/block-content | **Open** — needs design decision then implementation |

**Resolved this round:**
- ~~Bot user DMs~~: Just use a Bearer token tied to the bot user account; chat endpoints handle the rest
- ~~Block-content endpoints~~: Found `unpublishModelSchema`, `unpublishArticleSchema`, `mod.trainingData.approve/deny`
- ~~Confirm-mute endpoint~~: Found `userRestriction.resolve` with `resolveRestrictionSchema`
- ~~Report.internalNotes endpoint~~: Found `report.update` with `updateReportSchema`
- ~~Email service~~: Nodemailer on SES
- ~~UserNotes schema~~: Explored via retool-query — 7 columns, multiple rows per user (one per note)

@justin: Okay, I think I answered all of your questions in line up above. If not, let me know.

@ai: Thanks — you did! Closed 5 of 7 questions. The three remaining are: VLM model name, bot user details for DMs, and the bounty blocking endpoint (which needs new code).

@justin: I'll get back to you on the VLM name later, bot user details for DMs = use a token and just make a request (the token will be associated with the bot user), the bounty blocking endpoint will need new code, a combination of refund bounty and delete bounty (since bounties don't have a soft delete state... Although maybe we should add one instead).

@ai: Updated the open questions table:
- VLM model name: parked, you'll provide it later
- Bot user DMs: resolved — just use a Bearer token tied to the bot user, the chat endpoints handle the rest
- Bounty blocking: needs new code — either refund+delete combo or a new soft-delete status. Adding a soft-delete state (like `UnpublishedViolation` on models) would be cleaner and consistent with other entity types
