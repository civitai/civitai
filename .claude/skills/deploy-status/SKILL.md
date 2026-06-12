---
name: deploy-status
description: Check civitai PROD deployment status across the live Tekton -> Flux -> Flagger chain on the DataPacket cluster (kubectl, read-only). Tekton/Flagger cluster state is the primary truth; the GitHub Deployments API is kept as a public cross-check. Use to see where a deploy is in the chain, watch it to completion, or debug a build/canary failure.
argument-hint: status [<tag|sha>] | watch [<tag|sha>] | gh-recent | gh-sha:<commit> | logs:<run-name>
allowed-tools:
  - Bash(kubectl:*)
  - Bash(bash:*)
  - Bash(gh:*)
  - Bash(curl:*)
  - Bash(open:*)
  - Bash(xdg-open:*)
---

# Deploy Status

Monitor the **real** civitai PROD deploy chain — Tekton build -> Flux image automation -> Flagger canary -> prod primaries — by reading live cluster state with `kubectl`. The GitHub Deployments API is retained as a public cross-check (its source is the `github-create-deploy` Tekton task).

**Primary truth = cluster state** (this skill's `status` / `watch`). **Cross-check = GitHub Deployments** (`gh-*` commands below).

## Cluster requirement (READ-ONLY)

All `status` / `watch` queries run against the DataPacket cluster via kubectl context **`civit-datapacket`**. One kubeconfig covers the whole chain (build ns `tekton-builds`, Flux ns `flux-system`, app+canary ns `civitai-dp-prod`).

This skill performs **status reads only** — `kubectl get` / `kubectl logs`. It NEVER mutates the cluster (no apply/delete/patch/rollout/scale). To *trigger* or *roll back* a deploy, use the talos-infra `dp-build-deploy` skill instead.

## CRITICAL — prod is NOT keyed off the semver tag

A release maps to prod via the **release-branch commit**, not the tag object. Getting this wrong reports a stage/next build as prod.

| Run name pattern | Branch label | Image | Target | Prod? |
|---|---|---|---|---|
| `civitai-web-build-*` | `release` | `ghcr.io/civitai/civitai-prod` | civitai.com | **YES** |
| `civitai-web-tag-build-*` | `<semver>` (e.g. `v5.0.1817`) | `ghcr.io/civitai/civitai-web` | next/stage | no — EXCLUDE |
| `civitai-web-main-build-*` | `main` | civitai-prod (throttled) | — | no — EXCLUDE |
| `pr-preview-*` / `pr-check-*` | _(none)_ | — | PR preview | no — EXCLUDE |

The semver tag (`vX.Y.Z`) fires a **different** trigger (`civitai-app-tag-trigger`) that builds `civitai-web` (stage) on the tag commit. The PROD run is the `civitai-web-build-*` on the **release-branch** commit. Example: tag `v5.0.1817` -> tag run on commit `5f19831` (civitai-web, NOT prod); the prod run is release commit `3dcd1e8` = `civitai-web-build-cp9kz`.

The prod selector that enforces this:

```bash
kubectl --context civit-datapacket -n tekton-builds get pipelinerun \
  -l pipeline=build-and-push,pipeline.jquad.rocks/git.repository.branch.name=release \
  --sort-by=.metadata.creationTimestamp
```

## Usage (cluster — primary)

Driver script: `deploy-chain.sh` (in this skill dir). Dependency-light bash + kubectl.

- `bash deploy-chain.sh status` — full chain snapshot for the **latest** release-branch prod run.
- `bash deploy-chain.sh status <sha>` — snapshot for the prod run matching that commit (full or short sha, matched on the `git.repository.branch.commit` label). A raw sha for a tag/stage build correctly resolves to **no prod run** (it is never reported as prod).
- `bash deploy-chain.sh status <tag>` — a semver tag (e.g. `v5.0.1817` / `5.0.1817`, must contain a dot) is resolved to the **release-branch HEAD** via `gh`, then matched to its prod run.
- `bash deploy-chain.sh watch [<tag|sha>]` — poll the chain to completion, printing each transition; exits 0 when **both** SSR and API primaries are on the new tag, exits 1 if the build fails or a canary rolls back.

### What `status` prints (the full phase chain)

1. **BUILD** — PipelineRun `.status.conditions` + per-task TaskRuns (ns `tekton-builds`). Task order: `notify-preparing -> github-create-deploy -> fetch-repository -> build-image -> migrations` (plus trailing `github-*`/`notify-*` tasks). `github-create-deploy` is what writes the GitHub Deployments entries.
2. **IMAGE PICKED UP** — Flux ImagePolicy `flux-system/civitai-prod-release` `.status.latestImage` (`ghcr.io/civitai/civitai-prod:<14-digit-ts>-<sha7>`). ~1m GHCR scan.
3. **TAG PINNED TO GIT** — `ImageUpdateAutomation` (`flux-system/civitai-dp-prod`) commits the new tag to trunk (<=5m); reflected once primaries pick it up.
4. **CANARY** — two Flagger Canary CRs in `civitai-dp-prod`: `civitai-dp-prod` (**SSR**) and `civitai-dp-prod-api` (**API / tRPC path**). Reads `.status.phase`, `.status.canaryWeight`, `.status.iterations`, `.status.failedChecks` + recent Warning events (rollbacks).
5. **PRIMARIES (100% prod)** — `civitai-dp-prod-primary` (SSR) and `civitai-dp-prod-api-primary` (API). Deploy is fully live when both primary images == the new tag. **The API primary on the new tag is what makes tRPC procedures live.**

Then an overall **SUMMARY** line: where in the chain + ETA (building / awaiting Flux pickup / canary progressing / rolled back / fully on prod).

Canary progression: `Initialized -> Progressing` (10->50% in 2-min steps) `-> Promoting -> Finalising -> Succeeded`. At rest between deploys a canary sits at `Succeeded weight=0`. End-to-end ~35-40 min (build 15-25).

### Manual one-liners (same queries the script runs)

```bash
CTX="--context civit-datapacket"
# Latest prod run name
kubectl $CTX -n tekton-builds get pipelinerun \
  -l pipeline=build-and-push,pipeline.jquad.rocks/git.repository.branch.name=release \
  --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1].metadata.name}'; echo
# Resolve a specific commit -> prod run
kubectl $CTX -n tekton-builds get pipelinerun \
  -l pipeline=build-and-push,pipeline.jquad.rocks/git.repository.branch.name=release,pipeline.jquad.rocks/git.repository.branch.commit=<FULL_SHA> \
  -o jsonpath='{.items[-1].metadata.name}'; echo
# Build condition + tasks
kubectl $CTX -n tekton-builds get pipelinerun <RUN> -o jsonpath='{.status.conditions[0].reason}: {.status.conditions[0].message}'; echo
kubectl $CTX -n tekton-builds get taskrun -l tekton.dev/pipelineRun=<RUN> --no-headers
# Flux image
kubectl $CTX -n flux-system get imagepolicy civitai-prod-release -o jsonpath='{.status.latestImage}'; echo
# Canaries (both)
kubectl $CTX -n civitai-dp-prod get canary
kubectl $CTX -n civitai-dp-prod get canary civitai-dp-prod-api -o jsonpath='phase={.status.phase} weight={.status.canaryWeight} failedChecks={.status.failedChecks}'; echo
# Primaries
kubectl $CTX -n civitai-dp-prod get deploy civitai-dp-prod-primary     -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
kubectl $CTX -n civitai-dp-prod get deploy civitai-dp-prod-api-primary -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
# Canary rollback / warning events
kubectl $CTX -n civitai-dp-prod get events --field-selector type=Warning --sort-by=.lastTimestamp | tail -10
```

## GitHub Deployments cross-check (public, no cluster)

Useful when you can't reach the cluster or want to confirm the `github-create-deploy` task's view. This is the **secondary** source now.

```bash
# Latest prod deployment + state
DEPLOY_ID=$(gh api repos/civitai/civitai/deployments --jq '[.[] | select(.environment == "prod")] | .[0].id')
gh api "repos/civitai/civitai/deployments/$DEPLOY_ID" --jq '{sha: (.sha[:7]), env: .environment, created: .created_at}'
gh api "repos/civitai/civitai/deployments/$DEPLOY_ID/statuses" --jq '.[0] | {state: .state, description: .description, updated: .updated_at}'

# Recent prod deployments with current state
gh api repos/civitai/civitai/deployments --jq '[.[] | select(.environment == "prod")] | .[:5] | .[].id' | while read id; do
  INFO=$(gh api "repos/civitai/civitai/deployments/$id" --jq '"\(.sha[:7]) \(.created_at)"')
  STATUS=$(gh api "repos/civitai/civitai/deployments/$id/statuses" --jq '.[0] | "\(.state)\t\(.description)"' 2>/dev/null || echo "unknown")
  echo "$id  $INFO  $STATUS"
done

# Specific commit
gh api "repos/civitai/civitai/deployments?sha=COMMIT_SHA" --jq '.[] | {id: .id, env: .environment, created: .created_at}'
```

GitHub Deployment state mapping: `queued` = build, `in_progress` = rolling out, `success` = done, `failure` = failed, `inactive` = superseded.

## Build logs (Tekton)

Cluster (preferred):

```bash
RUN=<civitai-web-build-xxxxx>
# build-image pod logs (BuildKit output / compile errors)
POD=$(kubectl --context civit-datapacket -n tekton-builds get taskrun \
  -l tekton.dev/pipelineRun=$RUN,tekton.dev/pipelineTask=build-image \
  -o jsonpath='{.items[0].status.podName}')
kubectl --context civit-datapacket -n tekton-builds logs $POD --container step-build-and-push --tail=120
```

Dashboard (browser, GitHub-org auth) for a run: `https://tekton.civitai.com/#/namespaces/tekton-builds/pipelineruns/<RUN_NAME>`.

## Debugging cheatsheet

- **Build stuck/slow**: check `build-image` TaskRun + pod logs (above). Common: OOM on Next.js build, BuildKit lock/disk on worker-spare.
- **Image not picked up**: Flux ImagePolicy `latestImage` not advancing — tag must match `^\d{14}-[a-f0-9]+$`. Check ImageRepository `civitai-prod-release` scan.
- **Canary rollback**: `get events --field-selector type=Warning` on ns `civitai-dp-prod`; Flagger needs 99% success rate + P99 < 5000ms, rolls back after 5 failed checks. Check `.status.failedChecks` on **both** canaries.
- **Prod stuck on old image**: confirm both primaries' images; if policy has the new tag but primaries don't after >10m, the ImageUpdateAutomation commit or Kustomization reconcile is lagging — escalate to talos-infra (`dp-build-deploy` skill).

## Access levels

| What | How | Who |
|---|---|---|
| Live chain status (this skill) | kubectl ctx `civit-datapacket` (read-only) | anyone with the DP kubeconfig |
| GitHub deployment status | `gh api` | anyone with GitHub access |
| Build logs | kubectl logs / Tekton Dashboard | DP kubeconfig / civitai org |
| Trigger / rollback / mutate | talos-infra `dp-build-deploy` skill | infra team |
