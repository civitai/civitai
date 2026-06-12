#!/usr/bin/env bash
# deploy-chain.sh — live Tekton → Flux → Flagger deploy-chain status for civitai PROD.
#
# Reads LIVE cluster state (read-only gets only) on the DataPacket cluster.
# Context: civit-datapacket. Namespaces: tekton-builds (build), flux-system (image
# automation), civitai-dp-prod (Flagger canary + app).
#
# CRITICAL — prod is NOT keyed off the semver tag:
#   * PROD  = release-branch push -> civitai-app-build-trigger -> ghcr.io/civitai/civitai-prod
#             run names civitai-web-build-*  (branch label = "release")
#   * The semver tag (vX.Y.Z) fires a DIFFERENT trigger -> ghcr.io/civitai/civitai-web
#             run names civitai-web-tag-build-*  (branch label = "<tag>")  -> next/stage, NOT prod
#   * Also excluded: civitai-web-main-build-* (branch=main), pr-preview-*, pr-check-*
#   The prod run is identified ONLY by labels:
#       pipeline=build-and-push,pipeline.jquad.rocks/git.repository.branch.name=release
#
# Usage:
#   deploy-chain.sh status [<tag|sha>]   # snapshot of where the deploy is in the chain
#   deploy-chain.sh watch  [<tag|sha>]   # poll until prod is fully on the new tag (or canary fails)
#
# No <tag|sha>  -> latest release-branch prod run.
# <sha>         -> matches the prod run by git.repository.branch.commit label (full or short sha).
# <tag>         -> resolves the release-branch HEAD via GitHub, then matches by commit (see note).

set -uo pipefail

CTX=civit-datapacket
NS_BUILD=tekton-builds
NS_FLUX=flux-system
NS_APP=civitai-dp-prod
IMAGE_REPO=ghcr.io/civitai/civitai-prod
POLICY=civitai-prod-release
PRIMARY_SSR=civitai-dp-prod-primary
PRIMARY_API=civitai-dp-prod-api-primary
CANARY_SSR=civitai-dp-prod
CANARY_API=civitai-dp-prod-api
PROD_SELECTOR='pipeline=build-and-push,pipeline.jquad.rocks/git.repository.branch.name=release'

k() { kubectl --context "$CTX" "$@" 2>/dev/null; }

die() { echo "ERROR: $*" >&2; exit 1; }

# ---- resolve the prod PipelineRun name from an optional tag|sha arg --------------
resolve_run() {
  local arg="${1:-}"
  if [ -z "$arg" ]; then
    # latest release-branch run
    k -n "$NS_BUILD" get pipelinerun -l "$PROD_SELECTOR" \
      --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1].metadata.name}'
    return
  fi

  # If it's a run name already, use it.
  if [[ "$arg" == civitai-web-build-* ]]; then
    echo "$arg"; return
  fi

  # Decide tag vs sha. A semver tag looks like v5.0.1817 / 5.0.1817 (has a dot).
  # A git sha is 7-40 hex chars, no dot. Only tags need GitHub release-HEAD resolution
  # (the tag object points at the civitai-web/stage commit, NOT prod).
  local sha="$arg"
  if [[ "$arg" =~ ^v?[0-9]+\.[0-9] ]] && command -v gh >/dev/null 2>&1; then
    # The tag object itself points at the civitai-web (stage) commit, NOT prod.
    # Prod for a release maps to the release BRANCH head. Resolve that sha.
    local rel
    rel=$(gh api repos/civitai/civitai/git/refs/heads/release --jq '.object.sha' 2>/dev/null)
    if [ -n "$rel" ]; then sha="$rel"; fi
  fi

  # Match prod run by commit label (try full sha, then prefix match across runs).
  local run
  run=$(k -n "$NS_BUILD" get pipelinerun \
    -l "${PROD_SELECTOR},pipeline.jquad.rocks/git.repository.branch.commit=${sha}" \
    --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1].metadata.name}')
  if [ -n "$run" ]; then echo "$run"; return; fi

  # Prefix fallback: scan release runs for a commit label starting with the given sha.
  k -n "$NS_BUILD" get pipelinerun -l "$PROD_SELECTOR" \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.labels.pipeline\.jquad\.rocks/git\.repository\.branch\.commit}{"\n"}{end}' \
    | awk -v s="$sha" '$2 ~ "^"s {n=$1} END{print n}'
}

