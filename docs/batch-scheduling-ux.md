# Batch post scheduling — UX plan

Companion to [`batch-scheduling-plan.md`](batch-scheduling-plan.md) (master plan) and
[`batch-scheduling-phase1-tech.md`](batch-scheduling-phase1-tech.md). ClickUp 868mcqb8t.
Written 2026-10-06 against the 2026-10-02 scope; the planner critique is of the first-pass Creator Studio
`/calendar` page (uncommitted, see the master plan).
Reader: the engineer building Phase 1. Everything here is dark-theme first; light theme follows Mantine tokens.

---

## 1. Critique of the planner first pass (Creator Studio `/calendar`)

**What works and should survive any rewrite**
- The release model: a post tied to a scheduled model/version moves the release, drop opens the panel instead of committing, "Publish now" takes a confirm step. The `getPostScheduleScope` / `getPostScheduleError` rules and `POST /api/v1/posts/schedule` are reusable from either app.
- Local-time bucketing after hydration, replica-lag override (`moved`), window check on drop (10 min – 3 months) with a toast.
- Visual language is on-standard (`border-dark-4`, `bg-dark-6`, `text-dark-2`, blue scheduled / grey published).

**Weak, in priority order**

| # | Problem | Why it matters | Fix (section 4) |
|---|---------|----------------|-----------------|
| 1 | **No density strategy.** Every post is a full-width chip; cells grow unbounded. | MNeMiC's "one every 5h" is 5 chips/day, 150/month: the grid becomes a wall of truncated titles. 13 users already have 200+ queued. | Max 3 chips per cell then `+N more`; per-day count badge; week + agenda views. |
| 2 | **No bulk operations and no unschedule.** One post per drag, one per sheet. | The planner exists for people with 50–1,000 queued. Moving a week of posts is 35 drags. | Select mode + bulk bar: shift, move-to-day, unschedule to draft. |
| 3 | **Drag is undiscoverable and has no fallback.** One sentence of helper copy, no grab handle, no keyboard/touch path; standalone drop commits with no Undo. | Fails WCAG 2.1.1 (keyboard) and touch devices have no HTML5 drag at all. | Grab handle on hover, `Move to…` in the panel, arrow-key nudge, Undo in the success toast. |
| 4 | **Month only, `min-w-[720px]` horizontal scroll on phones.** | Creators check the queue from a phone; a 7-col grid scrolled sideways is unusable. | Agenda view is the phone default; week view for desktop detail. |
| 5 | **No cap/gap feedback.** Nothing shows how many posts a day holds vs the daily limit, or that two posts sit 10 min apart. | The server will refuse the move and the user learns why only via toast. | `5/6` badge per day, amber at cap, red over; gap warning in the panel. |
| 6 | **No filter by model/version or status.** Published posts always render. | A heavy poster's past weeks are noise; "show me only Neon Noir v2 posts" is RLY's actual question. | Filter bar: model/version, Scheduled / Published / Release. |
| 7 | **Empty day has no affordance.** The only empty state is for a whole empty month. | The natural "add something here" gesture goes nowhere. | Hover/focus `+` on empty days → composer prefilled. |
| 8 | **Native `datetime-local` input** in the sheet. | The standard's own rule against browser-styled controls (`Select`, not `NativeSelect`) applies; it also renders differently per OS. | Date picker + time field from `@civitai/ui` (or Mantine `DateTimePicker` if the planner moves). |
| 9 | Release chip is distinguished by a 12px rocket only; no legend; same blue as standalone. | Colour-blind and glance legibility. | Distinct yellow/amber chip + legend row under the header. |
| 10 | `MAX_POSTS = 500` truncates silently. | The 1,062-queue user could see a quieter month than reality. | Show "Showing 500 of N — narrow the range" notice, or page by week. |
| 11 | Time zone never shown; "Edit post" opens a new tab with no return path. | Minor, but both are cheap. | `All times in {tz}` in header; return URL on edit. |

---

## 2. Information architecture

### Surfaces

| Surface | Lives in | Route |
|---------|----------|-------|
| Batch composer (Phase 1) | Main app, flag `batch-post-composer` | `/posts/batch` (+ `?modelId=&modelVersionId=&startAt=`) |
| Planner (Phase 2) | **Both**, one Web Component (decision below) | `/user/schedule` and Creator Studio `/calendar` |
| Post editor | Main app (exists) | `/posts/[id]/edit` |
| Presets (Phase 3) | Main app, inside composer + post editor | — |

