---
name: deploy-status
description: Check deployment status, view pipeline progress, and debug build failures. Combines GitHub Deployments API (public status) with Tekton Dashboard API (authenticated logs). No cluster access required.
argument-hint: [recent | sha:<commit> | env:<environment> | logs:<run-name>]
allowed-tools:
  - Bash(gh:*)
  - Bash(curl:*)
  - Bash(open:*)
  - Bash(xdg-open:*)
---

# Deploy Status

Check civitai-web deployment status and debug build failures. Two tiers of access:

1. **Status** (public, via `gh api`): deployment state, timestamps, descriptions
2. **Logs** (authenticated, via Tekton Dashboard): build output, error details, task logs

## Usage

- `/deploy-status` or `/deploy-status recent` — show recent deployments with status
- `/deploy-status sha:<commit>` — check deployment for a specific commit
- `/deploy-status logs:<run-name>` — open Tekton Dashboard for a specific pipeline run
- `/deploy-status debug` — investigate the latest failure

## Quick Status Check

### Latest deployment status
```bash
DEPLOY_ID=$(gh api repos/civitai/civitai/deployments --jq '[.[] | select(.environment == "prod")] | .[0].id')
echo "Deployment: $DEPLOY_ID"
gh api "repos/civitai/civitai/deployments/$DEPLOY_ID" --jq '{sha: (.sha[:7]), env: .environment, created: .created_at}'
gh api "repos/civitai/civitai/deployments/$DEPLOY_ID/statuses" --jq '.[0] | {state: .state, description: .description, updated: .updated_at}'
```

### Recent deployments with current state
```bash
gh api repos/civitai/civitai/deployments --jq '[.[] | select(.environment == "prod")] | .[:5] | .[].id' | while read id; do
  INFO=$(gh api "repos/civitai/civitai/deployments/$id" --jq '"\(.sha[:7]) \(.created_at)"')
  STATUS=$(gh api "repos/civitai/civitai/deployments/$id/statuses" --jq '.[0] | "\(.state)\t\(.description)"' 2>/dev/null || echo "unknown")
  echo "$id  $INFO  $STATUS"
done
```

### Check specific commit
```bash
gh api "repos/civitai/civitai/deployments?sha=COMMIT_SHA" --jq '.[] | {id: .id, env: .environment, created: .created_at}'
```

### Full status timeline for a deployment
```bash
gh api "repos/civitai/civitai/deployments/DEPLOY_ID/statuses" --jq 'reverse | .[] | {state: .state, description: .description, time: .updated_at}'
```

## Debugging Failures

### Step 1: Find the failed deployment
```bash
gh api repos/civitai/civitai/deployments --jq '
  [.[] | select(.environment == "prod")] | .[:5] | .[] |
  {id: .id, sha: (.sha[:7]), created: .created_at}
' | head -20

# Get statuses for the latest
DEPLOY_ID=$(gh api repos/civitai/civitai/deployments --jq '[.[] | select(.environment == "prod")] | .[0].id')
gh api "repos/civitai/civitai/deployments/$DEPLOY_ID/statuses" --jq '.[] | {state: .state, description: .description, time: .updated_at}'
```

### Step 2: Open Tekton Dashboard for details

The Tekton Dashboard provides full build logs, task output, and error details.
Access requires GitHub org membership (civitai/oauth team).

**Dashboard URLs:**

| View | URL |
|------|-----|
| All pipeline runs | `https://tekton.civitai.com/#/namespaces/tekton-builds/pipelineruns` |
| Specific run | `https://tekton.civitai.com/#/namespaces/tekton-builds/pipelineruns/<RUN_NAME>` |
| Task runs | `https://tekton.civitai.com/#/namespaces/tekton-builds/taskruns` |

Open a specific run in browser:
```bash
# Replace RUN_NAME with the pipeline run name (e.g., civitai-web-deploy-vgp54)
xdg-open "https://tekton.civitai.com/#/namespaces/tekton-builds/pipelineruns/RUN_NAME"
```

### Step 3: Access Tekton API via curl (authenticated)

For programmatic access to pipeline details and logs, curl the Tekton Dashboard API.
Requires a valid session cookie from browser login.

**First-time setup (one-time per session):**
1. Open https://tekton.civitai.com in your browser and log in via GitHub
2. Copy the `_oauth2_proxy` cookie value from your browser's dev tools
3. Export it:
```bash
export TEKTON_COOKIE="_oauth2_proxy=<your-cookie-value>"
```

