---
clawgate-task: 316
---

# Handoff: claudedocs-audit-arc — 2026-08-22

## Run this first — the index, one read-only command

```bash
python3 ~/workspace/devrc/scripts/lib/subsystem_recall.py --repo civitai
```

Terse pointers this doc does not carry, curated by past sessions and outliving it.
🔴 RECALL, NOT LIVE OBSERVATION — every line is a pointer to VERIFY, never a current
reading, and it may describe a gotcha already fixed. `scope-absent`/`scope-empty` means
nothing is recorded yet: ordinary, not an error, and not a clean bill of health.
Non-blocking: if it exits non-zero, print the stderr line and carry on.

## Goal

Evaluate one `claudedocs/` audit document, then act on what it found. It was wrong in **6 of 11
statuses, all in one direction** — it read each doc's *self-reported* status instead of re-checking
the repo. Correcting that produced a convention, a doc sweep, and four code PRs.

## State now

- **Branch:** `main`, clean. Local clone is `[behind 7]` — fast-forward before doing anything.
- **Nine PRs merged, each content-verified on `main` (never by ancestry — a squash makes the branch
  permanently not an ancestor):**

  | PR | Squash | What |
  |---|---|---|
  | devrc #695 | `454550add0` | narrowed the `*age*-d*` opencode permission glob |
  | #4280 | `377d781f88` | `claudedocs/README.md` status-line convention + 11-doc sweep |
  | #4281 | `286b16d73b` | `TEST_ENV_DEFAULTS` derived from the env schema |
  | #4282 | `f1859d1a96` | services n–z, first 6 files |
  | #4291 | `7df9037eed` | restored the audit doc that was written, reported done, and lost |
  | #4293 | `b7c76e7504` | canonical redis + logging mocks, allowlist 211→209 |
  | #4294 | `085f816d52` | PageBlockHost virtual clock — last live flake members |
  | #4299 | `0aee832699` | five claudedocs corrections, incl. one #4280 introduced |
  | #4303 | `9429d33f77` | whole n–z slice, 31 files, allowlist 209→178 |

- **Allowlist on `main`:** `canonicalFiles: 178`, services slice **3** (all a–m), **n–z: 0**.
- **Cards written back:** 314, 315, 316, 317, 319 `ready_for_review`; corrections commented on 257
  and 264. All worktrees and branches cleaned up, local and remote.
- **devrc #695 is LIVE** — `home-manager switch` run and verified against the real engine
  (`opencode debug agent`, v1.18.18), not just the config file.

## Open investigations — live diagnosis state

### 318 — the quiet-box check is blind to everything that isn't vitest

- **Symptom + exact repro:** the drift pair cannot be taken, and the doc's prescribed quiet-check
  says the box *is* quiet while it isn't. Repro: run the check from
  `test-perf-measurement-envelope-2026-08-15.md` — count processes matching `vitest|tinypool`.
- **Observed (with values):** on 2026-08-22 22:57Z that probe returned **0 vitest/tinypool
  processes** while `ps -eo pcpu=` showed **five python3 pytest/unittest at ~100% CPU** (elapsed
  00:00–00:23, i.e. actively starting) plus `Farthest Frontier.exe` at 91% running 1d16h.
  `loadavg` = **16.82 / 11.23 / 9.83 on 24 cores — rising**.
- **Ruled out:** "the box is quiet" (load rising, five competing runners). Also ruled out that this
  is a vitest-only concern — the competitors were pytest, which the probe cannot see by
  construction.
- **Leading hypothesis:** the check is a *vitest* check, not a *quiet* check. Any measurement taken
  through it inherits the contamination it was written to prevent — and would be published as
  "the denominator every perf comparison in the repo is measured against".
- **Next probe:** replace the check before taking the measurement:
  ```bash
  cut -d' ' -f1-3 /proc/loadavg; nproc; ps -eo pcpu=,etime=,args= --sort=-pcpu | head -8
  ```
  Take the pair only when 1-min load is well under `nproc` and no test runner of any language is in
  the top consumers. Capture loadavg alongside each arm so a reader can judge conditions rather
  than trust the word "quiet".

