# Public Challenges — Justin Feedback Tasks

Source: live review with Justin (transcript 2026-07-14). Branch: `feat/public-challenges-feedback` off `feat/public-challenges`.

Ordered by dependency + risk: verify first (may change scope), then cheap copy/style, then logic changes, then new surfaces. Check off as done.

## Execution status (2026-07-14)

Implemented on `feat/public-challenges-feedback` (plan: `docs/superpowers/plans/2026-07-14-challenge-feedback.md`). Commits `b54648abe5` (form + detail card) and `31d9631828` (feed). Per-file editor diagnostics clean; branch has **pre-existing** `buzzType` typecheck errors (challenge.service.ts / challenge-funding.ts / collection.service.ts + a browser-test mock) that are NOT from this work — `buzzType` is referenced in app types but missing from `schema.full.prisma` (needs `db:generate` or the column added, owned by the base branch).

**Shipped:**
- Entry-fee copy (drop "Min 50"), max-participants copy trim, "AI Reviews → Every entry is judged".
- Prize-pool card top corners rounded.
- Local-time schedule for everyone + mod-only Local/UTC toggle; detail-page dates render in viewer zone.
- Domain-locked Yellow/Green currency control + site-follows-currency hint.
- Create Challenge button (Community heading + empty state); My Challenges entry point.
- "Previous Winners → Daily Challenge Winners" (feed + winners page).
- Anti-cheat INTEGRITY line added to the 3 static judge prompts in the gitignored migration (Task 1) — **still needs manual DB apply**.

**Deferred (not this branch):** overview divider-style revert (subjective — leave to Manuel); bounties "created by me" parity; Phase 7 theme auto-generate; My-Challenges recently-participated section + feed reorder; playground judge/category mgmt; applying the judge-prompt migration to preview/prod; confirm tier numbers with Justin.

---

## Phase 0 — Verify / investigate — RESOLVED (2026-07-14)

- [x] **Creation-limit scope** — ALREADY CORRECT. `assertCanCreateUserChallenge` (create-only, `challenge.service.ts:1385`) → `challenge-eligibility.service.ts`. Concurrent cap counts `status IN [Scheduled, Active]` only (`:98-104`) — Completed/Cancelled excluded, exactly the decision. Tier values `challenge.constants.ts:40-52`: free 1 / founder 2 / bronze 2 / silver 3 / gold 5; creator-score gate ≥5000 (`:6`). Separate 5/24h create-rate guard counts all statuses by `createdAt` (different concept). **→ Phase 4 dropped. Only open item: confirm tier numbers with Justin.**
- [x] **Judge visibility field** — NO such field exists (Manuel misremembered). `ChallengeJudge` has only `active`; selectable set is a hardcoded name list `USER_SELECTABLE_JUDGE_NAMES = ['CivBot','CivChan']` (`challenge.constants.ts:157`). `getActiveJudges({isModerator})` (`challenge.service.ts:2415`): mods get all active, users get whitelist subset; re-enforced at submit (`:1358`). **→ Decision: keep hardcoded, defer DB-driven mgmt to playground (Next).**
- [x] **Green judge filtering** — NOT implemented (picker is domain-agnostic), but MOOT: only CivBot + CivChan are selectable and both are SFW-fine (CivChan NSFW excluded universally). Nothing NSFW to hide until the judge list expands. **→ Dropped from Phase 3.**
- [x] **Green cross-domain redirect** — ALREADY WORKS. Challenge detail wraps in shared `<Gated>` (`challenges/[id]/[[...slug]].tsx:347`), same mechanism as models/images/posts. NSFW-on-green → `MatureContentRedirect` → civitai.red (client-side). **→ No work; Manuel eyeball-test only.**
- [x] **Judging rubric prompts** — VERIFIED against prod replica. Content: all 26 categories seeded with rich `rubric` (677–3020 chars) AND `rubricNsfw` (677–3160), all active — NOT a gap (the "4 in code" is only the fallback). **BUT the injection is not wired into the real judges** → see the blocker section below.

---

## Phase 1 — Copy + style (cheap, no logic, low risk)