short() { echo "${1:0:7}"; }

# ---- phase 1: build -------------------------------------------------------------
print_build() {
  local run="$1"
  local commit cond reason msg
  commit=$(k -n "$NS_BUILD" get pipelinerun "$run" \
    -o jsonpath='{.metadata.labels.pipeline\.jquad\.rocks/git\.repository\.branch\.commit}')
  reason=$(k -n "$NS_BUILD" get pipelinerun "$run" -o jsonpath='{.status.conditions[0].reason}')
  msg=$(k -n "$NS_BUILD" get pipelinerun "$run" -o jsonpath='{.status.conditions[0].message}')

  echo "=== [1] BUILD (prod / release branch) ==="
  echo "  run:     $run"
  echo "  commit:  $(short "$commit")  ($commit)"
  echo "  status:  $reason — $msg"
  echo "  tasks (notify-preparing -> github-create-deploy -> fetch-repository -> build-image -> migrations):"
  k -n "$NS_BUILD" get taskrun -l "tekton.dev/pipelineRun=$run" \
    --sort-by=.metadata.creationTimestamp \
    -o custom-columns='  TASK:.metadata.labels.tekton\.dev/pipelineTask,STATUS:.status.conditions[0].reason' \
    --no-headers 2>/dev/null | sed 's/^/  /'
  echo "$commit"  # returned via stdout tail for callers
}

# ---- phase 2/3: image policy ----------------------------------------------------
print_image() {
  local latest
  latest=$(k -n "$NS_FLUX" get imagepolicy "$POLICY" -o jsonpath='{.status.latestImage}')
  echo "=== [2] IMAGE PICKED UP (Flux ImagePolicy $POLICY) ==="
  echo "  latestImage: ${latest:-<none>}"
  echo "$latest"
}

# ---- phase 4: canary ------------------------------------------------------------
print_canary_one() {
  local name="$1" label="$2"
  local phase weight iter failed
  phase=$(k -n "$NS_APP" get canary "$name" -o jsonpath='{.status.phase}')
  weight=$(k -n "$NS_APP" get canary "$name" -o jsonpath='{.status.canaryWeight}')
  iter=$(k -n "$NS_APP" get canary "$name" -o jsonpath='{.status.iterations}')
  failed=$(k -n "$NS_APP" get canary "$name" -o jsonpath='{.status.failedChecks}')
  printf "  %-4s %-18s phase=%-12s weight=%-3s iterations=%-2s failedChecks=%s\n" \
    "$label" "$name" "${phase:-?}" "${weight:-0}" "${iter:-0}" "${failed:-0}"
}

print_canary() {
  echo "=== [4] CANARY (Flagger, ns $NS_APP) ==="
  print_canary_one "$CANARY_SSR" "SSR"
  print_canary_one "$CANARY_API" "API"
  echo "  recent rollback/warning events:"
  k -n "$NS_APP" get events --field-selector type=Warning --sort-by=.lastTimestamp \
    -o custom-columns='  TIME:.lastTimestamp,OBJ:.involvedObject.name,MSG:.message' --no-headers 2>/dev/null \
    | grep -E "$CANARY_SSR|$CANARY_API" | tail -5 | sed 's/^/  /'
}

# ---- phase 5: primaries ---------------------------------------------------------
print_primaries() {
  local ssr api
  ssr=$(k -n "$NS_APP" get deploy "$PRIMARY_SSR" -o jsonpath='{.spec.template.spec.containers[0].image}')
  api=$(k -n "$NS_APP" get deploy "$PRIMARY_API" -o jsonpath='{.spec.template.spec.containers[0].image}')
  echo "=== [5] PRIMARIES (100% prod — what users hit) ==="
  echo "  SSR primary ($PRIMARY_SSR): ${ssr:-<none>}"
  echo "  API primary ($PRIMARY_API): ${api:-<none>}  <- tRPC procedures go live here"
  echo "$ssr|$api"
}

