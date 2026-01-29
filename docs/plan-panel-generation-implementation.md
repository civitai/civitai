# Panel Generation Implementation Plan

## Goal
Wire up the comics `createPanel` mutation to actually generate images via the Civitai orchestrator API, so panels progress from "Queued" to showing a generated image.

## Architecture Overview

```
createPanel (comics router)
  -> lookup character's modelVersion (get baseModel, trained words)
  -> determine compatible checkpoint via getGenerationConfig(baseModel)
  -> if enhance=true: call enhanceComicPrompt() via GPT-4o-mini
  -> else: prepend trained words to user prompt (original behavior)
  -> get orchestrator token for user
  -> build resources array (checkpoint + LoRA)
  -> call orchestrator.generateImage with enhanced prompt + negative prompt
  -> store workflowId + enhancedPrompt on panel, set status=Generating
  -> return panel

pollPanelStatus (new endpoint)
  -> read panel's workflowId
  -> call getWorkflow() to check orchestrator status
  -> if succeeded: extract image URL, update panel status + imageUrl
  -> if failed: update panel status + errorMessage
  -> return updated panel
```

Frontend polls `pollPanelStatus` every 3s for panels in Pending/Generating state.

## Files Modified

### 1. `prisma/schema.full.prisma`
- Added `workflowId String?` to `ComicPanel` model
- Added `baseModel String? @db.VarChar(50)` to `ComicProject` model

### 2. `prisma/migrations/20260128200053_add_comic_panel_workflowid_and_project_basemodel/migration.sql`
- Migration to add both columns

### 3. `src/server/services/comics/prompt-enhance.ts` (new)
- `enhanceComicPrompt()` function that optionally rewrites the user's simple prompt into a detailed, comic-optimized image generation prompt via GPT-4o-mini
- System prompt instructs the LLM to start with trigger words, add visual details, compositional terms, and quality terms
- Output capped at 1500 characters (our prompt length limit)
- Falls back to `trainedWords + userPrompt` if OpenAI is unavailable or the call fails

### 4. `src/server/routers/comics.router.ts`
**Changes:**
- **`createPanel`** rewritten to submit an actual generation workflow:
  1. Looks up character's model version to get `baseModel` and `trainedWords`, plus character `name`
  2. Uses `getBaseModelSetType(baseModel)` to map raw baseModel string (e.g. "Flux.1 D") to BaseModelGroup (e.g. "Flux1")
  3. Uses `getGenerationConfig(baseModelGroup)` to get the default checkpoint
  4. If `input.enhance` is true (default), calls `enhanceComicPrompt()` to rewrite the user's prompt via GPT-4o-mini; otherwise prepends trained words to the user prompt
  5. Gets orchestrator token via `getOrchestratorToken(ctx.user.id, ctx)`
  6. Builds resources array: `[{ id: checkpointVersionId, strength: 1 }, { id: loraVersionId, strength: 1 }]`
  7. Calls `createTextToImage()` with params: enhanced prompt, hardcoded negative prompt, baseModel, 832x1216 portrait, workflow "txt2img", quantity 1, sampler "Euler", 25 steps, cfgScale 7
  8. Stores `workflowId` and `enhancedPrompt` on the panel record, sets status to `Generating`

- **`pollPanelStatus` query added:**
  1. Takes `panelId` as input
  2. Verifies ownership via project
  3. If no workflowId or already Ready/Failed, returns panel as-is
  4. Gets orchestrator token, calls `getWorkflow({ token, path: { workflowId } })`
  5. If workflow status === 'succeeded': extracts image URL from step output, updates panel with imageUrl + status=Ready
  6. If workflow status === 'failed'/'canceled': updates panel with status=Failed + errorMessage
  7. Returns updated panel

- **`createCharacterFromModel`** updated:
  1. Now also reads `baseModel` from the model version
  2. Converts to BaseModelGroup via `getBaseModelSetType()`
  3. Stores on the project if not already set

**New imports:**
```typescript
import type { SessionUser } from 'next-auth';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getGenerationConfig } from '~/server/common/constants';
import { getBaseModelSetType } from '~/shared/constants/generation.constants';
import { createTextToImage } from '~/server/services/orchestrator/textToImage/textToImage';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { enhanceComicPrompt } from '~/server/services/comics/prompt-enhance';
```

### 5. `src/pages/comics/project/[id]/index.tsx`
**Changes:**
- Added `useEffect` polling that calls `pollPanelStatus` every 3s for panels in Pending/Generating state
- Uses `trpc.useUtils()` to access `utils.comics.pollPanelStatus.fetch()`
- When any panel transitions to Ready or Failed, refetches the full project data
- Added "Enhance prompt" toggle (`Switch`) in the panel creation modal — on by default, can be turned off by users who want full control over their prompts
- Debug modal now shows `enhancedPrompt` separately when available

### 6. `docs/plan-webtoon-hackathon-mvp.md`
- Updated pipeline dependencies table to mark panel generation, character creation, and polling as implemented
- Updated key files section with generation service integration details
- Updated hardcoded defaults table with actual generation parameters

## Key Considerations

### BaseModel Parameter Handling
Different base models need different generation parameters:
- **Flux1**: No negative prompt, sampler="undefined", no clipSkip
- **SDXL/Pony**: Standard params with cfgScale, steps, sampler
- **SD1.5**: Lower resolution (512x768 instead of 832x1216)

The `createTextToImage` and `parseGenerateImageInput` functions handle these differences internally based on the `baseModel` param.

### Orchestrator Token
`getOrchestratorToken(userId, ctx)` requires `ctx` to have `req` and `res` (NextApiRequest/Response). The tRPC context provides these.

### Image URL Extraction
The orchestrator returns images in `workflow.steps[0].output.images[0].url`. This URL is from the orchestrator. For production, we'd want to copy it to our CDN, but for the MVP, using the orchestrator URL directly works.

### Error Handling
- If orchestrator submission fails -> panel marked as Failed immediately
- If orchestrator workflow fails -> caught during polling, panel marked Failed
- If user doesn't have enough Buzz -> orchestrator returns 403 (insufficient funds)
- If poll request fails -> silently ignored, retried next interval

## Generation Defaults (Hardcoded for MVP)

| Setting | Value |
|---------|-------|
| Width | 832 |
| Height | 1216 |
| Sampler | Euler |
| Steps | 25 |
| CFG Scale | 7 |
| Quantity | 1 |
| Workflow | txt2img |
| Priority | low |
| Prompt | Enhanced via GPT-4o-mini (optional, on by default) or trainedWords + user prompt |
| Negative Prompt | Hardcoded quality filter (blurry, deformed, bad anatomy, etc.) |
| Prompt Enhancement | GPT-4o-mini rewrites user prompt with visual details, composition, and quality terms (max 1500 chars). Toggle available in UI. |
| Checkpoint | Auto-selected via getGenerationConfig(baseModelGroup) |

## Verification Steps
1. Create a project, add a character from an existing Flux1 LoRA
2. Click "Add Panel", enter a prompt, click Generate
3. Panel should show "Generating..." status
4. After ~10-30 seconds, panel should show the generated image
5. Verify the character is recognizable in the generated image
6. Test error cases: invalid model version, no Buzz, etc.
