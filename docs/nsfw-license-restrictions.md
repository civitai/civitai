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
| `generation` | Our generator caps output at PG-13 with mature content refused | `capsGenerationOutput` in `src/server/services/orchestrator/form-graph/output-restrictions.ts`, for the site generator and the App Blocks `textToImage` arm. Private generation (a Private or unpublished version, or an epoch) is capped the same way: `capsAsPrivateGeneration` in `src/shared/utils/resource.utils.ts`, and `isRestrictedGenerationResource` in `src/server/utils/resource-access.ts` for App Blocks steps |
| `models` | A model marked NSFW can't be published on the base model, and NSFW versions on it are hidden from model lists and search | the version form and submit, `model-version.service.ts`, `model.service.ts`, `pages/search/models.tsx` |
| `images` | Posted images at a mature level that use the base model are flagged in the post editor, hidden from everyone but their uploader on per-viewer reads (see below for shared reads, moderators and article owners) and, once flagged, refused as article, challenge, crucible and announcement covers, as contest, challenge and crucible entries and as remix submissions; a challenge entry still awaiting review is rejected, and one already accepted is withheld instead: it is not judged if it hasn't been yet, cannot place or win, and does not count toward a participation prize not yet paid (one paid when it was entered is kept); a paid review still waiting when the challenge completes is refunded | `hasImageLicenseViolation` (`src/utils/image-utils.ts`), `flagImagesOnRestrictedVersions` and the hourly `reconcile-restricted-images` job, the image helpers below, semantic image search, the "SFW only" badge |

A base model whose provider terms only bind our use of their API (most hosted image and video APIs)
usually restricts `generation` alone: users can still post mature content they made elsewhere.

## Helpers

All readers go through these, never a copied list:

- `isMatureRestricted(baseModel, surface)`: the name match is case-insensitive
- `matureRestrictedBaseModels(surface)`
- `MATURE_RESTRICTED_LEVELS`: the levels a restriction covers (R, X, XXX)
- For a flagged image: `imageNotRestrictedSql`, `imageRestrictedSql`, `imageNotRestrictedWhere`,
  `isImageNotRestricted`, and `withServableImage(row, key, viewerId)` (select `imageRestrictionSelect` for
  the image), which returns `row` with the image at `key` set to null when the viewer may not see it
  (`src/server/common/image-visibility.ts`);
  `isRestrictedImage` and `RESTRICTED_IMAGE_REASON` (`src/shared/utils/restricted-image.ts`). `apps/feed-go`
  keeps its own copy of the image predicate (`internal/feed/query.go`), uploader exception included.

## Hiding images is one-way

`Image."modelRestricted"` is set on every image with a resource on a model version whose base model
restricts `images`, at any rating: by `flagImagesOnRestrictedVersions`
(`src/server/services/restricted-images.service.ts`) when resources are written, and hourly by
`reconcile-restricted-images` as the backstop, which also catches a version whose base model changes
later. Nothing clears the flag. The restriction applies only while the image is rated R or above, so
a re-rating below R lifts it.

The site's read paths (feeds, galleries, covers, entries, cards, search documents) hide a flagged mature
image from everyone but its uploader, and from the uploader too where the result is shared between
viewers. They apply `imageNotRestrictedSql` / `imageNotRestrictedWhere`, or `isImageNotRestricted` on rows
already fetched (`src/server/common/image-visibility.ts`). Feeds, galleries, entries, cards, search, and
covers outside the pages and forms listed below apply the restriction to moderators too.
A crucible whose cover is restricted drops out of the crucible feeds for everyone but its owner, and
out of the featured crucible and judging suggestions. Its page still shows, without the cover for
anyone but its uploader and moderators, and entries and judging carry on; while it is pending or
running and has passed its own review, its page asks its owner and moderators to change the cover.

The Knights rating games (New Order and Knights of New Order v2) apply no restriction: their
players rate these images too. The research rater's image feed does exclude them; its sanity-set editor
shows them, labelled.

Moderators see one in these places:
- opened by its id: `imageVisibilityConditions` applies no conditions for moderators, so its page (with
  a Restricted notice), its generation data, resources and tags, remixing it or reusing its prompt, and
  saving it to a collection (except a contest) or as a collection cover all admit it;
- on an article's page and edit form, its cover, banner and body images, as its owner does (badged
  below); on a crucible's page and edit form, its cover and hero;
- labelled MatureRestricted: the challenge-event form, the challenge edit form (also open to the
  challenge's creator), contest scoring and the rater sanity-set editor;
- the moderator app, which applies no restriction, so safety review is unaffected; its image review
  queues, rating requests and minor-hash match detail label them MatureRestricted.

An article's owner, and a moderator, sees a restricted cover, banner and body images on the article
page, with a MatureRestricted badge on the cover there and on the cover and banner in the edit form while the saved
image is still selected.

Adding `images` to a base model therefore hides its existing mature images on the next hourly run:
count them before shipping that change.

## Generation

A submit is capped when its ecosystem restricts `generation`, or when any of its resources
(checkpoint or add-on) is on a base model that does. An ecosystem restricts only when every base
model in it does: SDXL holds SDXL Turbo but is not restricted. The ecosystem counts even when
resources are present, so a request on a restricted ecosystem stays capped whatever its resources
are labelled, raw-AIR epochs included.