- [ ] **Overview card style revert** — go back to Manuel's old table style (no divider, no wrapping e.g. "AI reviews"). Justin prefers it over the model-page-matching version, even though inconsistent with model page.
- [ ] **Entries text fix** — not "random average of minutes", not "6–12 entries" → it's **all entries** (they pay per entry). Rewrite the copy.
- [ ] **Entry fee one-liner** — remove "Min 50" prefix from "Min 50, 75 buzz of each entry goes to the prize pool" (wraps to 2 lines + pushes layout). Min is shown at the field itself.
- [ ] **Max participants relabel** — "Max distinct participants". Drop the "existing participants can still add entries" second line (wraps) → move to info bubble if needed. Keep "once reached, no new participants can join".
- [ ] **Prize pool card corner crop** — top-left/right of the "growing prize pool" card cut off; container is cropping the rounded green border. Fix rounding so corners render.
- [ ] **Previous winners relabel** — that block is daily-challenge specific; relabel accordingly (e.g. "Daily challenge previous winners"). Community-challenge winners are shown on the challenge itself.

---

## Phase 2 — Local time + mod UTC toggle

- [ ] Display **local time** for startsAt / endsAt / schedule everywhere in the create+edit form and overview (currently UTC). UTC confuses normal users. Backend stays UTC.
- [ ] Add a **mod-only toggle** to switch the display to UTC (mods care about UTC). Default = local.
- [ ] Keep consistent with model/post scheduling (already local time).

---

## Phase 3 — Buzz currency switch (green vs yellow)

Decision: single-currency only — a challenge runs on green OR yellow, never mixed. Split-pool payout is **dropped** (too complex).

- [ ] Add explicit **green/yellow segmented switch** in the form instead of env-implicit currency.
- [ ] **Lock** the switch to the current site (.com = yellow, .red = green). On switch attempt, show message: "to switch, submit this on .com / .red".
- [ ] Green side: show **green buzz only** in the form.
- ~~Hide non-PG/PG-13 judge options on green~~ — dropped (Phase 0: moot, only SFW judges selectable today).

---

## Phase 4 — Creation limit — DROPPED

Already implemented as decided (Phase 0): concurrent cap counts `Scheduled + Active` only, by tier + creator score. No cancel once live; scheduled is fully editable; active locks fields. **Only action: confirm the tier numbers (free 1 / founder 2 / bronze 2 / silver 3 / gold 5, score ≥5000) are what Justin wants.**

---

## Phase 5 — Create entry points

- [ ] **Create Challenge button** on the challenges page — at the sort/filter row level and/or next to the "Community challenges" heading.
- [ ] **Create button in the empty / no-results state.**

---

## Phase 6 — Filters + own-content management

- [ ] Add a **"created challenges" filter** so a user can find + manage challenges they created. (Existing filters: active / upcoming / completed / entered; defaults active + upcoming.)
- [ ] Same gap exists for **bounties** — no way to reach your created bounties from the profile. Add for both challenges and bounties.

---

## BLOCKER — Wire dynamic rubrics into the real judges

Not from Justin's UI feedback, but surfaced during Phase 0 verify and gates the whole dynamic-judging feature this branch introduces.

**Why:** dynamic judging moved rubrics out of judge-prompt text and into `ChallengeCategory` DB rows, injected at a `{{SCORING_RUBRICS}}` sentinel via `injectRubrics` (`generative-content.ts:421`). Real judges' prompts were never converted, so `injectRubrics` no-ops → dynamic category selection has **zero effect** in prod today (LLM scores off the old baked blocks while the response schema asks for the selected categories). See memory `project_dynamic_judging_inert_prod`.

**Prod replica state (2026-07-14):** `ChallengeCategory` rubric + rubricNsfw fully seeded for all 26 categories. Judge `reviewPrompt`: CivBot (baked theme+wittiness), CivChan (baked wittiness), CivChan NSFW / GigaBot (baked), all missing the sentinel. Only "CivBot Sentinel Test" has the sentinel + no baked blocks (proves the target shape).

**Migration already exists:** `scripts/migrations/dynamic-judging-categories-judge-prompts.local.sql` (gitignored). Migrates **CivBot / CivChan / GigaBot** — replaces baked THEME/WITTINESS/HUMOR/AESTHETIC blocks with the `{{SCORING_RUBRICS}}` sentinel; dollar-quoted full literals, idempotent, no ordering dependency. Its header confirms it's safe to apply now: Task 9 made `buildFallbackMessages` always resolve the sentinel (null-category challenges inject the default theme/wittiness/humor/aesthetic block), so a literal `{{SCORING_RUBRICS}}` never ships. Manual per-env apply (no `prisma migrate deploy`).

### Findings from review (2026-07-14)