### Entry points
1. **Owner's model page** — version action row, next to the existing camera icon (`ModelVersionDetails.tsx` ~1767): split the icon into a menu for owners: `Post images` (existing) and `Promote this model…` → `/posts/batch?modelId=&modelVersionId=`. Non-owners never see it.
2. **`/posts/create`** — a flag-gated link under the title: `Posting more than a few? Schedule a batch →`.
3. **User's posts tab, "Scheduled" filter** — when checked, a `Open planner` button appears beside the filter chip.
4. **Planner → composer**: `+ Schedule a batch` header button, and the `+` on an empty day (`?startAt=`).
5. **Composer → planner**: the post-submit screen's primary CTA.
6. **Planner → editor**: detail panel `Edit post` with `?returnUrl=/user/schedule?month=…`.
7. **Creator Studio** — if the planner stays there, nav item `Calendar` under a new `Posts` group; otherwise a Dashboard tile `Scheduled posts: 212 · Open planner ↗`.

### Where the planner should live

> **Decided 2026-10-06: both, as one Web Component** (`<civitai-post-planner>`, see
> [`batch-scheduling-planner-element.md`](batch-scheduling-planner-element.md)). The main-app host is
> `/user/schedule`; Creator Studio keeps `/calendar`. The arguments below are why a main-app host is
> required, not optional; the surfaces table above reads "both" for the planner row.

The scope recommends Creator Studio; from the creator's seat the main app is better, and the first pass's server pieces move over with almost no loss.

