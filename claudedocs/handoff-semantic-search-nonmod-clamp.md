# Handoff: semantic-search-nonmod-clamp — 2026-11-13

## Run this first — the index, one command
```bash
$DEVRC/scripts/cairn-ops/read.sh recall --repo "/home/zach/workspace/civit/civitai"
```
Terse pointers this doc does not carry, curated by past sessions and outliving it.
🔴 RECALL, NOT LIVE OBSERVATION — every line is a pointer to VERIFY, never a current
reading, and it may describe a gotcha already fixed. `scope-absent`/`scope-empty` means
nothing is recorded yet: ordinary, not an error, and not a clean bill of health.
Non-blocking: if it exits non-zero, print the stderr line and carry on.
Second useful recall — the Flipt-serving / rollout side this arc was verified against:
`$DEVRC/scripts/cairn-ops/read.sh recall --repo "/home/zach/workspace/civit/datapacket-talos"`.

## Goal
Hold the non-moderator semantic-search safe-level clamp across the 5.1.490 rollout.
civitai#8750 makes that clamp conditional on the Flipt key `semantic-search-nonmod-clamp`
and the key was served `enabled: false`, so 5.1.490 would have LIFTED the clamp for
non-moderators (images, articles, comics) the moment it served. Moderation wants the
clamp held until a served check passes.
- **closing-condition:** `judgement` — moderation (Justin) runs the served check against
  live 5.1.490; on pass, `civitai/flipt-state` `civitai-app/default/features.yaml` returns
  `semantic-search-nonmod-clamp` to `enabled: false` (i.e. reverts #469) and the clamp lifts.

## State now
- Branch / PR: `civitai` main. `civitai/flipt-state` main @ **`fb0e09c`** (squash of #469).
  civitai #8750 **MERGED** (mergeCommit `11fd1260`). Release tag `v5.1.490` = commit
  `226ce795`, tag created 2026-11-13T13:59:50Z.
- What's DONE this session:
  - Verified #8750 is IN v5.1.490: `gh api repos/civitai/civitai/compare/v5.1.489...v5.1.490`
    lists `11fd1260`.
  - Verified the then-live release was 5.1.489 and did NOT contain #8750:
    `ghcr.io/civitai/civitai-prod:20261113050408-927df45` = commit `927df45` = "5.1.489"
    (05:01:27Z); `compare/927df45...11fd126` → ahead 43.
  - flipt-state #469 (one line: `enabled: false` → `true` for `semantic-search-nonmod-clamp`)
    validated before landing: `validate` check SUCCESS, `MERGEABLE`, `CLEAN`, branch
    unprotected, no required reviews. **Merged by Justin at 14:34:50Z** → `fb0e09c`.
  - Validated propagation + effect in prod Flipt: served revision `fb0e09c` (== main HEAD);
    flag payload `enabled: true`; `POST /evaluate/v1/boolean` for an anonymous non-mod
    → `{"enabled":true}` (clamp ON); `flipt_git_view_errors_total` flat at 4 across 25 s.
  - 5.1.490 served DURING the check: image `ghcr.io/civitai/civitai-prod:20261113140757-226ce79`
    (Flux ImagePolicy picked it up), `civitai-dp-prod-primary` 60/60 pods, `rollout status`
    = successfully rolled out.
- What's IN FLIGHT: nothing.
- Deploy/verify status: **DEPLOYED and VERIFIED.** The flag was ON and served before
  5.1.490 served, so the clamp is held on the live release. Verified against the real path
  (prod Flipt evaluation + live pods), not just "rollout complete".

## Open investigations — live diagnosis state
### `download-scope-gate` is evaluated by the app but absent from Flipt — errors on every eval
- as-of: 2026-11-13
- **Symptom + exact repro:** a live 5.1.490 pod logs
  `[flipt] evaluation error: Error: invalid request: failed to get flag information default/download-scope-gate`.
  Repro: `KUBECONFIG=$KC_DPPROD kubectl -n civitai-dp-prod logs <5.1.490-pod> --since=10m | grep -a "failed to get flag information"`.
- **Observed (with values):** pod `civitai-dp-prod-primary-5b97fccdc6-22d4k`, image
  `20261113140757-226ce79`, last 10m → exactly **2** occurrences, all
  `default/download-scope-gate` (0 for any other flag). `grep -n download-scope-gate
  ~/workspace/civit/flipt-state/civitai-app/default/features.yaml` → **NO MATCH** (key
  absent). Present in app code: `src/server/flipt/client.ts:346
  DOWNLOAD_SCOPE_GATE = 'download-scope-gate'`; tests drive it as a **VARIANT**
  (`h.variants['download-scope-gate'] = 'enforce'`).
- **Ruled out:** it is not the flag this session worked on — `semantic-search-nonmod-clamp`
  had **0** errors on the same pod (`grep -a -c` → 0).
  via: command
- **Leading hypothesis:** a variant/string flag the app reads that was never created in
  flipt-state, so every evaluation 404s and the app falls back to its default. The civitai
  convention is to create the key (disabled) BEFORE deploying code that reads it, so a
  missing key is a mistake, not a design. Low rate (~2/10min/pod) ⇒ only read on a
  specific download path.
- **Next probe:** `gh search code "DOWNLOAD_SCOPE_GATE" --repo civitai/civitai` to find the
  call site and its fallback, then decide: create the key in flipt-state, or delete dead code.

## Next steps (ranked)
1. **Un-hold the clamp** when moderation clears it: set `semantic-search-nonmod-clamp`
   back to `enabled: false` in `civitai/flipt-state` (`civitai-app/default/features.yaml`) —
   i.e. revert #469. Repo `civitai/flipt-state`; touches `civitai-app/default/features.yaml`.
   forcing: none
2. **Triage `download-scope-gate`** (see Open investigations): confirm the call site and its
   fallback, then either create the key in `civitai/flipt-state` or remove the dead read.
   Repo `civitai/civitai` (+ `civitai/flipt-state` if the key is wanted).
   forcing: none

## Defects (batched)
- `download-scope-gate`: app code reads it, key absent from flipt-state → `failed to get
  flag information` on every evaluation. Same shape as the #8750/#468 pairing that THIS
  session got right (key created before the code deployed) — this one was not paired.

## Gotchas / decisions / dead-ends
- 🔴 **Read a Flipt v2 flag from the `resources` path, not `flags`:** `GET
  /api/v2/environments/civitai-app/namespaces/default/resources/flipt.core.Flag/<key>`
  returns 200; `/…/flags/<key>` 404s. Evaluate with `POST /evaluate/v1/boolean`
  `{environmentKey, namespaceKey, flagKey, entityId, context}`. (Measured this session,
  `flipt-v2`.) A stale note in the app-blocks skill claimed the mgmt path 404s for live
  flags — it does not, at the `resources` spelling.
- 🔴 **The clamp is fail-CLOSED in code.** #8750's `isNonModClampOn()` returns true (clamped)
  unless the key is present AND explicitly `enabled: false`. Missing key / eval error / no
  Flipt client all keep the clamp ON. So the ONLY way the clamp lifts is an explicit
  `enabled: false` — which is exactly what the flag was served as.
- `enabled` semantics: rollouts evaluate FIRST; `enabled` is only the default for users
  matching no rollout. This flag has no rollouts, so `enabled` IS the evaluated value.
- Flipt polls `civitai/flipt-state` main every **30 s** (`poll_interval: 30s`), so a merged
  flag change is served within ~30 s — no restart needed.
- Flux `ImagePolicy civitai-prod-release` selects the highest 14-digit TIMESTAMP, not the
  newest code, and ALSO deploys the trpc pool with no canary
  (`clusters/production/apps/civitai-dp-prod/imagepolicy-release.yaml`).
- 🔴 The Discord read must run on the **laptop** (`grab-discord-dm JustMaier --instance
  agent-ops`), NOT the workbench: the workbench's `agent-ops` Brave profile is not logged
  into Discord and redirects the owned tab to `/login`.
- ⚠ `~/workspace/civit/flipt-state` is on `main` **behind 760** with a STAGED
  `M civitai-app/default/features.yaml` that is **not** this session's — do not disturb it.
- ⚠ This session's cwd `~/workspace/civit/datapacket-talos` is the talos-infra primary
  clone: `trunk` behind 1087 with 119 modified skill files. Never commit there — use
  `scripts/wt`.

## How to verify
```bash
# 1. the flag is served ON and evaluates true for a non-mod
KUBECONFIG=$KC_DPPROD kubectl -n flipt port-forward svc/flipt-v2 18080:8080 &
curl -s localhost:18080/api/v2/environments/civitai-app/namespaces \
  | python3 -c 'import sys,json;print("served revision:",json.load(sys.stdin)["revision"])'
curl -s localhost:18080/api/v2/environments/civitai-app/namespaces/default/resources/flipt.core.Flag/semantic-search-nonmod-clamp \
  | python3 -c 'import sys,json;print("enabled:",json.load(sys.stdin)["resource"]["payload"]["enabled"])'
curl -s -X POST localhost:18080/evaluate/v1/boolean -H 'Content-Type: application/json' \
  -d '{"environmentKey":"civitai-app","namespaceKey":"default","flagKey":"semantic-search-nonmod-clamp","entityId":"probe","context":{}}'
#   expect {"enabled":true,...}  → clamp HELD
# 2. the live release carries #8750
KUBECONFIG=$KC_DPPROD kubectl -n civitai-dp-prod get deploy civitai-dp-prod-primary \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
#   expect ghcr.io/civitai/civitai-prod:20261113140757-226ce79  (== commit 226ce79 == v5.1.490)
```
