# Panel Generation Implementation Plan

## Goal
Wire up the comics `createPanel` mutation to generate images via the Civitai orchestrator API using NanoBanana (Gemini) with character reference images for consistency.

## Architecture Overview

```
createPanel (comics router)
  -> verify chapter ownership (chapter -> project -> userId)
  -> get character's generated reference images
  -> if enhance=true: call enhanceComicPrompt() via GPT-4o-mini (no trigger words, scene-focused)
  -> else: use raw user prompt
  -> get orchestrator token for user
  -> call createImageGen() with:
     - engine: 'gemini', baseModel: 'NanoBanana'
     - resources: [{ id: 2154472, strength: 1 }] (NanoBanana checkpoint)
     - images: character reference images (editImage mode)
     - width: 1728, height: 2304 (3:4 portrait)
  -> store workflowId + enhancedPrompt on panel, set status=Generating
  -> return panel

pollPanelStatus (existing endpoint, updated for chapter-based panels)
  -> read panel's workflowId
  -> verify ownership via panel.chapter.project.userId
  -> call getWorkflow() to check orchestrator status
  -> if succeeded: extract image URL, update panel status + imageUrl
  -> if failed: update panel status + errorMessage
  -> return updated panel
```

Frontend polls `pollPanelStatus` every 3s for panels in Generating state.

## Character Reference Image Generation

When a user selects an existing LoRA model, the system auto-generates 3 reference images:

```
createCharacterFromModel
  -> create character as Pending
  -> for each view (front, side, back):
     -> call createTextToImage() with LoRA + checkpoint
     -> store workflow ID
  -> set status to Processing, store all workflow IDs

pollReferenceStatus (new endpoint)
  -> check each workflow via getWorkflow()
  -> when all 3 complete: extract URLs, store in generatedReferenceImages, set Ready
  -> if any fail: set Failed
```

Frontend polls `pollReferenceStatus` every 5s for characters in Pending/Processing state.

## Schema Changes

### New: ComicChapter model
Projects now have Chapters, and Chapters contain Panels (Project -> Chapter -> Panel).

### Modified: ComicPanel
- `projectId` -> `chapterId` (FK to ComicChapter instead of ComicProject)
- Index: `@@index([chapterId, position])` instead of `@@index([projectId, position])`

### Modified: ComicReference
- Added `generatedReferenceImages Json?` — Array of { url, width, height, view } objects
- Added `referenceImageWorkflowIds Json?` — Orchestrator workflow IDs for polling

### Migration
Destructive migration (dev phase): drops and recreates all comic tables with new structure.

## Files Modified

### 1. `prisma/schema.full.prisma` & `prisma/schema.prisma`
- Added `ComicChapter` model
- Changed `ComicProject.panels` to `ComicProject.chapters`
- Changed `ComicPanel.projectId` to `ComicPanel.chapterId`
- Added `generatedReferenceImages` and `referenceImageWorkflowIds` to `ComicReference`

### 2. Migration SQL
- Destructive migration: DROP all comic tables, recreate with new structure

### 3. `src/server/services/comics/prompt-enhance.ts`
- Updated system prompt for reference-image-based generation
- Removed instructions about trigger words / physical appearance
- Focus on pose, expression, action, scene composition
- Made `trainedWords` parameter optional

### 4. `src/server/routers/comics.router.ts`
**Major rewrite:**
- **`createPanel`** uses `createImageGen()` (NanoBanana/Gemini) instead of `createTextToImage()` with LoRA
  - engine: 'gemini', baseModel: 'NanoBanana'
  - resources: NanoBanana checkpoint (version ID 2154472)
  - images: character reference images from `generatedReferenceImages`
  - 1728x2304 portrait dimensions
- **`createCharacterFromModel`** generates 3 reference images (front/side/back) via `createTextToImage()` with the LoRA
- **`pollReferenceStatus`** new endpoint to check reference image generation progress
- **Chapter CRUD**: `createChapter`, `updateChapter`, `deleteChapter`, `reorderChapters`
- **`createProject`** auto-creates "Chapter 1" via nested Prisma create
- **`getProject`** includes chapters with nested panels
- **`getMyProjects`** aggregates panel count across chapters
- All panel ownership checks updated: `panel.chapter.project.userId`

**New imports:**
```typescript
import { createImageGen } from '~/server/services/orchestrator/imageGen/imageGen';
```

### 5. `src/pages/comics/project/[id]/index.tsx`
- Added chapter tabs (Mantine Tabs) above panel grid
- Track `activeChapterId` state, default to first chapter
- Panel grid renders `activeChapter.panels`
- Generate panel passes `chapterId` instead of `projectId`
- Added character status polling (every 5s for Pending/Processing characters)
- "Add Chapter" button creates new chapters

### 6. `src/pages/comics/project/[id]/character.tsx`
- For ExistingModel characters in Processing: shows "Generating reference images..."
- Added polling via `pollReferenceStatus` (every 5s)
- Displays generated front/side/back reference images when Ready
- Updated cost label: "Cost: 50 Buzz (reference image generation)"

## Key Constants

```typescript
const NANOBANANA_VERSION_ID = 2154472;  // Standard NanoBanana checkpoint
const PANEL_WIDTH = 1728;
const PANEL_HEIGHT = 2304;
```

## Generation Defaults

| Setting | Value |
|---------|-------|
| Engine | gemini |
| Base Model | NanoBanana |
| Checkpoint | Version ID 2154472 |
| Width | 1728 |
| Height | 2304 |
| Quantity | 1 |
| Priority | low |
| Prompt | Enhanced via GPT-4o-mini (scene-focused, no appearance details) |
| Character Reference | Generated front/side/back images passed as `images` param |

## Reference Image Generation Defaults

| Setting | Value |
|---------|-------|
| Width | 832 |
| Height | 1216 |
| Sampler | Euler |
| Steps | 25 |
| CFG Scale | 7 |
| Views | front, side, back |
| Method | createTextToImage with LoRA + checkpoint |

## Verification Steps
1. Create a project → verify "Chapter 1" auto-created
2. Create a character from existing LoRA → verify status goes Pending → Processing → Ready
3. Check character page → verify 3 reference images (front/side/back) are visible
4. Create panel → verify NanoBanana generation fires with character reference images
5. Check debug modal → verify enhanced prompt, NanoBanana workflow info, reference images
6. Create second panel → verify previous panel context in prompt enhancement
7. Create second chapter → verify panels are scoped to chapters
8. Enhance toggle off → verify raw prompt used without LLM enhancement