**API endpoints:**

```bash
TEKTON="https://tekton.civitai.com"

# List recent pipeline runs
curl -s -b "$TEKTON_COOKIE" "$TEKTON/apis/tekton.dev/v1/namespaces/tekton-builds/pipelineruns?limit=10" \
  | jq '.items[] | {name: .metadata.name, status: .status.conditions[0].reason, started: .status.startTime}'

# Get specific pipeline run details
curl -s -b "$TEKTON_COOKIE" "$TEKTON/apis/tekton.dev/v1/namespaces/tekton-builds/pipelineruns/RUN_NAME" \
  | jq '{
    name: .metadata.name,
    status: .status.conditions[0].reason,
    message: .status.conditions[0].message,
    tasks: [.status.childReferences[] | {task: .pipelineTaskName, name: .name}]
  }'

# List task runs for a pipeline run
curl -s -b "$TEKTON_COOKIE" "$TEKTON/apis/tekton.dev/v1/namespaces/tekton-builds/taskruns?labelSelector=tekton.dev/pipelineRun=RUN_NAME" \
  | jq '.items[] | {
    task: .metadata.labels["tekton.dev/pipelineTask"],
    status: .status.conditions[0].reason,
    message: .status.conditions[0].message
  }'

# Get pod logs for a failed task (replace TASK_POD_NAME)
curl -s -b "$TEKTON_COOKIE" "$TEKTON/api/v1/namespaces/tekton-builds/pods/TASK_POD_NAME/log?container=step-build-and-push&tailLines=100"
```

**Common container names for log retrieval:**

| Task | Container | What it shows |
|------|-----------|---------------|
| build-image | `step-build-and-push` | BuildKit output, compilation errors |
| build-image-secondary | `step-build-and-push` | Green image build |
| tag-do-image | `step-tag` | Image tagging with crane |
| deploy-do | `step-clone-deployment-repo` | Git clone of deployment repo |
| deploy-do | `step-deploy` | ConfigMap update, manifest apply, rollout status |
| notify-* | `step-notify` | Node-RED webhook calls |

### Debugging cheatsheet

**Build failed:**
```bash
# Open build logs in dashboard
xdg-open "https://tekton.civitai.com/#/namespaces/tekton-builds/pipelineruns/RUN_NAME"
# Look at build-image task → step-build-and-push logs
# Common causes: TypeScript errors, dependency issues, out of disk
```

**Deploy failed:**
```bash
# Check deploy-do task logs
# Common causes: DO kubeconfig expired, manifest invalid, rollout timeout
xdg-open "https://tekton.civitai.com/#/namespaces/tekton-builds/pipelineruns/RUN_NAME"
```

**Pipeline stuck in queued:**
```bash
# Check if build node has disk pressure or other scheduling issues
# This requires cluster access — escalate to infra team
gh api "repos/civitai/civitai/deployments/$DEPLOY_ID/statuses" --jq '.[0]'
# If stuck in "queued" for >30min, the build node may be unhealthy
```

## Interpreting States

| State | Phase | Meaning |
|-------|-------|---------|
| `queued` | Build | Pipeline started, image building (~12min) |
| `in_progress` | Deploy | Build succeeded, rolling out to DO cluster (~6min) |
| `success` | Done | All 6 deployments rolled out |
| `failure` | Error | Pipeline failed — check Tekton Dashboard for details |
| `inactive` | Superseded | Replaced by a newer deployment |

## Pipeline Architecture

```
Push to release branch
  → Tekton: build image (BuildKit, ~12min)
  → GitHub: deployment status = queued
  → Tekton: tag as civitai-prod:latest (crane)
  → GitHub: deployment status = in_progress
  → Tekton: update ConfigMap + apply manifest + rolling restart (~6min)
  → GitHub: deployment status = success | failure
```

**Deployments tracked:**
civitai, civitai-trpc, civitai-api, civitai-job, civitai-api-internal, civitai-auth

## Access Levels

| What | How | Who |
|------|-----|-----|
| Deployment status | `gh api` | Anyone with GitHub access |
| Build logs & details | Tekton Dashboard | civitai org / oauth team members |
| Cluster operations | kubectl | Infra team only |
