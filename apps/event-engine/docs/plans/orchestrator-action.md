# Orchestrator Action Integration

## Objective
Add a new action to the action stack (`actions.spine.req()`) that allows event handlers and outbox handlers to submit workflows to the orchestration system.

## Goals
- Abstract orchestrator API calls for easier mocking/testing
- Keep types broad/flexible due to variety of job types and steps
- Follow similar pattern to existing `actions.pg.*` structure

## Proposed API Structure

### Naming Convention
`actions.spine.req(payload)`

**Options considered:**
- `actions.orchestrator.*` (too long)
- `actions.spine.*` (preferred - short, new name)

@meta: `actions.spine.req()` looks good! "Spine" is a great name for the orchestrator - it's the backbone of the workflow system. Clear and memorable.

## Type Structure

@meta: Type structure looks good with the balance of flexibility (`Record<string, any>` for dynamic content) and type safety (specific strings for callback types). Ready to implement.

```typescript
interface SpineWorkflowRequest {
  metadata?: Record<string, any>;
  arguments?: Record<string, any>;
  steps: WorkflowStep[];
  callbacks?: WorkflowCallback[];
}

interface WorkflowStep {
  $type: string; // e.g., "wdTagging", "rating", "hash"
  metadata?: Record<string, any>;
  input?: Record<string, any>; // Flexible for $ref patterns
}

type WorkflowCallbackType =
  | 'workflow:*'
  | 'workflow:unassigned'
  | 'workflow:processing'
  | 'workflow:succeeded'
  | 'workflow:failed'
  | 'workflow:expired'
  | 'workflow:canceled'
  | 'step:*'
  | 'step:unassigned'
  | 'step:processing'
  | 'step:succeeded'
  | 'step:failed'
  | 'step:expired'
  | 'step:canceled';

interface WorkflowCallback {
  url: string;
  type: WorkflowCallbackType[];
  detailed?: boolean;
}
```

## Implementation Areas

@meta: I'll need to update the following locations:

1. **Create spine service** (`src/services/spine.ts`)
   - Handle HTTP POST to `/v2/consumer/workflows`
   - Abstract fetch logic for mocking
   - Error handling
   - **Step transformation logic**: Convert function-based steps to raw API format
     - Detect if `steps` is a function
     - Create proxy objects for `args` and `output` that track property access
     - Execute function to get steps array
     - Build map of `name` to array index
     - Transform tracked property accesses into `$ref` objects

2. **Add to action stack** (update wherever actions are defined)
   - Add `actions.spine.req()`
   - Wire to spine service

3. **Configuration** (`src/config/index.ts`)
   - Add spine base URL/credentials (e.g., `SPINE_URL`, `SPINE_API_KEY`)

4. **Types** (`src/types/spine.ts` or similar)
   - Define `SpineWorkflowRequest`, `WorkflowStep`, `WorkflowCallback`, `StepBuilder`
   - Support union type for `steps: WorkflowStep[] | StepBuilder`

5. **Tests** - Skipping for now

## Usage Example

Here's how you would use `actions.spine.req()` in a handler:

```typescript
// Example: In an image outbox handler
async function handleImageScan(event: ImageEvent, actions: ActionStack) {
  const { imageId, url } = event.data;

  // Submit workflow to spine orchestrator
  await actions.spine.req({
    metadata: {
      imageId,
      source: 'metric-event-watcher',
      triggeredAt: new Date().toISOString()
    },
    arguments: {
      mediaUrl: url
    },
    steps: [
      {
        $type: 'wdTagging',
        input: {
            // Raw format - required by Spine API (verbose with $ref patterns)
          mediaUrl: {
            $ref: '$arguments',
            path: 'mediaUrl'
          }
        }
      },
      {
        $type: 'rating',
        input: {
          imageUrl: {
            $ref: '$0', // Reference previous step output
            path: 'output.blob.url'
          }
        }
      },
      {
        $type: 'hash',
        input: {
          imageUrl: {
            $ref: '$arguments',
            path: 'mediaUrl'
          },
          hashTypes: ['perceptual']
        }
      }
    ],
    // Ergonomic format - gets transformed to raw format above
    steps: ({ args, output }) => [
      {
        $type: 'wdTagging',
        name: 'tagging',
        input: {
          mediaUrl: args.mediaUrl
        }
      },
      {
        $type: 'rating',
        input: {
          imageUrl: output.tagging.blob.url // References step by name, auto-converts to $ref array index
        }
      },
      {
        $type: 'hash',
        input: {
          imageUrl: args.mediaUrl,
          hashTypes: ['perceptual']
        }
      }
    ],
    callbacks: [
      {
        url: 'https://api.civitai.com/webhooks/spine/image-processed',
        type: ['workflow:succeeded', 'workflow:failed'],
        detailed: true
      }
    ]
  });
}
```

@meta: The example shows both formats - the raw API format and the ergonomic function format that gets transformed.

## Ergonomic Steps API

To make the API more comfortable to use, we'll support both formats for `steps`:

### Option 1: Raw Array (direct to API)
```typescript
steps: [
  {
    $type: 'wdTagging',
    input: {
      mediaUrl: { $ref: '$arguments', path: 'mediaUrl' }
    }
  }
]
```

### Option 2: Builder Function (ergonomic, gets transformed)
```typescript
steps: ({ args, output }) => [
  {
    $type: 'wdTagging',
    name: 'tagging',  // Optional ID for referencing
    input: {
      mediaUrl: args.mediaUrl  // Direct access to arguments
    }
  },
  {
    $type: 'rating',
    input: {
      imageUrl: output.tagging.blob.url  // Direct access to previous step outputs
    }
  }
]
```

