---
name: civitai-orchestration
description: Query and explore Civitai Orchestration workflows, jobs, and results. Use for analyzing image/video generation jobs, viewing job results, searching by workflow ID, job ID, user, or date range.
allowed-tools: Bash(node:*)
argument-hint: "[command] [options]"
---

# Civitai Orchestration

Interact with the Civitai Orchestration API to query workflows, view job details, and retrieve generation results.

## Quick Start

```bash
# Query workflows for a specific user
node .claude/skills/civitai-orchestration/civitai-client.js user 12345

# Get a specific workflow by ID
node .claude/skills/civitai-orchestration/civitai-client.js workflow <workflowId>

# Get job details with scan results (hive_csam_score, etc.)
node .claude/skills/civitai-orchestration/civitai-client.js job <jobId>

# Get step details from a workflow
node .claude/skills/civitai-orchestration/civitai-client.js step <workflowId> <stepName>

# Download result images/videos from a workflow
node .claude/skills/civitai-orchestration/civitai-client.js results <workflowId>
```

## Searching & Filtering

### By User ID

```bash
# Get workflows for user 12345
node civitai-client.js user 12345

# With options
node civitai-client.js user 12345 --take=5 --excludeFailed
```

### By Workflow ID
```bash
# Direct lookup by workflow ID
node civitai-client.js workflow 0-019be44b-181e-7a7e-ab1b-b58dc7610dca
```

### By Date Range

**Note:** Date filtering may have limited functionality depending on API access level.

```bash
# Workflows from the last 7 days
node civitai-client.js workflows --from=2024-01-15 --to=2024-01-22

# Workflows from a specific day
node civitai-client.js workflows --from=2024-01-20 --to=2024-01-20

# Dates are assumed to be UTC. Add Z suffix for explicit UTC:
node civitai-client.js workflows --from=2024-01-20T06:00:00Z --to=2024-01-20T12:00:00Z
```

**Alternative:** Use `--oldest` to get workflows from oldest first, then paginate:
```bash
# Get oldest workflows first
node civitai-client.js workflows --oldest --take=50
```

### By Tags
Tags are set when workflows are created. Common tag patterns:
```bash
# Filter by a specific tag
node civitai-client.js workflows --tag=user:12345

# Note: Multiple tags can be specified (AND logic)
node civitai-client.js workflows --tag=project:myproject --tag=type:image
```

### By Metadata Search
The `--query` option searches workflow metadata:
```bash
# Search metadata for a string
node civitai-client.js workflows --query="portrait"
```

### By Status

The API supports excluding failed workflows but not filtering by specific status:

```bash
# Exclude failed/canceled workflows (get only succeeded/processing)
node civitai-client.js workflows --excludeFailed

# Include all statuses (default behavior)
node civitai-client.js workflows
```

**Note:** To find specific statuses, retrieve workflows and filter client-side, or use metadata/tags when creating workflows for better filtering.

### Pagination
```bash
# Get 50 results
node civitai-client.js workflows --take=50

# Get next page using cursor from previous response
node civitai-client.js workflows --take=20 --cursor=<nextCursor>
```

### Combined Filters
```bash
# Successful workflows for a specific tag, excluding failures
node civitai-client.js workflows \
  --tag=user:12345 \
  --excludeFailed \
  --take=50

# Get workflows with metadata search
node civitai-client.js workflows \
  --query="portrait" \
  --excludeFailed \
  --take=20
```

## Commands Reference

### test

Test API connection and verify credentials.

```bash
node civitai-client.js test
```

### user

Query workflows for a specific user by their Civitai user ID.

```bash
node civitai-client.js user <userId> [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--take=<n>` | Number of results (max 10 per API limit) |
| `--tag=<tag>` | Filter by tag |
| `--query=<text>` | Search workflow metadata |
| `--excludeFailed` | Exclude failed/canceled workflows |
| `--oldest` | Sort from oldest to newest |

### workflows

List and search workflows with optional filters.

```bash
node civitai-client.js workflows [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--tag=<tag>` | Filter by tag (can specify multiple) |
| `--query=<text>` | Search workflow metadata |
| `--excludeFailed` | Exclude failed/canceled workflows |
| `--oldest` | Sort from oldest to newest |
| `--take=<n>` | Number of results (default: 20) |
| `--cursor=<cursor>` | Pagination cursor |
| `--from=<date>` | Start date (may have limited support) |
| `--to=<date>` | End date (may have limited support) |

