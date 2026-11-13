# Mature content restrictions by base model

Some base models may not be used for mature content (R, X and XXX), because the terms covering
Civitai's use of them say so. The restriction is defined in one place:
`matureRestricted` on the base model's record in `packages/civitai-shared/src/basemodel.constants.ts`.

```ts
{
  id: BM.Ideogram,
  name: 'Ideogram 4.0',
  // ...
  matureRestricted: ['generation', 'models', 'images'],
}
```

It is set per base model rather than per licence because the unit that differs is the base model:
one licence can cover base models with different terms. Licences carry only their legal text and
links.

## Surfaces

| Surface | What it restricts | Where it is enforced |
|---|---|---|
| `generation` | Our generator caps output at PG-13 with mature content refused | `capsGenerationOutput` in `src/server/services/orchestrator/form-graph/output-restrictions.ts`, for the site generator and the App Blocks `textToImage` arm |
| `models` | A model marked NSFW can't be published on the base model, and NSFW versions on it are hidden from model lists and search | the version form and submit, `model-version.service.ts`, `model.service.ts`, `pages/search/models.tsx` |
| `images` | Posted images at a mature level that use the base model are flagged in the post editor and hidden | `hasImageLicenseViolation` (`src/utils/image-utils.ts`), the hourly `reconcile-restricted-images` job, semantic image search, the "SFW only" badge |

A base model whose provider terms only bind our use of their API (most hosted image and video APIs)
usually restricts `generation` alone: users can still post mature content they made elsewhere.

## Helpers

All readers go through these, never a copied list:

- `isMatureRestricted(baseModel, surface)`
- `matureRestrictedBaseModels(surface)`
- `MATURE_RESTRICTED_LEVELS`: the levels a restriction covers (R, X, XXX)

## Hiding images is one-way

`reconcile-restricted-images` sets `Image."modelRestricted"` on mature images whose resources use a
base model restricting `images`. It never clears the flag, and image feeds, collections and the remix
gallery exclude flagged mature images. Adding `images` to a base model therefore hides its existing
mature images on the next hourly run: count them before shipping that change.

## Generation

A submit is capped when any of its resources (checkpoint or add-on) is on a base model restricting
`generation`. A submit with no resources is decided by its ecosystem, and only when every base model
in the ecosystem restricts generation: SDXL holds SDXL Turbo but is not restricted.
