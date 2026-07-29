# Paid access & licensing — follow-ups checklist

Actionable punch-list from the Justin/Ellie review call (transcript, timestamps below), Briant's notes, and the
engineering open items surfaced while building this. See [paid-access-current-state.md](paid-access-current-state.md)
for where the code lives.

## Creator Studio — per-version drawer
- [x] **Drawer needs a scroll bar on small windows** — the licensing/paid-access sidebar content overflows; make it scroll. _(Briant note)_
- [x] **"Save" button label follows the mode** — say **"Save paid access"** when Permanent is selected, "Save early access" when Timed. (Per Briant's note; Justin on the call floated unifying both to "Save access fee" — going with the mode-specific label.) _(Briant note; Justin ~3:00)_
- [x] **Don't show a 0 / expired fee** — a version renders "0 / 10" for the licensing fee; show nothing (Off) when the fee is 0. (Root cause per Justin ~11:37: the version met its donation goal and left early access, so the fee is gone — confirm the fix is "hide when 0", and that an exited/expired gate shows no fee.) _(Justin ~10:23, ~11:37)_

## Creator Studio — bulk paid access
- [x] **Buzz icon prefix on the price inputs** (access + gen-only) so they read as Buzz amounts, not counts — Ellie read "100" as "100 people/generations". _(Briant note; Justin/Ellie ~4:09)_
- [x] **Clearer input labels** — "Access fee" / "Gen-only fee" instead of "Access" / "Gen-only". _(Justin ~4:47)_

## Models list — at-a-glance pricing

- [ ] **Desktop: render the models/versions list as a table** with columns (version, status, licensing fee, access + Buzz price) so creators see all prices at a glance without opening panels. **Keep the current card layout on mobile.** _(Briant; Justin ~9:54, ~13:42)_
- [x] **Mobile refinements** — the early/paid-access badge now folds in the Buzz access price (`accessBadge()` → "Permanent · 500 ⚡" / "Early access · 500 ⚡"), and on mobile the version row stacks: the status badge right-aligns onto the title line, freeing a second line for the price + fee chips. Desktop stays a single row. _(Justin ~9:54, ~10:42)_

## Creator Program join (Creator Studio /join)
- [x] **Let qualifying members join the Creator Program from the studio** — if the user has a Civitai membership + score but hasn't joined the program, surface a "Join" flow on the studio /join page, mirroring the main-app Buzz-dashboard "Join now". _(Briant note; Justin ~14:32, ~15:34)_

## Main app
- [x] **Add a Creator Studio link to the main-app user navigation.** _(Briant note)_
- [x] **Licensing fee = whole-number "Buzz per N generations" ratio** (not a fractional per-image decimal), consistent with the studio. _(Justin ~0:51 — done this session)_

## Verify / product
- [ ] **Test purchasing permanent paid access end-to-end** (early-access purchase is live/working; permanent not yet exercised). _(Justin ~6:15)_
- [ ] **Donation goal can't be turned off after it starts** (create-once) — confirm intended, or add a way to disable it. _(Justin ~12:30)_
- [x] **"Cannot delete a model" that has paid access** (Ellie) — confirmed **intended** (buyer protection). The guard keys on **actual purchases**, not on merely having a gate: a version's `meta.hadEarlyAccessPurchase` (set on any purchase via `earlyAccessPurchase`, timed **or** permanent — it doesn't branch on `timeframeDays`). Non-mods are blocked from `deleteModelById`, `unpublishModelById`, `deleteVersionById`, and version merge ("…has had early access purchases…"); **moderators bypass**. A gate with zero purchases is still deletable. _(Ellie ~12:40)_
- [x] **Early-access day cap should read the model owner's creator score, not the acting/viewing user's** — Justin saw a 30-day cap as a mod vs. the owner's real 9-day cap. _Verified already satisfied by construction:_ `model-version.router.ts` `isOwnerOrModerator` (line 86) rejects any non-moderator who isn't the model owner, and moderators are exempt from the EA caps in both the form (`isModerator` branches) and the server (`assertUserEarlyAccessLimits` early-return). So whenever the caps apply, the acting user **is** the owner → `ctx.user.meta.scores.models` is the owner's score. Mods see all tiers unlocked (not the owner's caps), which was the demo confusion. No code change needed. _(Justin ~13:00)_
- [ ] **Update Justin's article to the final tier caps: Bronze 10 / Silver 25 / Gold unlimited** (settled after the call — Justin quoted the older 3/10 on the call). _(Justin ~16:47)_

## Open engineering items (from this session's reviews)
- [x] **Scheduled early access never materializes `endsAt`** → a scheduled timed gate could become a permanent gate that never releases. _Verified already fixed:_ `publishModelVersionById` routes a published gate through `publishModelVersionsWithEarlyAccess` (materializes), a scheduled one writes `publishedAt` (line 1299-1304); at publish time the scheduled-publishing job calls `publishModelVersionsWithEarlyAccess` whose else-branch (`model-version.service.ts` line 1135-1141) materializes `endsAt` from `currentVersion.publishedAt`. No code change needed.
- [x] **`mini/[id].ts` free-trial-limit SQL uses the wrong predicate** → NULL trial limit for the common (no cheaper-tier) case. _Verified already fixed:_ both `freeTrialLimit` (line 151-152) and `checkPermission` (line 137) now gate on `terms->'generation' IS NOT NULL AND COALESCE(...->>'free','') <> 'true'`, mirroring `paidGenerationGrant()`. No code change needed.
- [x] **Free-preview "clear" semantics differ across apps** — spoke empty → 0, main app cleared → default 10; pick one and align.
- [ ] **CSV export/import: add paid/early-access columns** (export-first recommended; donation-goal column read-only).
- [ ] **Runtime smoke-test the extracted Svelte components** (drawer state re-seed on reopen; shared `selected` reactivity across the bulk bars) — type-check can't catch reactivity regressions.
- [x] **Decide + commit `+layout.server.ts` dev-gate removal** — currently uncommitted; it opens the Creator Studio to all authenticated users (removes the moderator/testing-id gate).
