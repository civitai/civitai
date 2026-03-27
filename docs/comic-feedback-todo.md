# Comic Creator - Tester Feedback TODO

Source: [ClickUp Task 868hmbhq8](https://app.clickup.com/t/868hmbhq8)

---

## Critical Priority

- [x] **Enhance Prompt should be an action that edits the active text box**: Instead of randomly enhancing a prompt the user has no control over, we should make the enhance action a button that changes the prompting text BEFORE generating. That will make it so that if the user doesn't like the enhanced prompt they can make relevant updates.
- [x] **References span all projects** - References are not per-project. Users can call references from other projects. Should be per-project, or allow importing references from existing projects into new ones.
- [x] **Tips on Comics not associated with Comics** - Tips just look like direct Buzz tips instead of being linked to the Comic.
- [x] **Sketch Edit warning** - Add a warning that Sketch Edit produces varying results based on the model used (works well with Nano Banana).
- [x] **Generate multiple images per panel** - Testers want to generate multiple options and pick the best one. Current workflow is slow "dice-rolling" regeneration one at a time. Needs implementation in the Create Panel dialog.
- [x] **Duplicate panel + Duplicate chapter** - Allow duplicating panels/chapters so users can refine results without losing moderately good existing results.
- [x] **Reference any panel (not just previous)** - Users want to pick which panel to reference. Stories aren't linear; panels may visually reference non-adjacent panels.
- [x] **Smart Create panel count choice** - When using Smart Create, let users specify how many panels the story should span before generating.
- [x] **Welcome messaging** - Add a modal or banner on entry explaining: Beta version, limited features, rapid updates coming, no refunds for Beta issues.

## High Priority

- [x] **Pre-made panel layouts** - Integrate the pre-made layouts from the attached zip file.
- [x] **Pre-made dialog and action boxes** - Add pre-made speech bubble/dialog box assets.
- [x] **Smart Create unlimited panels** - No limit on panels (~50-60 possible). What happens for Free tier (4 jobs) or Gold tier (12 jobs)? Does it queue and churn them out? Needs guardrails.
- [x] **Add Seedream 5 Lite as generation option** - Fast and cheaper than 4.5, good candidate for comic generation.

## Bugs

- [ ] **Image generation timeout** - Image times out in Comic system but actually generated (visible in Generator). Doesn't pull into panel until page refresh or clicking into the panel.
- [x] **References list overflow** - References list extends out of screen in the Iterative Edit box. Should be scrollable/contained.
- [ ] **Generate panel error** - Error when trying to generate a new panel (see screenshot in task).
- [x] **Generate without references error** - Generating a panel with no references produces an error.
- [x] **Generator offline messaging** - When Generator is off or orchestrator is down, Comic system shows nothing useful. Need proper "Generator unavailable" messaging.
- [ ] **Sketch Edit resize/flip** - Speech bubble tool doesn't allow resizing or flipping horizontal/vertical.
- [ ] **Buzz price mismatch** - Quoted price is 160 Buzz (Nano) but Generator charges 180 Buzz.
- [x] **Enhance Prompt ignores input** - Enhance Prompt pulls in random references not in the original prompt, ignores Sketch Edit, produces completely different images. Multiple testers report this.
- [ ] **Smart Create cross-comic references** - Smart Create on a new comic pulls in references/characters from other comics.
- [ ] **Panel cost not shown** - Doesn't display the cost to generate a new panel.
- [ ] **Preview button broken** - New Preview button doesn't pull in panels.
- [x] **Preview removes site chrome** - Clicking Preview hides the site header, menu bars, etc. Same issue in Iterative Edit tool.
- [x] **Smart Create "Add Panel" focus** - New panels are added at the bottom of the scroll-list but modal doesn't scroll to them. Should auto-focus on new panels.
- [x] **Scrollbar overlaps delete button** - In Smart Create, the scrollbar sits on top of the delete button.
- [ ] **Sketch Edit changes aspect ratio** - Sketch Edit turns 4:3 images into 1:1 when going to "Enhance Panel" then "Annotate Image".
- [x] **Imported image shows wrong settings** - Importing an image shows incorrect settings. Should indicate it's an imported image.
- [ ] **Reference image upload stuck at 75%** - Uploading reference images frequently gets stuck at 75%.
- [ ] **Grok Image error** - Grok Image throws an error (see screenshot in task).
- [x] **Early access pricing** - No limit on Buzz price per chapter; "early access" allows paywall up to a year.
- [ ] **Can't drag from Generator to References** - Dragging doesn't work (picking from Generator does work).
- [x] **XXX rating persists after panel deletion** - Deleting an XXX-rated panel reverts the chapter to PG-13 but the overall comic rating stays XXX.
- [x] **Must refresh after every action** - Upload images, new panel, delete panel, import — nothing shows until manual page refresh.
- [ ] **Sketch Edit unreliable** - Sketch Edit + Regenerate produces entirely new image. Sketch Edit sometimes pulls in files from previous generations. Confusion between Sketch Edit → Regenerate vs. Enhance → Annotate workflow.

## Improvements

- [ ] **Annotate button placement** - Sketch Edit button should be up beside all the other tools, not buried.
- [ ] **Font size inconsistencies** - Minor design issue with inconsistent font sizes.
- [ ] **Age rating change workflow** - Panels/Comics have age ratings but no way for users to request a change or for mods to change them. Should align with existing rating-change patterns.
- [ ] **Failed panel deletion** - Failed panels don't have a delete option/context menu; have to click into them to delete.
- [ ] **UI overflow with many resources** - UI breaks when lots of resources are added.
- [ ] **Comment moderation** - Comments look funky; no way for mods to delete/ToS comments.
- [ ] **Reference prompt fragility** - If you mess up Reference @ names in the prompt, all references disappear. When they come back, you must re-select all reference images.
- [ ] **Adding reference resets selections** - Adding a new Reference to the prompt refreshes selected reference images, forcing re-selection.
- [ ] **Consolidate Sketch Edit and Enhance** - Rename "Enhance" to "Edit/Enhance Panel" and remove standalone Sketch Edit to reduce confusion.
- [ ] **Panel version history / Undo** - No way to revert a panel after a bad regeneration or Sketch Edit. Need undo button or previous version selector.

## Feature Requests

- [ ] **In-panel text and speech bubbles** - Add button to insert speech bubbles with comic-style fonts (Bubble Regular, Bubble Sans, etc.). Allows adding dialog without regeneration. Also enlarge the Sketch Edit canvas — too small for placing bubbles.
- [ ] **Generate character reference sheets** - Allow generating reference sheets directly inside the "Create References" modal instead of requiring off-site creation.
- [ ] **Animate panels** - Testers want panel animation. Options: Grok (expensive), LTX2.3 (cheap), Kling, Veo 3.1.
- [ ] **Export as PDF/CBR** - Export finished comics in PDF or CBR (Comic Book Reader) format. Should be optional (creator may not want to allow it, but should have it for themselves).
- [ ] **Schedule chapter releases** - Mentioned in changelog but testers can't find how to do it.

---

## Notes / Future Ideas

- Tester made a Font Reference using an expensive ($130) commercial font — and it works. Opens the door to Civitai-defined preset resources.
- Market research: [aicomicfactory.com](https://aicomicfactory.com/playground) is popular but Flux-powered and low quality. Has interesting grid layout concepts. Testers currently use Photoshop or Python scripts for grid layouts.