# ---- overall summary ------------------------------------------------------------
# Args: build_reason, target_image, latest_image, ssr_prim, api_prim, canary_ssr_phase
summarize() {
  local breason="$1" target="$2" latest="$3" ssr="$4" api="$5" cphase="$6"
  echo "=== SUMMARY: where in the chain + ETA ==="
  if [[ "$breason" =~ Failed|Error|PipelineRunTimeout ]]; then
    echo "  PHASE: BUILD FAILED ($breason). Inspect taskrun logs. STOP."
    return
  fi
  # The target (this run's) image being in the policy means build-image + push +
  # Flux scan all completed — even if trailing notify/github taskruns are still Running.
  local img_ready=0
  if [ -n "$target" ] && [[ "$latest" == *"$(short "$target")"* ]]; then img_ready=1; fi

  if [ "$img_ready" = 0 ]; then
    if [ "$breason" = "Succeeded" ] || [ "$breason" = "Completed" ]; then
      echo "  PHASE: BUILD DONE, awaiting Flux pickup. Policy still on ${latest##*:}. ETA ~1-6m."
    else
      echo "  PHASE: BUILDING ($breason). ETA ~15-25m for image, ~35-40m end-to-end."
    fi
    return
  fi
  # image in policy — are primaries on it?
  if [ "$ssr" = "$api" ] && [ "$ssr" = "$latest" ]; then
    if [ "$cphase" = "Succeeded" ] || [ "$cphase" = "Initialized" ] || [ -z "$cphase" ]; then
      echo "  PHASE: FULLY ON PROD. Both primaries == $latest. Done."
      return
    fi
  fi
  case "$cphase" in
    Progressing|Promoting|Finalising)
      echo "  PHASE: CANARY $cphase. Rolling 10->50% in 2-min steps. ETA ~4-10m to 100%." ;;
    Failed|*ollback*)
      echo "  PHASE: CANARY $cphase — ROLLED BACK. Prod stays on old image. STOP." ;;
    *)
      echo "  PHASE: image in policy ($latest); primaries SSR=$ssr API=$api. Canary=$cphase. ETA ~4-10m." ;;
  esac
}

cmd_status() {
  local run; run=$(resolve_run "${1:-}")
  [ -z "$run" ] && die "could not resolve a prod (release-branch) PipelineRun for '${1:-latest}'"
  echo "############################################################"
  echo "# CIVITAI PROD DEPLOY CHAIN — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# (prod = release-branch -> civitai-prod; tag/main/pr builds excluded)"
  echo "############################################################"

  local bout; bout=$(print_build "$run"); echo "$bout" | sed '$d'
  local commit; commit=$(echo "$bout" | tail -1)
  local breason; breason=$(k -n "$NS_BUILD" get pipelinerun "$run" -o jsonpath='{.status.conditions[0].reason}')
  echo
  local iout; iout=$(print_image); echo "$iout" | sed '$d'
  local latest; latest=$(echo "$iout" | tail -1)
  echo
  print_canary
  local cphase; cphase=$(k -n "$NS_APP" get canary "$CANARY_SSR" -o jsonpath='{.status.phase}')
  echo
  local pout; pout=$(print_primaries); echo "$pout" | sed '$d'
  local prim; prim=$(echo "$pout" | tail -1)
  local ssr="${prim%%|*}" api="${prim##*|}"
  echo
  # target image = the policy image once build done & picked up; else infer from commit
  summarize "$breason" "$commit" "$latest" "$ssr" "$api" "$cphase"
}

