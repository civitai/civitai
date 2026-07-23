# Creator Studio — Justin feedback (round 2)

Feedback captured 2026-07-14, spanning **Dashboard / Analytics / Settings / Models** (round 1 was models-only:
[models-feedback-justin.md](models-feedback-justin.md)). Status: ✅ done · 🚩 needs a product/design decision ·
⏸ deferred (bigger build) · 🔵 backend dependency.

Code fixes committed on `creator-studio-implementation`: **`d70d871`** (models/settings/dashboard) and
**`1039de7`** (analytics). All type-check clean.

---

## Dashboard

1. **✅ Rename CP cash labels.** "CP cash pending / CP cash settled" → **"Cash pending / Cash settled"**.
2. **✅ Link cards didn't read as clickable** ("just boxes"). The Models/Earnings/Analytics/Settings cards now
   have a cursor, a stronger hover (border + bg), and an arrow that nudges on hover.
3. **Context, no action:** the headline stat cards "just loading" — that's expected (awaiting the earnings
   wiring / A1), not a bug. Justin confirmed once he saw the "awaiting wiring" hint.
4. **⏸ Charts on the dashboard** — Justin marked this **low priority**. Deferred.

## Analytics

5. **✅ Route moved.** `/earnings/analytics` → **`/analytics`** (it was confusingly nested under Earnings). Nav +
   dashboard links updated.
6. **✅ Tooltip was hard to trigger** (had to land exactly on a dot). Now `interaction: { mode: 'index',
   intersect: false }` + a larger point `hitRadius`, so it fires anywhere along a date column.
7. **✅ Full date → MM-DD** on the x-axis.
8. **✅ Excess left padding** from the leftmost x-label overhanging → `ticks.align: 'inner'` (+ the shorter
   MM-DD labels).
9. **✅ Sections, not tabs.** The page already renders as sections (content performance + a "Model usage &
   earnings" section), which is what Justin preferred — no change needed.
10. **🔵 90-day metrics slow to load / system-load concern.** Confirmed the queries hit **raw event tables**
    (`reactions`, `views`, `userEngagements`, …) filtered by owner over N days. They're cached (TTL), but the
    real fix is Justin's own guess — **owner-keyed daily SummingMergeTree MVs (B4)** — a backend task, not
    app-side.
11. **⏸ Synchronized crosshair across charts** (hover one chart → vertical line on all charts at the same date,
    Grafana-style). Deferred: needs a Chart.js plugin + a shared hover-index store; the `@civitai/ui` `Chart`
    wrapper doesn't accept plugins yet.

## Settings

12. **✅ Membership blurb too subtle.** The status line ("Creator Program member… monetization is unlocked") is
    now brighter, with the key phrase emphasized (green "monetization is unlocked").
13. **✅ Title on a separate line from the badge** (membership + payouts). Same root cause as round-1 #1 —
    `@civitai/ui` `CardHeader` is `display: grid`, so `flex-row` didn't apply. Forced `flex`.
14. **✅ Payout "Not set up" badge looked funky** (right-aligned on its own line) — fixed by the same flex header.
15. **✅ Manage-membership + payout links open in a new tab.**
16. **✅ Don't let people set up payouts before they can withdraw** (Tipalti bills us per signup). The payout
    card now shows a **locked message** ("unlocks once you have $50 in settled cash") instead of a Set-up button
    when not set up. **TODO in code:** wire the real settled-cash read so the button unlocks at ≥ $50 (right now
    "not set up" is always locked, which is safe pre-cutover since ~no one has settled cash yet).
17. **🚩 Fee-defaults section.** Justin expected it to be where you **set a default fee rate** + an **"apply to
    all my models"** button. That **contradicts B9** (decided: *no* per-account default; the section is
    read-only info). Needs a product call before building — is B9 being reversed?

## Models

18. **✅ Early-access data bug (the big one).** Every version showed as "early access configured" (chip +
    "Turn off early access"), and the drawer pre-checked **charge-to-generate**. Root cause (verified in
    Postgres): the `earlyAccessConfig` column is an **empty `{}`** (or JSON null) for versions that never set up
    EA, so `!= null` was true everywhere. Now: empty configs are treated as null at the data layer; the EA chip
    shows (green) **only when a window is actually active**; charge-to-generate **defaults off**.
19. **✅ Version-row styling.** Rows are now **full-bleed with inner padding** (text no longer touches the edge on
    hover), have a **cursor**, and the per-version **"View on Civitai" link was removed** (Justin: drop it for
    style). Model-header Civitai link kept.
20. **✅ Dropdown contrast** (sort/filter were white-text-on-white when open) → dark option background.
21. **✅ Search button** wasn't the same height as the fields → matched.
22. **✅ Bulk-edit form text** ("⚡ per", "images", "empty buzz clears the fee") was gray-on-gray → lighter text.
23. **🚩 Early-access reframing.** Justin: it's weird to *enable* early access here once a model's published —
    maybe reframe to **"manage paid access,"** only let you **manage when it's already on**, and turn it on at
    **publish** time instead. Product-direction change to confirm before building (I fixed the misleading states
    in #18; this is the bigger "should EA setup live here at all" question).
24. **⏸ Bulk "select all matching."** Filter (base model + other model filters) → **select all across pages** →
    set one fee. Deferred feature: needs a **base-model filter** (the load must supply available base models) and
    **cross-page selection**. Overlaps round-1's deferred "filters popover."

---

## Next / open (the non-✅ items)

> All of these are now tracked in the **[implementation checklist](implementation-checklist.md)** (the single
> status source). Listed here for round-2 context only.

- **✅ #16 — payout unlock** — DONE: the settled-cash read (`getCreatorCash`) now unlocks the "Set up payouts" prompt at ≥ $50.
- **🚩 Fee-defaults settable + apply-to-all (#17)** — reconcile with B9 (product decision, open).
- **🚩 Early-access reframing (#23)** — manage-only / enable-at-publish (product decision, open).
- **⏸ Bulk select-all-matching + base-model filter (#24)** — highest-value remaining bulk-fee build.
- **⏸ Synchronized crosshair (#11)** — Chart plugin + shared hover store; add a `plugins` prop to the `Chart` wrapper first.
- **🔵 Analytics owner-keyed daily MVs (#10, B4)** — backend; removes the 90-day raw-scan load (perf, not blocking).
- **⏸ Dashboard charts (#4)** — low priority.
