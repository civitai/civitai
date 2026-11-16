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
| `images` | Posted images at a mature level that use the base model are flagged in the post editor, hidden from everyone but their uploader (and moderators opening the image by id) and, once flagged, refused as article, challenge, crucible and announcement covers, as contest, challenge and crucible entries and as remix submissions; an entry made before the flag lands is withheld instead: it is not judged if it hasn't been yet, cannot place or win, and does not count toward a participation prize not yet paid (one paid when it was entered is kept); a paid review still waiting when the challenge completes is refunded | `hasImageLicenseViolation` (`src/utils/image-utils.ts`), the hourly `reconcile-restricted-images` job, the image helpers below, semantic image search, the "SFW only" badge |

A base model whose provider terms only bind our use of their API (most hosted image and video APIs)
usually restricts `generation` alone: users can still post mature content they made elsewhere.

## Helpers

All readers go through these, never a copied list:

- `isMatureRestricted(baseModel, surface)`: the name match is case-insensitive
- `matureRestrictedBaseModels(surface)`
- `MATURE_RESTRICTED_LEVELS`: the levels a restriction covers (R, X, XXX)
- For a flagged image: `imageNotRestrictedSql`, `imageRestrictedSql`, `imageNotRestrictedWhere`,
  `isImageNotRestricted`, and `servableImage` (select `imageRestrictionSelect` for it), which returns the
  image without `modelRestricted` and `userId`, or null when the viewer may not see it
  (`src/server/common/image-visibility.ts`);
  `isRestrictedImage` and `RESTRICTED_IMAGE_REASON` (`src/shared/utils/restricted-image.ts`). `apps/feed-go`
  keeps its own copy of the image predicate (`internal/feed/query.go`), without the uploader exception.

## Hiding images is one-way

`reconcile-restricted-images` sets `Image."modelRestricted"` on mature images whose resources use a
base model restricting `images`. It never clears the flag; only a re-rating below R lifts the restriction.
The site's read paths (feeds, galleries, covers, entries, cards, search documents) hide a flagged mature
image from everyone but its uploader, and from the uploader too where the result is shared between
viewers. They apply `imageNotRestrictedSql` / `imageNotRestrictedWhere`, or `isImageNotRestricted` on rows
already fetched (`src/server/common/image-visibility.ts`). On the site a moderator can open one by its id:
`imageVisibilityConditions` applies no conditions for moderators, so its page, its generation data,
resources and tags, remixing it or reusing its prompt, and saving it to a collection or as a collection
cover all admit it. Opened by its id, its page shows moderators a Restricted notice. A few
moderator-only views also show it, labelled MatureRestricted: the challenge and challenge-event edit
forms, which keep a restricted cover, contest scoring and the rater sanity-set editor. Feeds,
galleries, covers, entries, cards and search apply the restriction to moderators too. The moderator
app applies no restriction, so all its views still show these images and safety review is unaffected;
its image review queues, rating requests and minor-hash match detail label them MatureRestricted.
Adding `images` to a base model therefore hides its existing mature images on the next hourly run:
count them before shipping that change.

## Generation

A submit is capped when its ecosystem restricts `generation`, or when any of its resources
(checkpoint or add-on) is on a base model that does. An ecosystem restricts only when every base
model in it does: SDXL holds SDXL Turbo but is not restricted. The ecosystem counts even when
resources are present, so a request on a restricted ecosystem stays capped whatever its resources
are labelled, raw-AIR epochs included.
