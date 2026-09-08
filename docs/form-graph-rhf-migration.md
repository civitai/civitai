# react-hook-form → form-graph: where switching pays, and what a full migration retires

Status: discussion (2026-09-08). Question being answered: would our react-hook-form usage
be simplified by moving forms onto form-graph — and does anything short of a full
migration actually retire the `Input*` boilerplate layer?

## Current state, measured

54 form components run on the house wrapper (`~/libs/form`: `useForm` + `Form` +
`withController` + ~35 stamped `Input*` exports). Only 2 files in the app own a form on
raw react-hook-form; RHF is not spread across the app, it is spread across
`src/libs/form`. The form-graph lane (generation) is fully disjoint — no file imports
from both.

By character:

| Bucket | Count | Examples |
| --- | --- | --- |
| Static CRUD — schema + submit, zero watch/setValue | ~24 | the `createReportForm` family (9 forms from one factory), account modals, schedule modals |
| Mildly dynamic — 1–2 watches gating a section, reset-on-data | ~24 | ArticleUpsertForm, CollectionEditModal, UserProfileEditModal |
| Value-dependent shape — the field set/validation/defaults change with the form's own values | **6** | see below |

The complexity is **depth, not sprawl**: app-wide there are 74 `watch`/`useWatch`
occurrences, 98 `setValue`, and 22 `setError` outside the lib — and the six
value-dependent forms account for most of them.

The six, worst first (signals = watch + setValue + useEffect + setError + reset):

1. `src/components/Resource/Forms/ModelVersionUpsertForm.tsx` — 2,055 lines, 46 signals.
   `usageControl`/`availability` cascade nulls five monetization fields; two competing
   effects reconcile `licensingSourceVersionId`; four separate comments document which
   hidden values must survive unmount and which must be hand-cleared.
2. `src/components/Challenge/ChallengeUpsertForm.tsx` — 1,365 lines, 26 signals.
   `prizeMode` switches the prize fields between three shapes (a discriminated union);
   11 hand-rolled `setError` calls exist because the house `useForm` casts the schema to
   `ZodObject` to read `.shape`, which forbids `.refine()` (comment at line 85). Its
   `CategoryWeights` child is the app's only field array.
3. `src/components/Resource/Forms/ModelUpsertForm.tsx` — 907 lines, 23 signals. The
   `nsfw`/`poi`/`sfwOnly`/`minor` four-way interlock is spread across five `setValue`
   sites; a self-watching subscription builds `lockedProperties` from touched fields.
4. `src/components/Bounty/BountyUpsertForm.tsx` — 906 lines, 16 signals. `type`
   switches the whole `details` sub-object shape — and `useFormStorage` persists that
   branching shape to localStorage, so a draft saved on one branch restores against
   another.
5. `src/components/CosmeticShop/CosmeticShopItemUpsertForm.tsx` — 696 lines; cosmetic
   type rewrites the item's field set.
6. `src/components/Generation/PromptEnhance/EnhanceTab.tsx` — 520 lines; RHF used as a
   state bag (watch + setValue on unregistered fields). Weakest case — zustand would
   also fit.

**The loudest single signal**: the house `useForm` defaults `shouldUnregister: true`
(with a literal `// TODO - do we need this?`), and **30 call sites individually override
it back to `false`** — several with comments explaining which hidden values must
survive. The whole codebase votes, one file at a time, for "a field leaving the DOM
keeps its value." That is form-graph's core model (intent persists; visible state
derives), which RHF makes a global boolean plus hand-managed exceptions.

## The `Input*` layer: what it actually is, and what each option retires

The layer is two things fused:

1. **~20 presentational wrappers** (`TextInputWrapper`, `NumberInputWrapper`,
   `SelectWrapper`, `NumberSlider`, upload components, …) — Mantine adaptation. These
   are controlled components with `value`/`onChange`/`error` props and know nothing
   about RHF. **They survive any migration, full or partial.** No form library removes
   the need to adapt Mantine.