### `typecheck-tests-gate` is merged, unwired, AND failing

- **Symptom + exact repro:** `scripts/ci/typecheck-tests-gate.mjs` exists on `main`, has its own
  unit tests, and runs nowhere.
- **Observed (with values):** `package.json` has only `"typecheck": "node scripts/typecheck.mjs"`
  (the *base* config). No `.github/workflows` reference. An independent grep of the private
  `talos-infra` repo found no Tekton pipeline invoking it either. Running it:
  **922 errors / 169 files against a baseline of 784 / 140.** `scripts/ci/typecheck-scripts-gate.mjs`
  (#4189) is *also* uninvoked.
- **Ruled out:** that #4189 "extended it to `scripts/`" in the sense of wiring — it added
  `scripts/**/*.ts` to the root tsconfig `include` (that half *is* live) and shipped a second
  unwired gate.
- **Leading hypothesis:** wiring it will fail immediately on ~140 files of pre-existing drift, which
  is probably why nobody did.
- **Next probe:** decide whether to wire-and-baseline (regenerate the baseline at current HEAD so
  the ratchet starts from truth) or wire-and-burn-down. Card #257 tracks it.

### Cards 309/310 — the component tier works, but runs where it catches nothing

- **Symptom + exact repro:** a copy change reached `main` unnoticed. #4289 changed
  `StickerPlacementTray.tsx` copy without updating its test; its PR had **no `component-tests`
  check at all**, only `Unit tests`. The next PR that ran that tier (#4291, docs-only) went red.
- **Observed (with values):** `component-tests` has **no status on any `main` commit** — it runs
  only on PR previews. The tier itself is healthy: `32 passed (32)` locally via
  `playwright-nixos`. #4292 later fixed the assertions.
- **Ruled out:** "the tier has no working environment anywhere" — it runs fine here and was green
  on #4280/#4281/#4282.
- **Leading hypothesis:** a wiring/coverage problem, not a capability one. It doesn't gate `main`,
  and it doesn't reliably attach to the PRs that need it.
- **Next probe:** determine why #4289 got no `component-tests` status while sibling PRs did —
  that difference is the whole bug.

### Workbench node: residual pod damage after the k3s restart

- **Symptom + exact repro:** node `nixos` hit `DiskPressure=True` at 21:34:31Z and evicted
  clawgate; the kubelet then held the condition for **85 minutes** with **651 GB free and 84 M
  inodes free**, past its 5-minute transition period, still logging
  `"unable to evict any pods from the node"` 4 minutes before intervention.
- **Observed (with values):** pre-restart census **9 Running / 38 Pending / 22 Error**. After
  `sudo systemctl restart k3s` (MainPID `19079 → 3479968`): `DiskPressure=False`, **45 Running / 0
  Pending**, clawgate `1/1`, health v0.7.98. Residual: **24 Error, 5 ContainerStatusUnknown**.
- **Ruled out:** an actual disk or inode shortage (both measured ample); hysteresis (85 min ≫ 5).
- **Leading hypothesis:** stale kubelet stats. Cleared by the restart.
- **Next probe:** the 24 Error / 5 ContainerStatusUnknown are mostly evicted corpses needing
  reaping, but check for live `ErrImagePull`/`CrashLoopBackOff` that predate the eviction:
  ```bash
  kubectl --kubeconfig /home/zach/workspace/homelab-talos/workbench-kubeconfig get pods -A \
    --field-selector=status.phase!=Running,status.phase!=Succeeded
  ```

## Next steps (ranked)

1. **`*rm*-r*` in `devrc/scripts/opencode/opencode.jsonc`** — identical defect to the merged #695,
   still live in the running engine. Measured against it: `git log --format=oneline --reverse`
   resolves `ask` → auto-reject. One character, test pattern already exists
   (`test_rm_glob_misses_these_recursive_spellings`). ⚠ That rule also has a genuine *under*-match
   gap in the opposite direction, documented in that same test — don't disturb it.
2. **Wire `typecheck-tests-gate`** (card #257) — decide baseline-at-HEAD vs burn-down first.
3. **Card 309/310 wiring** — find why #4289 got no `component-tests` status.
4. **318**, once the box is genuinely quiet *and* the check is fixed (see above).
5. **315's RSS measurement** — needs the real build environment; this box cannot settle it
   (local peak pinned by `--max_old_space_size` at ~5.6–5.7 GB for every config).
6. **The `--no-isolate` flip gate** — the reason the whole mock migration exists, and still
   completely unmeasured.

## Gotchas / decisions / dead-ends

- 🔴 **`pnpm typecheck` CANNOT see any file under `src/**/__tests__/`** — the root `tsconfig.json`
  excludes it. A planted `const x: number = "s"` still yields `0 type errors`. Measured twice
  independently. Use `node scripts/typecheck.mjs -p tsconfig.tests.json`. **I cited the blind one
  as evidence on #4293 before learning this; that check was vacuous.**
- 🔴 **Browser-mode tests need the version selector.** A bare `npx vitest --project component`
  cannot launch a browser and reports `Tests no tests` / exit 1 — reads exactly like a broken
  suite. Use
  `direnv exec . /home/zach/workspace/devrc/scripts/playwright-nixos npx vitest run --project component <file>`.
  `devrc/flake.nix` pins a second frozen nixpkgs at `playwright-driver` 1.57.0 for this repo's
  chromium-1200. **I wrongly declared 314 blocked by `ls`-ing the nix store for a bundle that
  materialises on demand — I searched for the artifact instead of asking the mechanism.**
- 🔴 **A fresh civitai worktree needs `.envrc` (gitignored) AND `git submodule update --init
  event-engine-common`.** Missing either produces a block of false reds that reads as real
  breakage — this is what card 264 actually is.
- 🔴 **Three canonical mock specifiers, OR'd together** — `db`, `redis`, `logging`. Converting one
  leaves a file on the allowlist. My brief said redis was the last blocker; it wasn't, and #4293
  had to be redone.
- 🔴 **The allowlist's *pending* half has no growth guard** — only the canonical half refuses
  growth, so pending drifts per-PR unnoticed (455→456 during this session alone).
- 🔴 **`Agent(isolation:"worktree")` builds from the CWD's repo**, not the one the task names. For
  cross-repo work, have the agent run `git -C <repo> worktree add` itself.
- **Dead end — opencode dispatch:** 5 of 6 runs died on permission globs, none on the work. Two
  `*age*-d*`, two `*git*checkout*` (agents cannot undo their own mistakes), one `external_directory`.
  Switched to Claude subagents, which can commit and self-recover. This is why `*rm*-r*` is now
  low priority — it only gates opencode.
- **Decision — nothing in `claudedocs/` was archived.** The premise that these cost tokens per
  session is false (not auto-loaded, no `@` import), and **four of the eleven are cited from
  outside themselves**, including live source (`PageBlockHost.tsx:3234`, `next.config.mjs:294`,
  `CLAUDE.md:248`).
- **Scrub audit: clean.** No sensitive content in any of the 12 docs; all three keyword pre-scan
  hits were false positives (`civitai-dp-prod` already appears in 33 non-claudedocs files
  including shipped source).

## How to verify

```bash
# the merges landed, by CONTENT (ancestry is always false after a squash)
git -C /home/zach/workspace/civit/civitai fetch origin main
git -C /home/zach/workspace/civit/civitai show origin/main:src/__tests__/mocks/direct-mock-allowlist.json \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['totals'])"        # canonicalFiles: 178

# the n-z slice is empty
git -C /home/zach/workspace/civit/civitai show origin/main:src/__tests__/mocks/direct-mock-allowlist.json \
  | python3 -c "
import json,sys,os;d=json.load(sys.stdin)
sl=[x for x in d['files'] if x.startswith('src/server/services/__tests__/') and x.count('/')==4]
print('slice',len(sl),'n-z',len([x for x in sl if os.path.basename(x)[0].lower()>'m']))"   # slice 3 n-z 0

# the devrc glob fix is LIVE in the real engine, not just the file
opencode debug agent build | grep -a '"\*age'        # "*age -d*" / "*age --decrypt*", no infix form
```
