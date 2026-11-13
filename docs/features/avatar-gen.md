# Avatar Gen

The `img2img:avatar` generator workflow. The user uploads a portrait, picks a style, and an image-edit
model redraws the same person in that style. A result can be refined, or set as the profile picture
from the queue. It is open to everyone; there is no feature flag.

## How a generation is built

| Model                                                                 | Images sent                                                                    | Style comes from                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Krea 3 (default), Nano Banana 2, Nano Banana Pro, GPT Image 2.5 Flare | the portrait, then a starter reference (or, when refining, the earlier result) | the reference, plus the style's `stylePrompt`                    |
| Krea 2                                                                | the portrait; when refining, the earlier result as a second image              | the style's LoRA (strength 1) and `stylePrompt`, 30 steps, CFG 3 |
| Flux 3 Klein                                                          | the portrait; when refining, the earlier result as a second image              | the style's `stylePrompt` alone                                  |

- **The form** is the normal generator form. The model selector offers only the models above
  (`avatarEditModels`). The avatar fields (style, reference, palette, character) are rendered by
  `src/components/AvatarGen/AvatarFormFields.tsx`. There is no seed field; `generateFromGraph` draws a
  random seed for every submit.
- **The server** (`src/server/services/orchestrator/form-graph/avatar.handler.ts`):
  - `expandAvatarData` resolves the reference, builds the prompt and, for Krea 2, adds the style
    LoRA. It runs before both the cost estimate and the submit, so the two always price the same job.
  - `createAvatarSteps` builds the `imageGen` step for the chosen model.
  - Every avatar workflow is tagged `avatar`.
- **References** are only:

  - **a stored starter**: four per style, served from our CDN. Styles with a free palette get the
    greyscale copy, so the prompt decides the colours. Fixed-palette styles (monochrome, 8-bit and
    the like) get the colour copy and offer no palette choice.
  - **the result being refined** (`avatarParentImage`, which overrides the starter in
    `avatarReference`), sent as it is. It must be an orchestrator blob; RU visitors see
    theirs on the region proxy host (`region-proxy.ts`), which is accepted too.

  Anything else is refused.

## Rules

An avatar depicts a real person. Generating that likeness is allowed; posting it is not.

- **PG-13.** The workflow config sets `sfwOnly`, so output is capped at PG-13 with
  mature content off, whatever the user's own setting (`workflowOutputRestrictions` in
  `form-graph/output-restrictions.ts`, the same cap private generation uses).
- **Results can't be posted, fed to another workflow or trained on.** Every workflow config states
  its `outputUses`, out of `post` (posts, contest entries, comics), `derive` (input to another
  workflow) and `train` (training datasets). The field is required, so a new workflow has to
  decide. Every workflow but the avatar allows all three; the avatar allows none.
  - `canUseWorkflowOutput` (`src/shared/generation/config/output-uses.ts`) answers from the
    saved `params.workflow`, through `BlobData.canUse(use)`, so a config change applies to
    existing outputs too. A workflow with no config (older generations) allows everything.
  - **post**: bulk post leaves them out, with one notice covering them and any audio. The remix
    menu hides its post action. The entry picker and the shared generator picker
    (`ImageSelectModal`, which defaults to `post`: the post editor and Comics) don't list them.
  - **derive**: the output menus and bulk "Apply workflow to selected" offer no workflows (upscale,
    edit and the like), and the image editor's picker doesn't list them.
  - **train**: the training dataset picker doesn't list them.
- **Prompts stay hidden.** The workflow config sets `hideDetails`, so the queue shows neither the
  prompt nor the details panel for an avatar job, outputs have no info popover, and the
  lightbox leaves out its Generation Details panel. The "Submit blocked images for review" link
  sends the workflow ID without the prompt.

## Styles and starter references