2. **The binding**: `withController(Component)` stamped 35 times, plus per-component
   mapper hacks. This is where the debt lives:
   - the ref-forwarding check compares against `Symbol('react.forward_ref')` — a fresh
     symbol, so it is always false and **refs are never forwarded** (latent bug);
   - a `resetCount` counter threaded to every input as a `reset` prop, because RHF's
     reset doesn't notify non-field UI;
   - the `InputNumber` mapper reads `form.getValues()` to defeat `useController`'s
     defaultValue resurrection;
   - `any`-typed props, `@ts-ignore`, error-shape special-casing.

Under form-graph the binding becomes either direct `Controller`/`createTypedController`
render props (what the generation form does) or a ~30-line typed `withField(Component)`
factory giving the same `<InputText name=… />` call-site ergonomics. So a full
migration does **not** reduce 35 stamped exports to zero — it reduces them to one small,
properly typed factory with no mapper hacks, no reset prop, and no resurrection
workarounds.

The boilerplate that genuinely disappears is different, and bigger:

- **Call-site config duplication.** Today `min`/`max`/`step`/options live in the JSX at
  every call site AND (sometimes disagreeing) in the zod schema. In form-graph they
  live once, in the field def, and reach the component through `meta` — the same def
  the server validates with. The JSX shrinks to name + label + presentation.
- **The `useForm` hook itself** — the `looseObject` cast (which is what forbids
  `.refine()` and forces Challenge's 11 hand-rolled `setError`s), the
  `shouldUnregister` battle, `resetCount`.
- **`Form.tsx` submit plumbing** — replaced by `store.validate()` + `focusFirstError`.
- **`useFormStorage`** — replaced by `persistedStorage`, which is per-branch safe
  (scoped intent) where the localStorage envelope is not.
- **The per-form effect soup** — the watch/setValue cascades in the six forms above
  become resolver branches, `.effect` rules, `correct` policies, and computeds. The
  `lockedProperties` self-watch becomes `dirtyFields()`.
- Dead code found along the way: `src/libs/form/components/FieldArray.tsx` is
  unexported with zero users.

## Recommendation

**Partial first, full as the eventual end-state — but let the partial pay for itself
before committing to the tail.**

1. **Now, regardless of any migration** (small, benefits all 54 forms):
   - fix the always-false ref-forward check in `withController`;
   - flip the house `shouldUnregister` default to `false` (30/54 already override it;
     audit the remainder against the documented resurrection trap first).
2. **Port the value-dependent six**, one at a time, after the training-form rewrite
   (the agreed next form-graph consumer). Oracle-first, same as the generation port:
   freeze the current submit payload as golden fixtures, differential-test until
   byte-equal. Suggested first: **ChallengeUpsertForm** — the clearest categorical win
   (a shape union RHF cannot express, plus the app's only field array → `list()`) at
   two-thirds the size of ModelVersionUpsertForm.
3. **Then decide on the tail.** Once the six are ported, `src/libs/form` serves only
   static/mild forms. The remaining ~48 migrate mechanically (a typed `withField`
   factory keeps call sites nearly identical), which is when the RHF dependency and the
   `withController` layer can actually be deleted — the payoff the partial migration
   alone never delivers. Whether that mechanical pass is worth its regression surface
   is best judged after the six, when the per-form cost is known instead of estimated.
   The `createReportForm` factory (9 forms from one schema+render spec) would port as
   one unit, not nine.

What stays no matter what: the presentational wrappers, the upload components, rich
text — and submission orchestration (mutations, notifications), which is app code under
either library.

## Costs and risks, honestly

- Each of the six ports is real work — they are the app's hairiest forms, which is both
  why they pay and why they bite. The generation port's method (fixtures + differential
  oracle) is what made that tractable; budget for it per form.
- form-graph is pre-1.0 and we own it. The generation form in production plus its
  12k-case differential suite is the stability gate; breaking changes go through us.
- Two forms in the six carry localStorage drafts (`useFormStorage`); the port must
  migrate or deliberately drop existing drafts (the generation port's
  `migrate-v1-storage.ts` is the precedent for migrating).
- A half-migrated app has two form idioms for however long the tail survives. The
  mitigation is that the lanes are already cleanly disjoint today, and the boundary
  (value-dependent vs static) is legible enough to state in a review comment.
