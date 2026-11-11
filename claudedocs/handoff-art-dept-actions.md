# Handoff: Art Department meeting action items — 2026-11-11

## Run this first — the index, one command
```bash
$DEVRC/scripts/cairn-ops/read.sh recall --repo "/home/zach/workspace/civit/civitai"
```
Terse pointers this doc does not carry, curated by past sessions and outliving it.
🔴 RECALL, NOT LIVE OBSERVATION — every line is a pointer to VERIFY, never a current
reading, and it may describe a gotcha already fixed. `scope-absent`/`scope-empty` means
nothing is recorded yet: ordinary, not an error, and not a clean bill of health.
Non-blocking: if it exits non-zero, print the stderr line and carry on.

## Goal
Turn the 8 transcribed Art Department meetings of 2026-11-11 into a triaged action list:
identify Zacx's items, reconcile them against Muster sessions/tasks, file the six he named
as HQ tasks, and dispatch the research/scoping he asked for.
- **closing-condition:** `judgement` — Zacx reads the six HQ tasks (`fix_devrc_nodetests_qz9a`,
  `b2_confirm_encryption_891d`, `spine_workers_detect_6tam`, `muster_mcp_scope_vk1t`,
  `scope_training_studio_ny68`, `investigate_why_no_e5r7`) and the 12-row table, and confirms
  every one of the 12 items is filed, in flight, or explicitly dropped.

## State now
- Branch / PR: **devrc PR #2861** (draft) https://github.com/innovation-upstream/devrc/pull/2861 — branch `fix/probe-iso-coalescing`, commit `de124cfa`, 2 files +133/−14 (`extension/probe_iso.js`, `tests/probe_iso.test.mjs`); worktree left at `~/workspace/devrc-probe-iso`. Doc branch: civitai `handoff/art-dept-actions`.
- **Done this session:**
  - Read 9 recordings (`hq rec ls --since 2026-11-11`), 8 transcribed; extracted 103 action items, 12 of them Zacx's.
  - Reconcile source: 23 sessions had focus activity today, 488 open/in-progress Muster tasks, 4 tasks created today (1138–1141).
  - 6 HQ tasks filed and assigned to Zacx (`cu-81593871`); `b2_confirm_encryption_891d` due 2026-11-12.
  - 3 research/scoping memos delivered and commented onto their tasks: B2 re-encrypt cost, MCP `task watch`, Training Studio preview.
  - 1 dispatch cancelled at the operator's request (`spine_workers_detect_6tam`, passed to another agent) — its memo was produced anyway and deliberately NOT posted.
- **In flight:** devrc PR #2861 (draft) — code committed and pushed, **evidence half-done**: one scoped run after the restart passed 10/10, but the 20×-under-load battery and the mutation check were never captured because the sub-agent was killed mid-run.
- **Deploy/verify status:** nothing deployed. Every memo is read-only research; no cluster, bucket or flag was changed. The B2 plan's delete step was NOT executed. PR #2861 is NOT verified as fixing the flake — only as green once.
- **Not verified:** whether Muster tasks 1124 and 1131 are actually being worked — both are *linked* to live sessions whose focus titles are about something else. And whether PR #2861's assertion still dies when coalescing is broken (the mutation check never ran).

## Next steps (ranked)
1. Review + merge devrc PR #2861. Before merging, run the missing evidence: 20 consecutive scoped runs while a CPU hog runs (the flake was ~1 in 2 under load), then break the coalescing logic and confirm the test goes RED, then restore. IN FLIGHT: devrc#2861 (draft).
   forcing: gate
2. B2 triage with Justin on 2026-11-12: present the measured numbers (~$0 API, <$25 overlap, media 8–25 d is the long pole, blobs tail 12–40 min) and get the go/no-go.
   forcing: deadline
3. Before any B2 bulk delete: full-read checksum on a random ≥100-file sample of >5 GB objects (`contentSha1: none` above 5 GB).
   forcing: security
4. Do the app-submission check that was due today, or fold it into Muster 1131 (app review, ready_for_review).
   forcing: user