cmd_watch() {
  local run; run=$(resolve_run "${1:-}")
  [ -z "$run" ] && die "could not resolve a prod PipelineRun for '${1:-latest}'"
  echo "Watching prod deploy chain for run: $run  (Ctrl-C to stop)"
  local last=""
  while true; do
    local breason cphase capi latest ssr api
    breason=$(k -n "$NS_BUILD" get pipelinerun "$run" -o jsonpath='{.status.conditions[0].reason}')
    latest=$(k -n "$NS_FLUX" get imagepolicy "$POLICY" -o jsonpath='{.status.latestImage}')
    cphase=$(k -n "$NS_APP" get canary "$CANARY_SSR" -o jsonpath='{.status.phase}')
    capi=$(k -n "$NS_APP" get canary "$CANARY_API" -o jsonpath='{.status.phase}')
    ssr=$(k -n "$NS_APP" get deploy "$PRIMARY_SSR" -o jsonpath='{.spec.template.spec.containers[0].image}')
    api=$(k -n "$NS_APP" get deploy "$PRIMARY_API" -o jsonpath='{.spec.template.spec.containers[0].image}')
    local cw; cw=$(k -n "$NS_APP" get canary "$CANARY_SSR" -o jsonpath='{.status.canaryWeight}')
    # Rollout progress: Flagger flips the primary SPEC image at promote-time, but
    # the primary Deployment's pod rolling-update (updated->ready replicas) lags by
    # minutes. A procedure added in the new image is NOT_FOUND on the not-yet-rolled
    # pods, so "done" must mean rollout-complete, not just spec image == new tag.
    local su sd sr2 au ad ar
    read -r su sd sr2 < <(k -n "$NS_APP" get deploy "$PRIMARY_SSR" -o jsonpath='{.status.updatedReplicas} {.spec.replicas} {.status.readyReplicas}')
    read -r au ad ar < <(k -n "$NS_APP" get deploy "$PRIMARY_API" -o jsonpath='{.status.updatedReplicas} {.spec.replicas} {.status.readyReplicas}')
    local line="build=$breason policy=${latest##*:} canarySSR=$cphase(w=$cw) canaryAPI=$capi ssrPrim=${ssr##*:}(roll ${su:-0}/${sd:-?}) apiPrim=${api##*:}(roll ${au:-0}/${ad:-?})"
    if [ "$line" != "$last" ]; then
      echo "[$(date -u +%H:%M:%SZ)] $line"
      last="$line"
    fi
    # exit conditions
    if [[ "$breason" =~ Failed|Error|PipelineRunTimeout ]]; then
      echo ">>> BUILD FAILED ($breason). Exiting."; exit 1
    fi
    if [[ "$cphase" =~ Failed ]] || [[ "$capi" =~ Failed ]]; then
      echo ">>> CANARY FAILED/ROLLED BACK (SSR=$cphase API=$capi). Exiting."; exit 1
    fi
    # Fully done = new image promoted AND both primaries fully rolled
    # (updated == desired == ready), so every serving pod runs the new code.
    local rollout_done=""
    if [ -n "$sd" ] && [ "$su" = "$sd" ] && [ "$sr2" = "$sd" ] \
       && [ -n "$ad" ] && [ "$au" = "$ad" ] && [ "$ar" = "$ad" ]; then
      rollout_done=1
    fi
    if [ -n "$latest" ] && [ "$ssr" = "$latest" ] && [ "$api" = "$latest" ] \
       && { [ "$cphase" = "Succeeded" ] || [ "$cphase" = "Initialized" ]; } \
       && { [ "$capi" = "Succeeded" ] || [ "$capi" = "Initialized" ]; } \
       && [ -n "$rollout_done" ]; then
      echo ">>> PROD FULLY ON $latest — both primaries promoted AND rolled out (SSR ${su}/${sd}, API ${au}/${ad}). Done."; exit 0
    fi
    sleep 30
  done
}

ACTION="${1:-status}"; shift || true
case "$ACTION" in
  status) cmd_status "${1:-}" ;;
  watch)  cmd_watch  "${1:-}" ;;
  *) die "unknown action '$ACTION' (use: status | watch)" ;;
esac
