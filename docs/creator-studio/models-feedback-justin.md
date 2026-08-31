# `/models` — Justin feedback (round 1)

Feedback on the `/models` page, captured 2026-07-13. Status: ✅ done · 🔧 in progress · 💬 needs a design/product
decision before building.

## Layout / display

1. **✅ Model header stacks vertically.** Root cause: `@civitai/ui` `CardHeader` is `display: grid`, so the
   `flex-row` override never applied — model name, type, and status rendered on separate rows, and the bulk
   select-all checkbox sat *above* the name. Fixed by wrapping the header content in an explicit `flex` row.
   - **✅** Bulk checkbox now to the **left** of the name.
   - **✅** Type (e.g. "Checkpoint") + status now on the **same line** as the name.
2. **✅ Model status badge color.** The model-level status now uses the same variant as the version status badge
   (`default` when Published, else `outline`) so the colors match.

## Controls (search / sort / filter)

3. **✅ Search trigger unclear.** Search now fires on **blur** *and* Enter, and there's an explicit **search
   button** (magnifier icon) so it's discoverable.
4. **✅ Sort dropdown unlabeled.** Added a **sort icon** (`IconArrowsSort`) in front of the control so it reads as
   a sort, not a mystery dropdown.
5. **🔧 Filter icon + 💬 filters popover.** Added a **filter icon** on the current fee filter. The larger ask —
   a **filters popover** with **base-model** and **status** filters (not just fee) — is **deferred**: it needs the
   load to supply the available base models + statuses, and a popover UI. See "Next" below.

## Licensing fee input — ✅ done

6. **✅ Enter "N ⚡ per M images", not decimals.** Both the inline row control and the bulk editor are now
   **`[ N ] ⚡ per [ images ▾ ]`** — a whole-number **buzz** input (integer-only, `beforeinput`-guarded) and an
   **images select of 1 / 10 / 100** (not a free field). Conversion lives in one shared module
   ([`$lib/monetization/fee.ts`](../../apps/creator-studio/src/lib/monetization/fee.ts)): `ratioToFee(buzz,
   images)` stores `buzz ÷ images` at the column's 0.01 precision; `feeToRatio(perImage)` maps a stored fee onto
   the **smallest of {1, 10, 100}** that keeps buzz whole (`0.1 → 1 per 10`, `0.5 → 5 per 10`, `0.05 → 5 per
   100`, `0.01 → 1 per 100`, `1 → 1 per 1`) so it always matches an option. **Bulk defaults to 1 ⚡ per 10
   images.** Empty buzz clears the fee. Backend + stored decimal unchanged.
   - **No lossy round-trips:** because images is restricted to {1, 10, 100}, the only per-image values that can
     ever be stored are `k/1`, `k/10`, `k/100`, all of which map back onto one of those denominators exactly
     (`0.05` = "5 ⚡ per 100 images", not a stray decimal). There's also no legacy data — nothing is deployed.
   - **Range:** smallest fee is `1 ⚡ per 100 images` (0.01/image); largest is `100 ⚡ per 1 image` (the column
     cap).

## Next / deferred

- **Filters popover** (base model + status filters) — needs available-values from the load; bigger build.
- **Fee-as-ratio input** — pending Justin's confirm on the design above.
