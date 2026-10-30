# Edit LoRA training (Training Studio)

An edit LoRA learns a transformation — rotate the subject, put a logo on a product, blend a rough
cut-out into its scene — from examples of it. Each example is a **pair**: the image the edit starts
from, the image after it, and the instruction that turns one into the other. Training Studio trains
them on Flux.2 Klein (9B and 4B) through AI-Toolkit.

## Where it lives

- Catalog: the `flux2klein-edit` card in `apps/training-studio/src/lib/data/trainingModels.ts`
  (`pairs: true`), gated by the `flux2-klein-edit-training` flag — mod-only until the flag opens. The
  main app's embed answers it through `flux2KleinEditTraining` (`studioModelFlagFeatures` in
  `src/utils/training.ts`).
- Data step: `apps/training-studio/src/routes/EditDataStep.svelte`, which `TrainingFlow.svelte` swaps in
  for `DataStep` when the selected card trains pairs. Pair logic (problems, grouping, zip reading, sample seeding) is in `src/routes/editPairs.ts`.
- Helpers: `src/lib/edit-helpers-core.ts`, behind `StudioBackend` (the shell's `/api/generations?kind=edit`,
  `/api/edit-image`, `/api/suggest-instruction` routes, and the web component's direct calls).

## The dataset

- One list of pairs, two per row. Pairs can come from uploaded images, an imported zip, or the user's
  past single-image edits in the Generator — side by side, each with a source tag and filter.
- **Group by starting image** is a view over the same list: pairs whose starting image is the same
  file (by content hash, or by blob when the browser can't hash) are shown together, with "Add another
  edit from this image". It never changes the data.
- A pair is ready once both images uploaded and passed the scan and it has an instruction. Continue
  stays disabled until every pair is ready or removed.
- A sweep can't mix an edit model with a single-image model: the Select step locks it, like the
  tags/captions lock.

### Zip import

A zip is only an import format: its images are uploaded one by one like any others. It pairs files by
name across a before folder and an after folder; a `.txt` of the same name is the instruction:

```
control_1/  starting images   (also accepted: control, before, input, source, start)
main/       after images      (also accepted: target, after, output, result)
main/*.txt  instructions
```

A starting image without an after image is added and flagged; an after image without a starting image is
skipped and reported. Pairs without a `.txt` take the default instruction the import dialog asks for.

## Submitting

Every image is uploaded and scanned as its own blob, as for any Studio dataset, and the run trains on
those blobs directly — no zip. Each ready pair becomes two `trainingData` blob items placed by `path`:
the starting image at `control_1/pair_0001.<ext>` and the result at `main/pair_0001.<ext>`, captioned
with the instruction; the shared name is what pairs them. The run is sent with `isEditTraining: true`
(`TrainingRunInput.editTraining` and `pairItems` in `src/routes/editPairs.ts`), and submit refuses a
dataset whose halves don't match up. Keep training carries `isEditTraining` and the items through.
Samples are rendered from each sample's starting image (`samples.sourceImages`), seeded from three
ready pairs.

## Helpers

All three are charged to the user and show their price before running.

- **From my edit generations** lists the user's recent single-image `imageGen` edits whose input is one of
  their orchestrator blobs; each result becomes a pair with its prompt as the instruction.
- **Create the after image** runs Flux.2 Klein 9B in edit mode on the starting image and offers 3
  options. The prompt goes through the main app's generator prompt check first
  (`POST /api/training-studio/check-text` with `{ editPrompt, inputImages }`).
- **Suggest** asks a vision chat model to describe the change from before to after. It only fills an
  instruction that is still empty when the answer arrives.

## Known gaps

- A finished edit run can't be reused as a dataset ("Train again" / reuse a dataset) yet: its blobs are
  pairs, which the plain Data step can't take, so the run offers no dataset to reuse.
