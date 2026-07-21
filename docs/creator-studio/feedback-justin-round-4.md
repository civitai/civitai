# Creator Studio — round-4 feedback / task checklist (2026-07-20)

Consolidated + reconciled from three sources:

- **ClickUp** — milestone **Creator Studio - V1 Feedback** `868ke491x` (12 subtasks) + milestone **vNext**
  `868ke495b` (2 subtasks) + two related standalone tasks, all in list *Synced Team* `901111220963`. Each item below
  cites its `CU:<id>`, owner, and the requesters ClickUp records (alexds9, MNeMiC, SubtleShader).
  *(Skill note: `query.mjs get --subtasks` doesn't pass ClickUp's `include_subtasks=true`, so it reports 0 subtasks —
  fetch subtasks via the API directly until the skill is fixed.)*
- **Transcript** — Justin + Briant walkthrough (`Downloads/transcript (1).md`); refs like `T:12`.
- **Briant's notes** (*BN*).

Tags: **[todo]** build · **[done?]** likely built — verify · **[main-app]** needs a Next.js-app change · **[vNext]**
post-V1 · **[justin]** Justin-owned (not us). Owner is Briant unless noted.

---

## Bugs / quick fixes

- [x] **[done]** **Bulk-edit-fees clears active filters** — "Bulk edit fees" + "Cancel" now build their href off the
  current URL (`buildHref`), preserving filters/sort/page. (*BN*; `T:332`)
- [x] **[done]** **Licensing dropdown was white-on-white** — added `[&>option]:bg-dark-7 [&>option]:text-white` to
  every `NativeSelect` (models filter/sort/images + layout membership) so option lists render dark. (`T:287`)

## Models / Licensing page

- [x] **[done]** **Base-model + model-type filters for bulk license fee** — `CU:868ke491e`. Added a **model-type**
  filter (distinct `Model.type`) alongside the existing base-model filter; both narrow the "select all N matching"
  set, so filter → select-all → set-fee works at scale. (`T:35`)
- [x] **[done]** **`.red` link when NSFW > PG-13** — `CU:868ke4903`. `$lib/model-url.ts` `isMatureModel` routes to
  `civitai.red` on R+ bits with no PG/PG-13 bit (or the `nsfw` flag); the models "View on Civitai" link uses
  `modelUrl(...)`. (`T:3`)
- [x] **[done]** **Configurable page size (cookie)** — `CU:868ke493p`. Page-size selector (20/50/100) persisted in a
  shared `cs-page-size` cookie via `?ps=`; `MODELS_PER_PAGE` stays the default. Reusable across paged surfaces. (`T:339`,
  *BN*)

## Early / paid access (Licensing page)

> **Spec written:** [permanent-pay-for-access-plan.md](permanent-pay-for-access-plan.md) covers all three items
> below. Investigation found this is **bigger than "just a migration"** — EA's `earlyAccessEndsAt` is trigger-derived
> and `NULL` already means "public," so permanent needs a new "active-but-never-expires" signal + a trigger rewrite +
> ~8 main-app paywall patches (money enforcement) + a membership gate. **Not coded** — blocked on the design/policy
> decisions in §7 of that doc. Main-app work lands in `C:\work\civitai` and deploys before the migration.

- [ ] **[todo] [main-app]** **Early Access improvements** — `CU:868ke4944` (MNeMiC). EA cost must be **editable
  anytime** (a typo currently forces delete + re-upload). EA values must **not** be editable after the EA window ends
  **unless** it's a permanent-license. Manage EA for versions still in EA or **not yet published**. Audit the EA edit
  constraints (EA internals in the plan doc). (*BN*; `T:302`,`T:424`)
- [ ] **[todo]** **Manage paid access at any time (published items)** — once a version is published, let the creator
  **add / change paid access whenever**, not only pre-publish. (Paired with EA-improvements above; distinct from the
  indefinite capability below.) (*BN*; `T:329`,`T:425`)
- [ ] **[todo] [main-app]** **Permanent pay-for-access** — `CU:868ke4949` — **MNeMiC's #1 request** (echoed alexds9 +
  SubtleShader). Gate a model behind payment **indefinitely**, not just an EA window. Approach: reuse the EA config but
  allow **no end date / no period length**; make it **Creator-Program-member-only** (vs EA which is open to all).
  Needs an on-site change — Louise built EA; Claude investigates a clear path first, then decide if Louise does the
  on-site part. (*BN*; `T:424`)
  - `@justin:*` confirm gate: CP-member-only vs any member (`T:454` had both phrasings).

**Naming:** keep the page **"Licensing"** even though it now also covers early/paid access. (Decided.) (`T:576`)

## Earnings

- [x] **[done]** **Combined Green + Yellow buzz** — `CU:868ke492g`. The "By source" table has a Split↔**Combined**
  toggle; Combined collapses every buzz currency into one **Total Buzz** column (the "total value of Buzz" view).
  Split stays the default (B8). (`T:43`)
- [ ] **[todo]** **Buzz→$ ratio history** — `CU:868ke492x`. Monthly historical buzz→$ conversion. Derive from
  ClickHouse `buzzTransactions`: net bank into `creatorProgramBank` (bank − extract) vs the `compensation` cash grant
  into `cashPending` (amount in **cents**, `externalId` = `comp-pool-unified-YYYY-MM-<userId>`); `ratio =
  cashDollars / netBankedBuzz`, capped at $0.001/buzz; data from **Mar 2025**. Use the comp grant, **not**
  `CashWithdrawal`. (Full queries in the plan doc.) (`T:47`)
