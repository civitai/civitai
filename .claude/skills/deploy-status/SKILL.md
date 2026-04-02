---
name: deploy-status
description: Check deployment status for civitai-web builds and DO cluster rollouts. Shows pipeline progress, build times, and deployment history without needing cluster access.
argument-hint: [recent | sha:<commit> | env:<environment>]
allowed-tools:
  - Bash(gh:*)
  - Bash(curl:*)
---

# Deploy Status

Check civitai-web deployment status via GitHub Deployments API. No cluster access required — uses `gh` CLI.

## Usage

- `/deploy-status` or `/deploy-status recent` — show recent deployments
- `/deploy-status sha:abc1234` — check deployment for a specific commit
- `/deploy-status env:do-prod` — filter by environment

## How It Works

The Tekton pipeline posts deployment status updates to GitHub at each lifecycle phase:
- **queued** — pipeline started
- **in_progress** — build complete, deploying to cluster
- **success** — all deployments rolled out
- **failure** — pipeline failed (check Tekton dashboard)

## Commands

### List recent deployments
```bash
gh api repos/civitai/civitai/deployments \
  --jq '.[:10] | .[] | {
    id: .id,
    env: .environment,
    ref: (.sha[:7]),
    description: .description,
    created: .created_at,
    creator: .creator.login
  }'
```

### Get deployment status (latest for each deployment)
```bash
gh api repos/civitai/civitai/deployments --jq '.[:5] | .[].id' | while read id; do
  gh api "repos/civitai/civitai/deployments/$id/statuses" \
    --jq '.[0] | {
      deploy_id: ('$id'),
      state: .state,
      description: .description,
      updated: .updated_at,
      log_url: .log_url
    }'
done
```

### Check deployment for a specific commit
```bash
gh api "repos/civitai/civitai/deployments?sha=COMMIT_SHA" \
  --jq '.[] | {id: .id, env: .environment, created: .created_at}'
```

Then get its statuses:
```bash
gh api repos/civitai/civitai/deployments/DEPLOY_ID/statuses \
  --jq '.[] | {state: .state, description: .description, updated: .updated_at}'
```

### Filter by environment
```bash
gh api "repos/civitai/civitai/deployments?environment=do-prod" \
  --jq '.[:5] | .[] | {id: .id, ref: (.sha[:7]), created: .created_at}'
```

### One-liner: current deploy status
```bash
gh api repos/civitai/civitai/deployments --jq '
  [.[] | select(.environment == "do-prod")] | .[0] as $d |
  ($d | {env: .environment, sha: (.sha[:7]), created: .created_at}),
  "---",
  (input | .[0] | {state: .state, description: .description, updated: .updated_at})
' --paginate 2>/dev/null || \
DEPLOY_ID=$(gh api repos/civitai/civitai/deployments --jq '[.[] | select(.environment == "do-prod")] | .[0].id') && \
echo "Latest do-prod deployment: $DEPLOY_ID" && \
gh api "repos/civitai/civitai/deployments/$DEPLOY_ID/statuses" --jq '.[0]'
```

## Interpreting Results

| State | Meaning |
|-------|---------|
| `queued` | Pipeline just started, building image |
| `in_progress` | Image built successfully, deploying to DO cluster |
| `success` | All 6 deployments rolled out (civitai, civitai-trpc, civitai-api, civitai-job, civitai-api-internal, civitai-auth) |
| `failure` | Pipeline failed — check description or Tekton dashboard at https://tekton.civitai.com |
| `error` | Unexpected error |

## Pipeline Architecture

```
Push to release branch
  → Tekton: build image (BuildKit, ~12min)
  → Tekton: tag as civitai-prod:latest (crane)
  → Tekton: update ConfigMap + apply manifest + rolling restart
  → GitHub: deployment status updated at each phase
```

## Environments

| Environment | Cluster | Trigger |
|-------------|---------|---------|
| `do-prod` | DigitalOcean | Push to `release` branch |

## Dashboard

For detailed logs and build output, visit: https://tekton.civitai.com
(Requires GitHub org membership in civitai/oauth team)
