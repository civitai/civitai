# Onsite ↔ Creator Studio monetization parity

Ask from **Justin (2026-07-23)**:

> "We likely should update the onsite model version management to include the fractional licensing fees
> (1 buzz for 10 images) stuff just like we have on the studio just to be consistent, so that people can
> technically still do it from on-site in their model creation flow as well. Probably need to port the perm
> paid access to onsite as well. I know all the license fee stuff onsite is currently behind a flipt flag too."

**Scope note (verified 2026-07-23):** both asks are **UI-only** — the data model and write paths already
support them onsite. Neither needs a schema change, migration, or backfill.

Onsite form: `src/components/Resource/Forms/ModelVersionUpsertForm.tsx`
Flag: `licensingFee` → `fliptKey: 'licensing-fee'` (`src/server/services/feature-flags.service.ts`)

---

## 1. Fractional licensing fees — presentation gap only

**Already true onsite:** the fee is stored as a **per-image decimal**, and the input already accepts fractions
(`InputNumber name="licensingFee" step={0.01} decimalScale={2}`, label *"License Fee per Image"*). So
1-buzz-per-10-images is settable today — you just have to know to type `0.1`.

**The gap is discoverability.** Creator Studio shows the same stored value as a **ratio** ("1 ⚡ per 10 images")
via `feeToRatio()` / `FEE_IMAGE_OPTIONS` (`apps/creator-studio/src/lib/monetization/fee.ts`) — cents math that
picks the nicest whole-buzz ratio. Typing `0.1` is not an obvious way to express "1 buzz per 10 images".

- [ ] Port the studio's ratio input (buzz amount + "per N images" selector) into `ModelVersionUpsertForm`,
      writing the same per-image decimal on submit. Share `feeToRatio` / `ratioToFee` rather than reimplementing
      the rounding — the cents math is what keeps the two surfaces from disagreeing.
- [ ] Keep the existing `MAX_LICENSING_FEE` clamp and the non-commercial base-model reset behaviour.
- [ ] Confirm round-tripping: a fee set in the studio renders identically onsite, and vice-versa.

## 2. Permanent paid access — schema ready, no UI

**Already true onsite:** `src/server/schema/model-version.schema.ts` accepts
`permanent: z.boolean().optional().default(false)`, and `timeframe` is `0` for permanent (the DB trigger has a
permanent branch). **But `ModelVersionUpsertForm.tsx` has no `permanent` control at all**, so it's unreachable
from the model creation flow.

- [ ] Add the permanent toggle to the onsite early-access block (studio equivalent: "Make permanent (no end
      date)").
- [ ] Port the **guardrails**, not just the checkbox — permanent is capped:
  - Creator-Program membership required (`canSellIndefinitely`).
  - Per-tier **count** cap — `bronze 3 / silver 10 / gold unlimited`
    (`PERMANENT_ACCESS_LIMIT_BY_TIER`), counted by `countPermanentAccessVersions`.
  - Surface remaining capacity ("X of Y set") so hitting the cap isn't a save-time rejection.
- [ ] Mind the **no-end-date trap**: permanent versions legitimately have `earlyAccessEndsAt = NULL`. Anything
      that infers "has paid access" from `earlyAccessEndsAt is not null` will silently miss them — this exact
      bug existed in the studio's access filter and badge (fixed 2026-07-23, commit `3c85f898df`). Audit onsite
      badges/filters/queries for the same assumption.
- [ ] Early access is **also** score-capped two ways — max days *and* max concurrent versions
      (`EARLY_ACCESS_CONFIG.scoreTimeFrameUnlock` / `scoreQuantityUnlock`). Onsite should surface the quantity
      cap too if it doesn't already.

## 3. Feature flag

- [ ] Decide whether permanent access rides the existing `licensing-fee` Flipt flag or gets its own. The fee
      block already gates on `features.licensingFee` (with an escape hatch so versions that *already* have a fee
      or cash settlement keep rendering it) — mirror that pattern so enabling/disabling the flag can't strand a
      version in an uneditable state.

## References

- Studio ratio helper — `apps/creator-studio/src/lib/monetization/fee.ts`
- Studio permanent/early-access caps — `apps/creator-studio/src/lib/monetization/early-access.ts`
- Studio access filter + badge fix (the NULL-end-date trap) — commit `3c85f898df`