- [x] **[done]** **Line ↔ bar chart toggle** — `CU:868ke4939` (alexds9 + MNeMiC). Line/Bar toggle on the earnings
  trend; smooth line default. In bar mode the current period is bars and the **previous period stays a line** (dashed
  overlay). (`T:54`)
- [ ] **[done?]** **Per-model earnings filter / buzz-chart filtering** — `CU:868ke494r` (MNeMiC). Ensure per-model
  earnings charts exist in Studio (buzz dashboard already has them), **plus** an optional filter for which transaction
  types show (exclude payouts / transfers / membership buzz / model spend). Briant: "mostly have this" — **verify +
  add the type filter**. (`T:491`)

## Analytics

- [x] **[done]** **Current-vs-previous period overlay** (30d vs prior 30d) — implemented (`previousRange`). *No CU
  task.* (`T:61`)
- [ ] **[todo]** **Model + version selection to compare** — `CU:868ke493d` — **explicitly V1** (ClickUp overrides the
  transcript's "maybe vNext"). Let creators pick a model or its individual **versions** and overlay/compare graphs
  across metrics (**generations** vs **downloads**) over time; default to top-N versions for the period but allow
  selecting any version (incl. zero-activity ones). (`T:104`,`T:538`)
- **[resolved — no]** **NSFW/content-level controls in analytics** — not needed; owner-only views. (`T:181`)

## Get-paid estimate (non-members)

- [x] **[done]** **Surface the Get-Paid estimate in Studio** — `CU:868ke4941` (MNeMiC). Added a "Turn your Buzz into
  earnings — your {buzz} could be worth ~${X} this month" hero on `/join` (non-members only). Faithfully replicates the
  main app's compensation-pool math (`$lib/server/creator-program.ts`: `getPoolValue`/`getPoolForecast` ClickHouse
  queries + `getForecastedValue`, capped $1/1k buzz), Redis-cached a day. **Decisions taken:** current-month rate to
  **match the main app** (no trailing-3-month rate exists anywhere — MNeMiC's "honest" variant would be net-new; noted
  as a follow-up); replicated in-spoke per Briant. **Env:** exact match needs `CREATOR_POOL_TAXES/PORTION/FORECAST_PORTION`
  set in the Studio env (documented in `.env.example`); without them it degrades to the same 35000/50% fallback the
  main app uses. **`@briant:*`** the shared-package idea (extract this + more creator-program logic into
  `@civitai/creator-program`) — recommend deferring until a 2nd consumer/feature needs it; kept the seams clean. (`T:378`)

## Dashboard

- [x] **[done]** **Color / icons to differentiate cards** — `CU:868ke492b` (alexds9 + MNeMiC, "small, mandatory").
  Dashboard cards now carry per-card Tabler icons + palette colors (and period-over-period delta chips). (`T:20`,`T:568`)

## Cross-cutting

- [x] **[done]** **Account switching** — `CU:868ke4956` (MNeMiC). Sidebar username row → popover listing the
  accounts on this device (from the auth hub's civ-device set), with switch + sign-out. Reuses the hub's existing
  `GET /api/auth/accounts` + `POST /api/auth/switch` (device-ownership guard `isLinkedAndFresh` stays in the hub); the
  spoke adds thin same-origin proxy routes and relays the hub's Set-Cookie — it never mints a session itself. Note:
  the hub lazily materializes the device set only once a 2nd account signs in on the device, so a single-account
  device shows "no other accounts" until a second login. (`T:502`)

## Justin-owned (main-app; not our build)

- [ ] **[justin] [main-app]** **Donation-goal opt-out + bulk-hide old goals** — `CU:868ke494m` (Justin). **Confirmed
  small.** Only public earnings surface = the donation-goal progress bar (`DonationGoal.active=false` already hides it).
  Add a per-account hide toggle (user-settings JSON) + one service-side filter, plus a bulk-deactivate-old-goals
  mutation + button. **Watch-out:** don't deactivate EA goals still inside their EA window. (Transcript had Justin
  "clarifying" — ClickUp shows it scoped and owned by him.) (`T:467`)
- [ ] **[justin]** **CSV export of buzz transactions** — `CU:868ke491n` (Justin, priority **low**). Creator-studio-
  tagged; not discussed in the transcript.

## vNext (post-V1 — milestone `868ke495b`)

- [ ] **[vNext]** **Customizable Dashboard** — `CU:868ke495u`. Customizable panels; share code with the
  models/analytics custom-views work. (`T:538`)
- [ ] **[vNext]** **Audience** — `CU:868ke4vn3`. Broader audience analytics. *(Note: the audience-tab all-time
  reactions/comments charts Briant said he was "already doing" (`T:189`) appear to be landing in V1 analytics — this
  vNext task is the larger expansion; confirm the split.)*
- **[vNext, no task]** **Multi-period compare** — overlay an arbitrary prior month (e.g. March), not just the previous
  period. Per the V1 milestone note: lives in vNext, but **pull forward if easily doable on current data** (overlaps
  the %-vs-last-month work). Agreed it adds noise otherwise. (`T:543`)

---

### Suggested first pass (small, high-value, spoke-only)

1. Bulk-edit-fees filter-preservation bug.
2. Base-model + model-type filters for bulk fee (`868ke491e`).
3. `.red` link by NSFW level (`868ke4903`).
4. Configurable page size (`868ke493p`).
5. Combined Green+Yellow total (`868ke492g`).
6. Dashboard color/icons — mandatory (`868ke492b`).

Then the bigger tracks: **EA improvements + permanent pay-for-access** (main-app investigation), **buzz→$ history**
and **line/bar toggle**, **model+version comparison** (V1), **get-paid estimate**, **account switching**. vNext:
customizable dashboard, audience expansion, multi-period compare.