- **The catalogue** is `src/shared/constants/avatar-styles.constants.ts`, grouped into categories.
  Each style has a name, a category, a `stylePrompt`, an optional Krea 2 LoRA, and optional `fixedPalette` and
  `characters` (the Fantasy styles' Human/Elf/Orc/Dwarf choice).
- **The starters** are the same four people (Mara, Dev, Ines, Theo), drawn in every style.
  - They are Image rows owned by the CivitaiOfficial account and have no post, so they are not
    browsable.
  - `src/shared/constants/avatar-starters.json` maps each style to their colour and greyscale copies.
  - `scripts/avatar-starters/provenance.json` records the prompt, seed, model and LoRA behind each one.
  - `node scripts/avatar-starters/check.mjs <image-host>` requests every starter on the CDN and
    reports any that fail.
- **Making a new style**:
  - Check that the LoRA works without its trigger words: avatar gen sends none.
  - Generate its four starters with Krea 2 raw and the style's LoRA at 0.8, seed 20261009. Use the
    template `{style phrase}: head-and-shoulders portrait of {person}. No text.`, with each person
    described as in the provenance file.
  - For a monochrome style (line art, ink, pencil), leave colour words out of the person's
    description. Krea 2 fills in any hair or clothing given a colour, even with the LoRA.
  - Check each starter against the `stylePrompt` before upload. A fixed-palette style sends the
    colour copy, so a starter drawn in the wrong colours teaches every reference model those colours.
  - Upload them as CivitaiOfficial Image rows with a greyscale copy each.
  - Add them to the manifest and the provenance file.

## Queue and landing page

- **The queue**: avatar jobs appear in the normal queue, unfiltered, alongside everything else.
  Each is a standard `QueueItem` (prompt and details hidden, see Rules). What differs is described,
  not coded into the card: `workflowDisplays` (`ImageGeneration/workflow-display.tsx`) maps a
  workflow to a `summary` and `outputActions`, and the avatar's entry is `AvatarGen/avatar-display.ts`:
  - the summary: the style, reference and colours used;
  - under each result, **Refine** (a `fillForm` action: it switches the form to this workflow and sets
    `avatarParentImage`) and **Use as profile picture**, which copies the result to our image storage
    first, because generation outputs expire.
- **The landing page**: `src/pages/avatar-generator.tsx` (`/avatar-generator`) links into the
  generator with `/generate?workflow=img2img:avatar&avatarStyle=<key>&avatarReference=<character>`.
  `avatarDeepLinkFields` accepts only a known style and a starter character.

## What testing settled (October 2026)

- **Edit models, not ControlNet.** Qwen Edit, Seedream, Flux 2 Pro, Flux Kontext, Reve and
  HiDream-O1 were tried and dropped. GPT Image 2.5 Flare gave results indistinguishable from GPT
  Image 2 at about a quarter of the price.
- **Krea 2 and Flux 3 Klein copy the person in a reference.** They therefore restyle the photo alone
  (Krea 2 with the style's LoRA), and their only second image is an earlier result of the same
  person. For Klein, prompts that name the images by number made the copying worse, and putting the
  reference first returned the reference every time. Krea 3 kept the photo's person with a reference
  in every test.
- **References must be people drawn in the style.** Scenes and objects give a weak, half-photographic
  result. Several different starters per style keep results from all looking alike.
- **Colour comes from the prompt.** A greyscale reference plus a palette in the prompt controls colour
  better than telling the model to ignore a colour reference's colours, which loses the style too.
- **Strong palettes darken skin.** Warm and dark palettes shift the subject's skin tone, and the
  prompt only partly corrects it. "Natural" (the photo's own colours) is the default for that reason.
- **Name the style and what not to copy.** Called only "a style reference", the reference's person
  came through on Nano Banana. The prompt now gives the style's `stylePrompt` and lists what not to take
  from the reference. Styles that turn the person into something else (`reimagines`, Animal
  Version) keep them recognisable by expression, clothing and pose instead of by their face.
- **Franchise styles leak characters.** User-generated references for them drew the franchise's own
  characters, which is one reason references are limited to the reviewed starters.

## Later

- **A dedicated page** would be an App Block: it submits `img2img:avatar` through the generation graph
  and reuses this handler. Its submit must go through `generateFromGraph`, which applies the PG-13 cap
  and the random seed.
- **Gated LoRAs.** The generator's gate check runs before `expandAvatarData` adds the style's LoRA. If
  a style ever uses a LoRA behind an onboarding or flag gate, the check has to run on the expanded data.