**Transformation logic:**
- `args.mediaUrl` → `{ $ref: '$arguments', path: 'mediaUrl' }`
- `output.tagging.blob.url` → `{ $ref: '$0', path: 'output.blob.url' }` (where `$0` is the array index of step with `name: 'tagging'`)
- Steps without `name` can still be referenced by index: `output.$0`, `output.$1`, etc.

**Type definitions:**
```typescript
interface SpineWorkflowRequest {
  metadata?: Record<string, any>;
  arguments?: Record<string, any>;
  steps: WorkflowStep[] | StepBuilder;
  callbacks?: WorkflowCallback[];
}

type StepBuilder = (context: {
  args: Record<string, any>;
  output: Record<string, any>;
}) => WorkflowStep[];
```

@meta: This transformation happens in the `actions.spine.req()` implementation before sending to the API. The function format is purely for developer ergonomics.

---

## Implementation Complete ✅

All implementation tasks have been completed:

1. ✅ **Type definitions** - Created `src/types/spine.ts` with:
   - `SpineWorkflowRequest`, `WorkflowStep`, `WorkflowCallback`, `StepBuilder`
   - Support for both raw array and function-based steps
   - Complete `WorkflowCallbackType` union with all workflow/step states

2. ✅ **Spine service** - Created `src/services/spine.ts` with:
   - HTTP POST to `/v2/consumer/workflows`
   - Step transformation logic using Proxy objects
   - Conversion of ergonomic API (`args.mediaUrl`, `output.tagging.blob.url`) to raw `$ref` format
   - ID-to-index mapping for step references

3. ✅ **Configuration** - Updated `src/config/index.ts`:
   - Added `spine.url` and `spine.apiKey` config
   - Added `.env.example` entries with defaults

4. ✅ **Action stack integration** - Updated `src/services/event-processor.ts`:
   - Added `actions.spine.req()` to `HandlerActions` interface
   - Wired to spine service singleton

5. ✅ **TypeScript validation** - No errors in spine implementation

### Usage
Handlers can now use `actions.spine.req()` with either format:

```typescript
// Raw format
await actions.spine.req({
  arguments: { mediaUrl: 'https://...' },
  steps: [
    { $type: 'wdTagging', input: { mediaUrl: { $ref: '$arguments', path: 'mediaUrl' } } }
  ]
});

// Ergonomic format (auto-transformed)
await actions.spine.req({
  arguments: { mediaUrl: 'https://...' },
  steps: ({ args, output }) => [
    { $type: 'wdTagging', name: 'tagging', input: { mediaUrl: args.mediaUrl } },
    { $type: 'rating', input: { imageUrl: output.tagging.blob.url } }
  ]
});

// Kafka helper (auto-adds tags, callbacks, and output indices)
import { withKafka } from '@/services/spine'

await actions.spine.req(withKafka({
  topic: 'orchestrator.imageScanned',
  metadata: { imageId: 123 },
  arguments: { url: 'https://...' },
  steps: ({ args }) => [
    { $type: 'wdTagging', input: { mediaUrl: args.url }, output: false },
    { $type: 'rating', input: { imageUrl: args.url }, output: true },
    { $type: 'hash', input: { imageUrl: args.url }, output: true }
  ]
}))
// Automatically generates:
// - tags: ['kafka', 'kafka:orchestrator.imageScanned']
// - callbacks with URL: ...?topic=orchestrator.imageScanned&outputs=1,2
```

```
POST {{host}}/v2/consumer/workflows
Content-Type: application/json
Authorization: Bearer {{$apiKey}}

{
  "metadata": {
    "foo": {...} // any key/value
  },
  "arguments: {
    // instead of a url that points to the image cacher, point to the bucket instead (a presigned url), this would break the circular dependency
    // right now, as part of hitting image.civitai.com, it might decide to hit the orchestrator again to do transcoding (and image resizing going forward)
    "mediaUrl": "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/00000031-9449-4446-bde5-1bb624946aa9/anim=false,width=450,optimized=true/95488350.jpeg"
  },"
  "steps": [
     {
       "$type": "wdTagging",
       "metadata": {
         "foo": {...} // any key/value
       },
       "input": {
        "mediaUrl": {
          "$ref": "$arguments",
          "path": "mediaUrl"
        }
       }
     },
     {
       "$type": "rating",
        "input": {
          "imageUrl": {
            "$ref": "$0",
            "path": "output.blob.url"
          }
        }
     },
     {
       "$type": "hash, // Does not exist yet
        "input": {
          "imageUrl": {
            "$ref": "$arguments",
            "path": "mediaUrl"
          },
          "hashTypes" ["perceptual"]
        }
     }
  ],
  "callbacks": [
    {
      "url": "http://wherever",
      // options:
      // "workflow:*",
      // "workflow:unassigned",
      // "workflow:processing",
      // "workflow:succeeded",
      // "workflow:failed",
      // "workflow:expired",
      // "workflow:canceled",
      // "step:*",
      // "step:unassigned",
      // "step:processing",
      // "step:succeeded",
      // "step:failed",
      // "step:expired",
      // "step:canceled",
      "type": ["workflow:*"],
      // A new property, not added yet but by setting it to true, you can opt-in to receive the workflow/step output in the callback
      "detailed": true
    }
  ]
}
```