5. Nudge session `a9b316a7-943a-4c28-8370-…` to actually send Koen the spine-controller rootless findings (Muster 1124 is claimed, not observed in progress); the older duplicate 832 can then be closed.
   forcing: none
6. Decide on the `task watch` slice: MCP/gateway verb for the worker's own task, 2 files + migration 0113. The migration is required (provenance bug, see Defects).
   forcing: none
7. Close or act on `scope_training_studio_ny68`: access is already open, so the real question is whether Kohya-in-Studio (2–4 eng days) is wanted at all.
   forcing: none
8. File or drop the still-boardless items #5 (encrypted bucket for Koen — likely fold into the B2 answer), #8 (breakout open-questions → agent mail), #10 (DeepSeek officer monitoring).
   forcing: none

## Defects (batched)
- `AnswersForTask` (`internal/attention/attention.go:751`) does not filter by asker, so once a worker's `task_id` is on an ask, the owner's answer to the worker's question counts as the owner's own words for `agent_dispatch` (`task_routing.go:581`). Blocks the task-watch slice until migration 0113.
- B2 `contentSha1` is `"none"` for objects >5 GB (p99 6.9 GB, tens of thousands of objects) while the plan deletes the only other copy — verification is sampled ranges only.
- `b2_sse_pilot.py` (sha f779697f) is NOT on this host; no copy under `~/workspace/homelab-talos`. Re-derive or find it before the pilot.
- `~/workspace/civit/flipt-state` is 400+ commits behind `origin/main` and holds a 197-line STAGED diff nobody claimed. Uncatalogued work at risk — check before touching that tree.

## Gotchas / decisions / dead-ends
- **HQ CLI null-concat trap:** concatenating a NULL column makes the whole row NULL, which psql prints as a BLANK line. A "tasks created today" query appeared to return 1 row and actually returned 4. Count rows, never eyeball them.
- **No Muster dispatch token here:** `MUSTER_AGENT_CREATE_TOKEN` is unset, so `muster agent create --start=true` cannot dispatch. "Dispatch" in this session means subagents, not Muster agents.
- **`worked` in `task_sessions` is a claim, not activity.** Tasks 1124 and 1131 are linked to live sessions whose focus is elsewhere — treat as "claimed by a live session", and verify before believing progress.
- **Training Studio access is already open:** Flipt `trainingStudio` evaluates `enabled: true` / `DEFAULT_EVALUATION_REASON` for non-testers. Do NOT add anyone to the `testers` segment — it backs 78 flag rollouts, App Blocks store/pages included.
- **"Koya" = `kohya-training`, and Training Studio is AI-Toolkit only** (`train-core.ts` hardcodes `engine: 'ai-toolkit'`). The flag only un-hides Kohya in the old in-app trainer.
- **B2 A/B/C API classes are free;** only class D (notifications) bills. The migration is ~$0 in API calls — the original card's "tens of dollars" is wrong.
- **Shell-tripwire memo was discarded by the operator's choice.** Its content (controller-side `/proc` scan → node_exporter textfile; alert-first, never auto-kill) is not on the HQ task on purpose.
- **A harness restart cancels a running sub-agent but NOT its side effects.** The devrc sub-agent was killed mid-run; the branch, commit and draft PR #2861 survived it, and only the evidence report was lost. Check the repo, not the sub-agent's last message.
- **Meeting 5326 (13:05, 3 participants) has no transcript** — that recording is unanalysed.

## How to verify
```bash
for t in fix_devrc_nodetests_qz9a b2_confirm_encryption_891d spine_workers_detect_6tam \
         muster_mcp_scope_vk1t scope_training_studio_ny68 investigate_why_no_e5r7; do
  hq task show "$t" | head -3
done
muster task get 1124 | head -20   # spine rootless — in flight
muster task get 1131 | head -20   # app review — ready_for_review
```
Expected: six HQ tasks assigned to `cu-81593871`, `b2_confirm_encryption_891d` due 2026-11-12, and four task comments (one per research/scoping result).