- **Who uses it.** 618 schedulers today, most not Creator Program members. Creator Studio's nav is Monetization / Earnings / Analytics; the planner is a posting tool. Putting it there says "this is for earners".
- **Every edge of the planner crosses into the main app.** Quick-add opens the composer, the detail panel opens the editor, the composer's done-screen opens the planner, the "Scheduled" filter wants to link to it. Each is a domain hop with a new session check and a new tab; the first pass already resorts to `target="_blank"` for Edit post.
- **Thumbnails need browsing-level rules.** The main app has the NSFW blur / browsing-level provider; Creator Studio re-implements a `blur-md` heuristic.
- **Phones.** Creator Studio is a desktop dashboard; the main app already has mobile layouts and the agenda view belongs there.
- **Cost of moving:** `post-reschedule.ts`, the REST endpoint, and its tests stay; the Kysely read becomes a tRPC `post.getScheduled({from,to})`; the Svelte page is rewritten in Mantine (~1 week per scope's own estimate, vs 1.5 in Creator Studio).

If Justin keeps it in Creator Studio anyway, the designs in section 4 apply unchanged; the costs are the hops above, not the layout.

---

## 3. Phase 1 — Batch composer

### Decision: one page, three sections, sticky summary rail. Not a wizard.
Grouping, metadata and schedule are interdependent (changing "images per post" changes the post count, which changes the schedule). A wizard forces back-and-forth; the training wizard earns its steps because each costs money, this does not. Sections unlock top-down (Schedule is disabled until there is at least one uploaded image) so first-time users still read it as a sequence.

Nothing is created on the server until **Schedule N posts**. Uploads go to S3 with client-side metadata parsing (as `useMediaUpload` does today); posts are created and dated by one validated `post.scheduleBatch` call, so a batch cannot half-fail. Scan/ingestion runs after creation, as it does for any post.

### Layout (desktop ≥ 1024px)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ← Back     Schedule a batch of posts                      Promoting: Neon Noir — v2.0  │
├─────────────────────────────────────────────────┬────────────────────────────────┤
│ 1  MEDIA                                        │  SUMMARY (sticky)              │
│ ┌─────────────────────────────────────────────┐ │  200 images → 200 posts        │
│ │  Drop images or videos, or click to browse  │ │  First: Tue Oct 7, 3:07 PM     │
│ │  Up to 500 files · jpg png webp mp4         │ │  Last:  Fri Nov 7, 11:52 AM    │
│ └─────────────────────────────────────────────┘ │  Every 4h · ~6/day             │
│ [Import from Generator]                         │                                │
│ Uploading 143/200 ▓▓▓▓▓▓▓▓░░░ 71%   2 failed ↻  │  ⚠ 2 days over your limit (6) │
│ ┌──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┐           │  ⚠ 1 too close to an existing  │
│ │▣ │▣ │▣ │▣ │⊘ │▣ │▣ │▣ │⟳ │⟳ │✕ │▣ │ …         │     post                       │
│ └──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┘           │  [Fix spacing automatically]   │
│ Posts: ( • ) 1 image each   ( ) [ 4 ] per post  │                                │
│        [Shuffle order]                          │  ┌ PREVIEW ─────────────────┐  │
│                                                 │  │ Oct  M T W T F S S       │  │
│ 2  APPLY TO EVERY POST                          │  │      ● ● ● ● ● ● ●       │  │
│ Resources   [Neon Noir v2.0 ×] [+ Add resource] │  │ 6  6  6  6  6  6  7!     │  │
│ Tools       [ComfyUI ×] [+ Add]                 │  │ …                        │  │
│ Techniques  [txt2img ×] [+ Add]                 │  │ Nov …                    │  │
│ Tags        [neon ×] [cyberpunk ×] [+ Tag]      │  └──────────────────────────┘  │
│ Title       [{model} — {n}            ] ⓘ tokens │  Switch to list ↓             │
│ Preview: "Neon Noir — 1", "Neon Noir — 2", …    │                                │
│                                                 │  [Review 200 posts]  primary   │
│ 3  SCHEDULE                                     │  Nothing is posted until you   │
│ (•) Start at [Oct 7, 3:00 PM] every [4] [hours▾]│  confirm on the next screen.   │
│ ( ) Spread evenly from [date] to [date]         │                                │
│ ( ) Only on [M][T][W][T][F][S][S] at [time list]│                                │
│ ⓘ We nudge each time by a few minutes so posts  │                                │
│   never all land on the hour.                   │                                │
└─────────────────────────────────────────────────┴────────────────────────────────┘
```

Section 1 — **Media**
- Reuse `MediaDropzone` with `max` raised to a composer-specific `BATCH_IMAGE_LIMIT` (recommend 500; 1,062 exists in prod but 500 keeps one page tractable). Keep `Import from Generator`.
- Grid of 96px thumbnails, states: uploaded ▣, uploading ⟳ (ring progress), failed ✕ (hover: `Retry` / `Remove`), blocked ⊘ (hover: reason, `Remove`; excluded from count). A top progress bar with `n/N · k failed ↻ Retry all failed`.
- Grouping: radio `1 image each` (default) or `[N] per post` (1–20; the existing `POST_IMAGE_LIMIT`). Text beside it updates live: `→ 50 posts of 4`. `Shuffle order` so similar renders don't run back-to-back; drag-reorder is **not** Phase 1.
- Blocked and failed images never count toward posts, and the summary says so (`198 of 200 will be posted`).

Section 2 — **Apply to every post**
- Resources: `ResourceSelectMultiple` seeded from `modelVersionId` (chip not removable when entered from the model page — it is the point of "Promote"). Honour `MAX_MANUAL_RESOURCES_PER_IMAGE`.
- Tools / Techniques: the existing combobox popovers (`ImageToolsPopover`, `ImageTechniquesPopover`) rendered without their "Add to all" footer (everything here is all).
- Tags: `EditPostTags`' `TagPicker` extracted to a controlled component (no `postId` yet). `POST_TAG_LIMIT` applies.
- Title template: text input with tokens `{n}` `{total}` `{model}` `{version}` `{date}`; live preview of the first two titles; empty is allowed (posts may be untitled). Default `{model} — {n}` when a model is known.
- Per-image metadata (prompts) comes from EXIF as today; no editing here.

Section 3 — **Schedule**
- Mode A `Start at T, every X {minutes|hours|days}` — default T = next 15-min boundary ≥ now+20 min; X default 4 hours.
- Mode B `Spread evenly from A to B` — B default A+30 days.
- Mode C `Only on these weekdays at these times` — ship in Phase 1 **only if cheap**; otherwise Phase 2. It is the mode that matches "post when my audience is awake".
- Jitter: every computed time gets `+rand(1..9)` minutes, deterministic per batch seed so re-renders don't reshuffle; the preview shows the real minutes. Never :00.
- Constraints shown inline, not after submit: lead ≥ 10 min, window ≤ 3 months, gap ≥ 30 min against each other **and** against the user's existing scheduled posts (`post.getScheduled` for the window), daily cap counted per go-live day against existing + new.

**Summary rail** (sticky; the only place totals live)
- Totals, first/last, cadence. Violation lines are links that scroll the preview to the first offending day.
- `Fix spacing automatically`: pushes offending posts to the next free slot that satisfies gap and cap, then re-renders. Shows a diff line `Moved 7 posts, last is now Nov 9`.
- Preview: mini month strips, one dot per post (max 7 dots then a count), day count badge coloured grey / amber (`= cap`) / red (`> cap`), existing posts as hollow dots so the user sees why a day is full. `Switch to list` toggles to a scrollable `#  title  date  time` table — also the phone view.
- Primary: `Review 200 posts`, disabled with reason text while violations exist (`Fix 3 conflicts to continue`).

### Review screen (same route, replaces the page content; `← Back to edit`)

```
┌───────────────────────────────────────────────────────────────────────┐
│ Review 200 posts                         [← Back to edit] [Schedule 200 posts] │
│ All in your local time (America/New_York). Daily limit: 6 · gap 30 min.       │
│ ┌───┬────────┬──────────────────────────┬────────────────────┬────────┐        │
│ │ # │ ▣▣▣▣   │ Title                    │ Goes live          │        │        │
│ │ 1 │ ▣      │ Neon Noir — 1       [✎]  │ Tue Oct 7, 3:07 PM [✎] │ Remove │   │
│ │ 2 │ ▣      │ Neon Noir — 2            │ Tue Oct 7, 7:04 PM     │ Remove │   │
│ │ … │        │                          │                        │        │   │
│ └───┴────────┴──────────────────────────┴────────────────────┴────────┘        │
│ Shared: Neon Noir v2.0 · ComfyUI · txt2img · #neon #cyberpunk                 │
└───────────────────────────────────────────────────────────────────────┘
```
Per-post overrides in Phase 1 are exactly: edit title, edit time (re-validated inline, row turns red with the reason), remove from batch. Anything deeper happens in the post editor after creation. Virtualised list (200–500 rows).

### Submit and post-submit
- Click → modal `Creating posts… 34 / 200` with a determinate bar; cannot be dismissed. The server call is one `post.scheduleBatch`; the bar reflects its progress events or a chunked loop.
- Success screen: `200 posts scheduled` · `First goes live Tue Oct 7, 3:07 PM · last Fri Nov 7` · [Open planner] (primary) · [Schedule another batch] · [View as drafts list]. If the planner isn't shipped yet, primary becomes `View scheduled posts` → posts tab with `scheduled=true`.
- Partial failure (should be rare given up-front validation): `187 scheduled, 13 failed` with the failed rows listed, their images kept, `Retry 13` and `Save 13 as drafts`.
- Hard failure before anything is created: inline alert at top of the Review screen with the server reason mapped to copy (section 7); the batch remains editable.

### Empty / loading / error states
- Empty composer: dropzone hero copy + `Import from Generator`; sections 2–3 visible but disabled with `Add media first`.
- Loading existing schedule for conflict checks: preview shows skeleton strips and `Checking your existing schedule…`; the Review button waits on it.
- Muted or restricted user: same lock alert as `/posts/create`.
- Over `BATCH_IMAGE_LIMIT`: dropzone error `You can add up to 500 files per batch. 37 were skipped.`
- Navigation away with uploads pending: `useCatchNavigation` prompt.

### Mobile (< 768px)
Single column, sections stacked; the rail becomes a sticky bottom bar `200 posts · Oct 7 – Nov 7 · 2 conflicts ▲` that expands to a bottom sheet holding the list preview and the Review button. Thumbnails 3-up; the Review table becomes cards. Mode C's weekday toggles wrap to two rows.

---

## 4. Phase 2 — Planner redesign

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Scheduled posts     212 queued · 6/day limit · America/New_York   [+ Schedule a batch] │
│ [Month ▾] [Week] [Agenda]  ‹ October 2026 ›  [Today]   Filter: [All models ▾] [Scheduled ✓ Published ☐ Releases ✓]  [☐ Select] │
│ Legend: ■ scheduled  ■ release (moves with model)  □ published                 │
├────────┬────────┬────────┬────────┬────────┬────────┬────────┐                 │
│ Mon 5  5/6 │ Tue 6  6/6 │ Wed 7  7/6!│ Thu 8  2/6 │ Fri 9  0/6 │ Sat 10 │ Sun 11 │
│ 3:07p ▣ Neon…│ 2:04p ▣ Neon…│ 1:09p ▣ Neon…│ 6:12p ▣ Hallo…│   [+]   │        │        │
│ 7:11p ▣ Neon…│ 6:08p ▣ Neon…│ 5:03p ▣ Neon…│ 9:15p ▣ Hallo…│         │        │        │
│ 11:02p▣ Neon…│ 10:06p▣ Neon…│ 9:07p ▣ Neon…│              │         │        │        │
│ +2 more     │ +3 more     │ +4 more     │              │         │        │        │
└────────┴────────┴────────┴────────┴────────┴────────┴────────┘                 │
```

- **Month**: max 3 chips per cell then `+N more` (click expands the cell into a popover list). Count badge `n/cap` top-right of each cell: grey, amber at cap, red over. Hover/focus on an empty cell shows `+` (quick-add → `/posts/batch?startAt=`).
- **Week**: 7 columns × hour rows, chips positioned by time; this is where gap collisions are visible and where drag-to-time (not just day) lives.
- **Agenda**: grouped-by-day list, infinite scroll, the default on phones and for anyone with > 60 posts in view. Each row: thumb, time, title, model chip, status, overflow menu (`Reschedule… · Unschedule · Edit · Publish now`).
- **Chips**: 20px thumb (browsing-level blur rules), time, title. Scheduled = blue; release = amber with rocket; published = grey outline, not draggable. Drag handle (⋮⋮) appears on hover/focus.
- **Reschedule**: drag (month → day, week → day+hour); keyboard: focus chip, `Enter` opens panel, `Shift+←/→` nudges ±1 day, `Shift+↑/↓` ±1 hour, each nudge announced via `aria-live`; touch: long-press enters select mode, use the bulk bar. Every successful move toasts `Moved to Thu Oct 8, 6:12 PM · Undo` (Undo issues the reverse call).
- **Select mode** (`Select` toggle or shift-click): checkboxes on chips, bulk bar (port of Creator Studio's `BulkBar` pattern) above the grid: `12 selected · [Shift ±…] [Move to day…] [Unschedule to drafts] [Clear]`. `Shift ±` dialog: `[−][ 1 ][+] [days▾]`, preview line `Oct 7–9 → Oct 8–10 · 0 conflicts`, `Apply`. Release posts are excluded from bulk moves with a notice (`3 release posts not moved — they move with their model`).
- **Detail panel** (right `Drawer`): thumb, title, `Goes live` date+time picker, `Reschedule`, model/version chips, resources + tags summary, `Unschedule to draft` (confirm), `Publish now` (confirm, as first pass), `Edit post`. Release posts keep the first pass's notice and `Move release`.
- **Filters**: model/version select (only models the user has scheduled posts on), status checkboxes. Persisted in the URL.
- Over-fetch guard: `Showing 500 of 612 in this range — switch to Week or filter by model`.

**Phase 2 scope**: Month, Agenda, drag + keyboard nudge + Undo, select mode with Shift ± and Unschedule, filters, cap badge, quick-add, detail panel, release handling (from first pass).
**Later**: Week view with drag-to-time, bulk publish-now, gap visualisation, bulk edit of metadata, drafts on the calendar.

---

## 5. Phase 3 — Saved presets (hooks only, in Phase 1)
- Section 2's header gets a right-aligned ghost `Save as preset…` button, hidden behind the Phase 3 flag; the slot is reserved so nothing reflows later.
- Model section 2's state as one serialisable object `{ resources, tools, techniques, tags, titleTemplate }` — that object **is** the preset payload. Keep it independent of the upload state.
- Remember the last-used object in `localStorage` per user (`Use last settings` link appears in the empty section 2). That is the zero-migration stepping stone to presets and tells us whether anyone would use them.
- Leave a `Preset: [none ▾]` select position at the top of section 2, rendered only when the flag is on.

---

## 6. Component inventory

**Main app — reuse**: `MediaDropzone`, `useMediaUpload` (+ EXIF/meta parsing), `UploadNotice`, `ImageSelectModal` (generator import), `ResourceSelectMultiple`, `ImageToolsPopover` / `ImageTechniquesPopover` (make the "all" footer optional), `EditPostTags.TagPicker` (lift to controlled), `InputDateTimePicker` / `InputDatePicker` / `InputTime` from `~/libs/form`, `ConfirmDialog`, `dialogStore`, `AlertWithIcon`, `BackButton`, `useCatchNavigation`, `DaysFromNow`, `PostFiltersDropdown` (add the planner link), `WizardStepper` is **not** used.
**Main app — new**: `BatchComposerProvider` (zustand, same shape as `PostEditProvider`), `BatchMediaGrid` (thumb states), `ScheduleBuilder` (modes A/B/C + jitter + validator), `SchedulePreview` (mini strips + list, shared with the planner's month cell badge logic), `BatchReviewTable` (virtualised), `BatchProgressModal`, `TitleTemplateInput`, `PromoteModelMenu` (model page split button). Phase 2: `SchedulePlanner` (month/week/agenda), `PostChip`, `PlannerBulkBar`, `ShiftScheduleDialog`, `PostDetailDrawer`.
**Server (named for the UX contract)**: `post.scheduleBatch`, `post.getScheduled({from,to,modelVersionId?})` returning posts + per-day counts + the user's cap and gap, `post.unschedule`, `post.shiftSchedule({ids, deltaMinutes})`.
**Creator Studio (only if the planner stays there)**: reuse `Notice`, `BulkBar` → generalise `BulkAction` type, `BulkActionDialog` shell, `Sheet`, `EdgeImage`, `Pagination`; add `@civitai/ui` `calendar` + `popover` primitives to the package, never the app.

---

## 7. Copy deck

**Headings / buttons**: `Schedule a batch of posts` · `Promote this model…` · `Review {n} posts` · `Schedule {n} posts` · `Back to edit` · `Open planner` · `Schedule another batch` · `Fix spacing automatically` · `Shuffle order` · `Import from Generator` · `Save as preset…` · `Unschedule to draft` · `Move to day…` · `Shift ±…` · `Publish now` · `Move release`.
**Helper**: `Nothing is posted until you confirm on the next screen.` · `We nudge each time by a few minutes so your posts never all land on the hour.` · `All times are in your local time zone ({tz}).` · `Your limit is {cap} posts per day. Scheduled posts count on the day they go live.` · `Tokens: {n} post number, {total}, {model}, {version}, {date}.`
**Validation (inline, red, specific)**:
- `Post 14 goes live 10 minutes after post 13. Posts need at least 30 minutes between them.`
- `Wed Oct 7 has 7 posts; your daily limit is 6. Move one or let us fix the spacing.`
- `Post 1 must be at least 10 minutes from now.` / `Post 200 is more than 3 months out. Shorten the gap or the range.`
- `Too close to "Halloween set — part 1" at 6:00 PM. Move it 30 minutes or more.`
- `2 images were blocked and won't be posted. Hover for details.` · `3 uploads failed. Retry or remove them to continue.`
- `You can add up to 500 files per batch. {k} were skipped.`
**Server errors mapped**: cap → `Your schedule hit the daily limit on {date}. Nothing was created — adjust and try again.`; gap → `Two posts would be too close together on {date}. Nothing was created.`; window → `Some dates fell outside the 10-minute to 3-month window. Nothing was created.`
**Confirms**: `Schedule 200 posts? The first goes live {date}. You can move or unschedule any of them from the planner.` [Schedule] [Cancel] · `Unschedule 12 posts? They become drafts and stay in your account.` [Unschedule] [Cancel] · `Publish this post now? It goes live immediately and can't be scheduled again.` (first pass copy, keep).
**Toasts**: `Moved to {date} · Undo` · `{n} posts shifted by +1 day` · `Post rescheduled for {date}` · `Couldn't reach the server. Nothing changed.`
**Empty**: planner — `Nothing scheduled this month. Schedule a batch, or set a date on any post from its editor.` [Schedule a batch]; composer — `Drop images or videos here, or click to browse. Up to 500 files.`

---

## 8. Open questions for Justin / Luis (recommendation in bold)

1. ~~**Planner location**~~ — settled 2026-10-06: a Web Component hosted by both apps (section 2).
2. **Batch file limit** — 200, 500, or none? **500**, matching prod reality (max queue 1,062 over months) without a multi-page composer.
3. **Weekday/time mode (Mode C) in Phase 1?** **Yes if ≤ 1 day; otherwise Phase 2.** It is the one mode that encodes "when my audience is awake".
4. **Should the Review step be a separate screen or an expandable table under the composer?** **Separate screen** — a 200-row table beside the schedule builder buries the Schedule button; and the confirm moment deserves its own page.
5. **`Fix spacing automatically` — push forward only, or also compress?** **Push forward only.** Compressing pulls posts earlier than the creator asked; forward is predictable and never violates lead time.
6. **Phase 1 without the planner: where does the success CTA go?** **Posts tab with `scheduled=true`**, plus ship the per-day cap copy there so the gap in tooling is visible rather than silent.