### workflow

Get details of a specific workflow.

```bash
node civitai-client.js workflow <workflowId> [--wait]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--wait` | Wait/poll for completion (with timeout) |

### job

Get details of a specific job including scan results from event context.

This is useful for investigating content moderation results - the `lastEvent.context` contains scan scores like `hive_csam_score` and `hive_vlm_summary`.

```bash
node civitai-client.js job <jobId> [--raw]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--raw` | Output raw JSON instead of formatted summary |

**Example output:**
```
Job Summary:
  ID: 58de87d7-d594-4d71-ae43-dd8fc1bcbd23
  Type: TextToImageV2
  Workflow ID: 8484131-20260121222126332

Prompt Classification: sexual, young, scan

Results (2 blob(s)):
  - JNFDW54JNTATNW42HACYCWSQP0.jpeg (available: true)

Last Event:
  Type: Succeeded
  Provider: ValdiAI

Event Context (scan results, metrics):
  ** hive_csam_score: 0.00 %, 0.00 %
  ** hive_vlm_summary: X, No_Child
```

### step

Get details of a specific step within a workflow.

```bash
node civitai-client.js step <workflowId> <stepName>
```

### results

Download or view results (images/videos) from a workflow.

```bash
node civitai-client.js results <workflowId> [--download] [--dir=<path>]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--download` | Download result files |
| `--dir=<path>` | Download directory (default: ./civitai-downloads) |

### blob

Get a blob (image/video) by ID with optional NSFW handling.

```bash
node civitai-client.js blob <blobId> [--download] [--nsfw]
```

## Environment Variables

Stored in `.claude/skills/civitai-orchestration/.env`:

```env
CIVITAI_API_TOKEN=your_bearer_token
CIVITAI_API_URL=https://orchestration-new.civitai.com
```

## API Reference

### Workflow Query Parameters

The workflows endpoint supports these query parameters:
- `tags` - Array of tags to filter by
- `query` - Search workflow metadata
- `fromDate` / `toDate` - Date range (ISO 8601) - may have limited support
- `cursor` - Pagination cursor
- `take` - Number of results (default: 100)
- `excludeFailed` - Exclude failed/expired/canceled workflows (boolean)
- `ascending` - Sort oldest to newest (boolean)

### Workflow Statuses

| Status | Description |
|--------|-------------|
| `preparing` | Workflow being prepared |
| `scheduled` | Scheduled for execution |
| `processing` | Currently running |
| `succeeded` | Completed successfully |
| `failed` | Failed with error |
| `canceled` | Was canceled |
| `expired` | Timed out |
| `deleted` | Deleted |

### Step Types (Recipes)

Image/Video generation steps you might encounter:
- `textToImage` - Text to image generation
- `imageGen` - General image generation
- `videoGen` - Video generation
- `videoEnhancement` - Video upscaling/enhancement
- `videoFrameExtraction` - Extract frames from video
- `videoUpscaler` - Upscale video
- `videoInterpolation` - Frame interpolation
- `convertImage` - Convert image formats
- `comfy` - ComfyUI workflow execution

## Examples

### Query a user's recent image generations

```bash
# Get user 12345's recent workflows
node civitai-client.js user 12345

# Exclude failed jobs
node civitai-client.js user 12345 --excludeFailed
```

### Get workflow and view results

```bash
# Get workflow details
node civitai-client.js workflow abc123-def456

# View/download results
node civitai-client.js results abc123-def456 --download --dir=./my-images
```

### Paginate through workflows

```bash
# First page
node civitai-client.js workflows --take=10

# Next page (use cursor from previous response)
node civitai-client.js workflows --take=10 --cursor=<nextCursor>
```

## Error Handling

| Error Code | Meaning |
|------------|---------|
| 401 | Invalid or expired token - check CIVITAI_API_TOKEN |
| 404 | Workflow/Job not found |
| 429 | Rate limited - wait before retrying |
| 422 | Invalid parameters |

## Output

The `user` command displays workflow summaries including:
- Workflow ID, status, timestamps
- Step types (textToImage, videoGen, comfy, etc.)
- Prompts for text-to-image generations

For raw JSON output, use the workflow command:
```bash
node civitai-client.js workflow <workflowId>
```
