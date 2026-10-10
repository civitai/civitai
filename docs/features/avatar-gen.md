# Avatar Gen

The `img2img:avatar` generator workflow. The user uploads a portrait, picks a style, and an image-edit
model redraws the same person in that style. A result can be refined, or set as the profile picture
from the queue. It is open to everyone; there is no feature flag.

## How a generation is built

| Model                                               | Images sent                                                                    | Style comes from                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Krea 2 (default)                                    | the portrait; when refining, the earlier result as a second image              | the style's LoRA (strength 1) and description, 30 steps, CFG 3 |
| Nano Banana 2, Nano Banana Pro, GPT Image 2.5 Flare | the portrait, then a starter reference (or, when refining, the earlier result) | the reference, plus the style description in the prompt        |

- **The form** is the normal generator form. The model selector offers only the four models above
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
    greyscale copy, so the prompt decides the colours. Fixed-palette styles (monochrome, Game Boy and
    the like) get the colour copy and offer no palette choice.
  - **the result being refined**, sent as it is.

  Anything else is refused.

- **Output** is capped at PG-13 with mature content off, whatever the user's own setting
  (`workflowOutputRestrictions` in `form-graph/output-restrictions.ts`, the same cap private
  generation uses).

## Styles and starter references

- **The catalogue** is `src/shared/constants/avatar-styles.constants.ts`: 80 styles in 10 categories.
  Each style has a name, a description, an optional Krea 2 LoRA, and optional `fixedPalette` and
  `characters` (the Fantasy styles' Human/Elf/Orc/Dwarf choice).
- **The starters** are the same four people (Mara, Dev, Ines, Theo), drawn in every style.
  - They are Image rows owned by the CivitaiOfficial account and have no post, so they are not
    browsable.
  - `src/shared/constants/avatar-starters.json` maps each style to their colour and greyscale copies.
  - `scripts/avatar-starters/provenance.json` records the prompt, seed, model and LoRA behind each one.
  - `node scripts/avatar-starters/check.mjs <image-host>` requests every starter on the CDN and
    reports any that fail.
- **Making a new style**:
  - Generate its four starters with Krea 2 raw and the style's LoRA at 0.8, seed 20261009. Use the
    template `{style phrase}: head-and-shoulders portrait of {person}. No text.`, with each person
    described as in the provenance file.
  - Upload them as CivitaiOfficial Image rows with a greyscale copy each.
  - Add them to the manifest and the provenance file.

## Queue and landing page

- **The queue**: while the form is on the avatar workflow, the queue tab shows avatar jobs only
  (`AvatarQueue`). Each is a standard `QueueItem` without the prompt and details, plus:
  - a strip showing the style, reference and colours used;
  - under each result, **Refine** and **Use as profile picture**. Use as profile picture copies the
    result to our image storage first, because generation outputs expire.
- **The landing page**: `src/pages/avatar-generator.tsx` (`/avatar-generator`) links into the
  generator with `/generate?workflow=img2img:avatar&avatarStyle=<key>&avatarReference=<character>`.
  `avatarDeepLinkFields` accepts only a known style and a starter character.

## What testing settled (October 2026)

- **Edit models, not ControlNet.** Qwen Edit, Seedream, Flux 2 Pro, Flux Kontext, Reve and
  HiDream-O1 were tried and dropped. GPT Image 2.5 Flare gave results indistinguishable from GPT
  Image 2 at about a quarter of the price.
- **Krea 2 copies the person in a reference.** It therefore restyles from the LoRA alone, and its
  only second image is an earlier result of the same person.
- **References must be people drawn in the style.** Scenes and objects give a weak, half-photographic
  result. Several different starters per style keep results from all looking alike.
- **Colour comes from the prompt.** A greyscale reference plus a palette in the prompt controls colour
  better than telling the model to ignore a colour reference's colours, which loses the style too.
- **Strong palettes darken skin.** Warm and dark palettes shift the subject's skin tone, and the
  prompt only partly corrects it. "Natural" (the photo's own colours) is the default for that reason.
- **Franchise styles leak characters.** User-generated references for them drew the franchise's own
  characters, which is one reason references are limited to the reviewed starters.

## Later

Not needed to ship.

- **Composable queue.** The generation composability plan (`docs/generation-composability-plan.md`,
  on `feat/generation-composability`) splits the queue card into parts. For avatar gen:
  - **The card becomes a composition.** `QueueItem`'s `beforeOutputs`, `renderOutputFooter` and
    `hideDetails` props exist only for avatar gen. With the parts, the avatar card is assembled
    without `Prompt` and `Details`, with Refine under each output.
  - **The card is chosen per workflow.** Today the whole queue switches to `AvatarQueue` from the
    form's current workflow (`useActiveGenerationForm`), with its own query and polling. Choosing a
    card per workflow inside the normal queue removes all three.
  - **Refine and Use as profile picture become injected actions.** They are site-only actions, so
    they should be passed in through the card's actions rather than imported.
- **A dedicated page** would be an App Block: it submits `img2img:avatar` through the generation graph
  and reuses this handler. Its submit must go through `generateFromGraph`, which applies the PG-13 cap
  and the random seed.
- **Gated LoRAs.** The generator's gate check runs before `expandAvatarData` adds the style's LoRA. If
  a style ever uses a LoRA behind an onboarding or flag gate, the check has to run on the expanded data.
