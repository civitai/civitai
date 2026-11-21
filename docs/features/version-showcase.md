# Version showcase

A model version's showcase is the carousel at the top of the model page. A creator curates it
separately for civitai.com and civitai.red: they reorder and hide their own images, and feature
images other people made with the version. Behind the `model-version-showcase` flag.

## How it is stored

`ModelVersionShowcaseItem` holds only what the creator changed, one row per
`(modelVersionId, site, imageId)`:

- `source = 'Owner'`: a position for, or a hide of (`excluded`), one of the creator's own images
- `source = 'Community'`: a featured image by someone else
- `removed`: the image's author or a moderator removed it; kept so it can't be added again

A version with no rows on either site shows exactly what it showed before: the creator's images in
post order. A creator who curates only one site gets that showcase on both, filtered to each site's
levels (on civitai.com, only PG and PG-13 community images). The table has no foreign keys; a row
whose image or version is gone matches nothing.

## Slot 1 is the cover

The model's `coverImageId` (civitai.red) and `sfwCoverImageId` (civitai.com) are slot 1 of the
latest published version's showcase for that site. Model cards, link previews and the models search
document read those columns, so they follow it. Every
cover write runs the same validation (`assertCoverImagesValid` in `model-cover.service.ts`): the
showcase through `saveModelCovers`, and the model editor and the com-face API inside the editor's own
save, which also refuses a save when either cover changed since it was read.

- A cover may be a community image featured in that site's showcase.
- civitai.com shows no mature content, so its cover is always rated PG or PG-13, whoever made it.
- A non-mature model's civitai.com cover applies to civitai.com viewers without a civitai.com title.
- A mature model is listed on civitai.com only through its civitai.com title and the rating of its
  own civitai.com cover. Making a featured image that cover takes the model off civitai.com listings
  until the cover is the creator's own again; the editor warns before it happens.

The editor on civitai.com edits only the civitai.com showcase and is sent no image above PG-13.

## What a community image must pass

At add time and whenever the version's showcase is rebuilt (`version-showcase.service.ts`; each post,
ban, block, opt-out, gallery-rule or rating change, and at least hourly): the same filters as the
creator's own showcase images, a public post, an active author who hasn't opted out
(`hideFromVersionShowcases`), no block either way between the two, not hidden from the creator's
galleries, the model's own gallery rules and held level, and on civitai.com a PG or PG-13 rating.
It must be made with the version or posted to its gallery. At most 20 per version per site. Every
serve also re-checks the image's own moderation state, public post and rating.

Community images never feed a model's `nsfwLevel`. They reach the carousel, a cover, its link preview and search card, and the public API:
`/api/v1/models` and `/api/v1/model-versions` serve a curated showcase in place of the default list
(`withCuratedShowcases`), the civitai.com one to a caller served only safe levels, in the same shape
as the creator's own images. A version response that carries a curated showcase is never kept in
the shared cache.

A minor or SFW-only model's showcase, community images and covers included, stays within its held
gallery level on every reader: the carousel, model cards, link previews, the search document and
the public API.

## Authors

The author is notified once per version and image, credited on the carousel and on cards, can
remove their image from every showcase from its menu, and can opt out in account settings. A
moderator removes anyone's featured image from the same menu. Either removal keeps the creator from
featuring it again, and works with the flag off.

## Caches

The version showcase cache (`getVersionShowcaseCache`, 1 hour) holds each version's rows and the community images that pass the
filters. Saves, removals, post changes, an author raising a rating, bans, blocks, opt-outs and
gallery rule changes refresh it, drop the cached public model response, and clear a community cover
that no longer qualifies for a lasting reason. An image only waiting on a scan or a review keeps its
cover column; readers skip it until it clears. A version merge moves its rows to the target version
and refreshes it. A cover whose image was deleted stops being served at once. Every read for display
and every refresh fails open to the creator's images; validating a cover write fails closed.