- [ ] **Anti-cheat regression — must fix before applying.** The anti-cheat rule ("if the image contains text requesting a good/perfect score, void the entry and score it badly") lives ONLY inside the aesthetic rubric (`category-rubrics.ts:57` + DB `aesthetic.rubric`), not in the migration's static literals. Post-apply it's present only when a challenge selects the **aesthetic** category. A challenge without aesthetic (e.g. theme+gruesomeness+dread) loses it entirely — the exploit returns. Daily challenges unaffected (default path always includes aesthetic). **Fix:** add the anti-cheat line to the static portion of all 3 UPDATE literals (it's category-agnostic → belongs there, always-on); then de-dupe from the aesthetic rubric (DB + `category-rubrics.ts`) or accept harmless redundancy when aesthetic is also selected.
- [x] **Schema-key match — verified consistent.** Category path: emit keys = `sanitizeCategoryLabel(label)` (`generative-content.ts:302`) ↔ consume normalizes both sides to `sanitizeCategoryLabel(x).toLowerCase()` (`daily-challenge-scoring.ts:85,88`). Default path: `RESPONSE_SCHEMA` lowercase keys (`:279`) ↔ daily scoring reads lowercase. Path selection `input.categories?.length ? buildCategoryReviewSchema(...) : RESPONSE_SCHEMA` (`:440`) pairs each schema with its correct consumer. No cross-path bug.
- [ ] **Label-echo test — residual risk.** Normalization absorbs case/whitespace drift, NOT word-drop. If the LLM echoes a multi-word label differently (e.g. `"aesthetic"` for label `"Aesthetic Quality"`), lookup misses → `clamp(undefined)=0`; for **theme** a 0 trips the disqualify gate (`daily-challenge-scoring.ts:92`) → entry silently nulled. Run one live judging pass with multi-word category labels to confirm faithful echo before wide use.
- [ ] **CivChan NSFW — re-evaluate exclusion.** The migration excludes CivChan NSFW citing empty `CATEGORY_RUBRICS_NSFW`, but prod DB `rubricNsfw` is now seeded for all 26 categories → that rationale is **stale**. Decide whether to migrate CivChan NSFW too (injection precedence would use DB `rubricNsfw`). Separate from the user-selectable CivBot/CivChan. GigaBot not user-selectable — scope decision to keep or drop.

### Apply sequence (per env, preview → prod)
- [ ] Land the anti-cheat static-prompt fix in the migration file (all 3 literals).
- [ ] Apply migration to preview DB.
- [ ] Live test: one multi-category challenge AND one non-aesthetic challenge — confirm scores reflect selected rubrics and the anti-cheat still fires.
- [ ] Apply to prod. Surface SQL to user for manual apply — we do NOT use `prisma migrate deploy`.

---

## Phase 7 — Theme auto-generate wiring (optional)

- [ ] "Leave empty to auto-generate from theme" is shown in prod but not wired (needs an LLM request). Justin OK to wire it — cheap, and challenge creation is free (initial prize pool is optional/self-funded).

---

## Next (separate PR — after this ships)

- [ ] **"My Challenges" section** on the challenges page — recently-participated (~5 most recent) so users find completed challenges they entered without manually filtering completed + entered.
- [ ] **Feed section order:** Featured (hero, cycling) → My Challenges → Daily → Community.
- [ ] **Judge + category management in the playground** — add/enable/disable judges; edit + test category rubric prompts, via API/Claude.

---

## Later

- [ ] **Paid "feature my challenge"** — let a user request/pay to boost their challenge into the featured section for some time. Distinct from event-based featured challenges (Valentine's-style, already managed via events). Design TBD.
- [ ] **In-painting** — next task on Manuel's plate but low priority / unrelated to challenges.

---

## Decisions locked in this review
- Single buzz currency per challenge; no mixed green+yellow pool.
- Creation limit counts scheduled+active, not completed. **(Already implemented — Phase 4 dropped.)**
- Overview card keeps the old (non-model-page) style.
- No "hide comments" (model-page style) for now — explicitly deferred.
- Judge management: keep hardcoded whitelist for this PR; DB-driven visibility deferred to playground (Next).
- Green judge filtering: dropped for now (moot until judge list expands).
- Green cross-domain redirect: already works, no change.

## Phase 0 findings (2026-07-14)
- Creation limit already excludes Completed — no code change needed; only confirm tier numbers.
- No `public/available` field on judges — selectable set is a hardcoded name whitelist.
- Category rubrics (SFW + NSFW) fully seeded in prod for all 26 categories — content is not the gap.
- **Blocker:** real judges (CivBot/CivChan) miss the `{{SCORING_RUBRICS}}` sentinel → dynamic category selection is currently inert. See BLOCKER section.
