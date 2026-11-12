# Version showcase

A model version's showcase is the carousel at the top of the model page. A creator curates it
separately for civitai.com and civitai.red: they reorder and hide their own images, and feature
images other people made with the version. Behind the `model-version-showcase` flag.

## How it is stored

`ModelVersionShowcaseItem` holds only what the creator changed, one row per
`(modelVersionId, site, imageId)`:

- `source = 'Owner'`: a position for, or a hide of (`excluded`), one of the creator's own images
- `source = 'Community'`: a featured image by someone else
- `removedByContributor`: the image's author removed it; kept so it can't be added again

A version and site with no rows shows exactly what it showed before: the creator's images in post
order. The table has no foreign keys; a row whose image or version is gone matches nothing.

## Slot 1 is the cover

The model's `coverImageId` (civitai.red) and `sfwCoverImageId` (civitai.com) are slot 1 of the
latest published version's showcase for that site. Everything that already reads those columns
follows: model cards, link previews, the models search document and the civitai.com listing. Every
cover write, from the model editor, the com-face API or the showcase, goes through the same checks
(`assertCoverChange` / `saveModelCovers` in `model-cover.service.ts`).

- A cover may be a community image featured in that site's showcase.
- On a mature model the civitai.com cover must be the creator's own image: it is what lists the
  model on civitai.com, and someone else's image must not decide that.
- A non-mature model's civitai.com cover applies to civitai.com viewers without a civitai.com title.

## What a community image must pass

At add time and again on every read (`version-showcase.service.ts`): the same filters as the
creator's own showcase images, a public post, an active author who hasn't opted out
(`hideFromVersionShowcases`), no block either way between the two, not hidden from the creator's
galleries, the model's own gallery rules and held level, and on civitai.com a PG or PG-13 rating.
It must be made with the version or posted to its gallery. At most 20 per version per site.

Community images never feed a model's `nsfwLevel`, so they can't move a model between sites. They
reach the carousel, a cover and its search card; the public API keeps returning the creator's
images.

## Authors

The author is notified once per version and image, credited on the carousel and on cards, can
remove their image from every showcase from its menu, and can opt out in account settings. Removal
works with the flag off.

## Caches

`versionShowcaseCache` (1 hour) holds each version's rows and the community images that pass the
filters. Post changes, bans, blocks, opt-outs, gallery rule changes and version merges refresh it,
and clear any community cover that no longer qualifies. Every read and refresh fails open: if the
showcase can't be read, the carousel and covers fall back to the creator's images.
