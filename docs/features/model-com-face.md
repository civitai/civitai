# A model's civitai.com face

One model, two faces. A creator can give a model a separate title, description and cover for
civitai.com, which shows no mature content, while civitai.red keeps the original listing. With
nothing set, both sites show the same listing.

## Who sees which face

The face follows the viewer's browsing level, not only the site:

- A viewer whose browsing level has no mature levels sees the .com face: everyone on civitai.com,
  anyone signed out, and a civitai.red viewer who has mature content turned off.
- Everyone else sees the .red listing.
- The owner and moderators always get both, because the same response fills the model editor.

`showsSfwFace(browsingLevel)` in `src/shared/utils/model-sfw-face.ts` is the rule. A server caller
with no viewer (no browsing level) keeps the .red face.

## Storage

Four nullable columns on `Model`:

| Column | Meaning |
|---|---|
| `sfwName` | The .com title. Set means the face is on; `NULL` means off. |
| `sfwDescription` | The .com description. `NULL` while the face is on means .com shows none; the .red description is never shown in its place. |
| `coverImageId` | The creator's pick for the .red cover. |
| `sfwCoverImageId` | The .com cover: one of the creator's own images rated PG or PG-13. |

The `sfw*` names follow `UserProfile.sfwBio` / `sfwCoverImageId`. They are unrelated to
`Model.sfwOnly`, which restricts what a resource may generate.

The cover columns have no foreign key: a deleted image falls back to the derived cover, which is
the first image of the creator's latest version.

## Listing a mature model on civitai.com

A model marked mature (`nsfw = true`) normally has its `nsfwLevel` forced to the mature levels,
so no .com browsing level matches it. Once its .com face is complete (a .com title and a valid
.com cover), `updateModelNsfwLevels` adds the cover's own level to the model's. The model then
matches .com in the feed, both metric tables and search, with no filter changes. Its `nsfw` flag
and its .red standing do not change.

The cover only counts while it is a scanned, unflagged image on one of the creator's published
posts on a published version of the model. The level is recomputed when the face or a cover is
saved, when one of the creator's images or posts on the model is deleted, blocked or otherwise
moderated, when a version is unpublished, and when an image's rating changes. When the cover stops
qualifying, the model leaves .com again.

For a mature model shown through its face, the feed sends .com viewers only its PG/PG-13 images.

`hasSfwFace` on model responses and search documents marks a complete face. The client-side drop
of mature models on .com and the model page's redirect to .red both exempt it.

Version levels are not changed, so mature versions do not appear in SFW-only contexts such as the
generator's resource picker.

## Content check

Saving a .com title or description runs it through the text-scan, the same classifier, prompts and
model that decide whether a model is marked mature, asking only for its nsfw rating. A field rated
above PG-13, or a check that could not run, is refused. The preview (`text-scan/preview.ts`)
registers no callback and names no entity, so it writes no moderation record. The editor runs the same check as the creator
types (`model.checkSfwFace`) and shows the result above each field, with the classifier's rating
and reason. It also checks version names
and trigger words, which .com shows unchanged.

The .com fields are never fed to the automatic checks that set `Model.nsfw`; those keep reading the
.red title and description.

## Draft action

"Draft a civitai.com version" (`model.draftSfwFace`) asks the orchestrator's chat completion to
rewrite the current title and description for .com. If the check still flags the draft, it gets
one revision. Nothing is saved until the creator saves.

## Where it is read

- The model page (`getModelHandler`) and link previews (`/api/og`).
- The model feed and everything built on it (`getModelsRaw`): browse, home blocks, collections and
  API v1 lists.
- Search hits, resolved in the card, autocomplete, quick search and the generator picker.

Code: `src/shared/utils/model-sfw-face.ts`, `src/server/services/model-sfw-face.service.ts`,
`src/server/services/model-cover.service.ts`, `src/components/Resource/Forms/ModelListingTabs.tsx`.
