# Paid model loading — testing feedback

What a round of external testing on the download-boost feature found, and what was decided about each
item. Feature: [paid-model-loading.md](paid-model-loading.md).

**Round 1: 2026-09-23 to 2026-09-24**, four testers against a preview build. Two worked the checklist
line by line; between them every line came back clean except the loaded indicator, which three of the
four raised in some form.

Provenance — who reported what, and where — is kept out of this file on purpose; the items and the
decisions are the part worth keeping. Items are numbered so they can be referred to across rounds.

---

## Bugs

### 1. The boost offer stays live after a successful boost

The download-boost panel remains, and its control can be pressed again, after a workflow has already
moved to the high lane.

Charging looks safe: `boostWorkflow` (`orchestration-new.service.ts`) re-prices through
`getWorkflowBoostCost` before charging and returns `boosted: false` when the price moved or came back
`null`, and a workflow already in the high lane reports no `downloadPriority` fee. That is reasoning
from the code, not an observation — it depends on the orchestrator reporting no fee for an
already-boosted workflow, which cannot be verified from this repo. A tester's checklist did record
"never charged twice" as passing.

**Fixed (offer side).** `isWorthBoosting` now withholds the offer from a workflow already in the
boosted lane — both ETAs were measured before the boost, so they still read as a saving and the lane
is the only signal that the purchase already happened.

**No money was lost.** A tester tried the second purchase deliberately and was refunded immediately,
which matches the re-price-and-refuse path in `boostWorkflow`. Worth noting the refund is observed as
a refund rather than as a charge that never happened — a charge and its reversal are two rows in a
Buzz history, which bears on item 7.

*Closes when:* a tester confirms the panel no longer offers a second boost on the next build.

### 2. Loaded indicator on the model page reads "Not loaded" for a loaded model

The model page's load indicator trailed the generator by the `sync-generator-loaded-resources`
cycle, plus the search-index queue for the resource picker. That was the documented behaviour, and the
tester brief listed it as expected.

**Three of four testers raised it anyway**, one of whom retracted after watching it update. That makes
it a design problem rather than a reporting one: the page states a stale answer confidently, and
nothing on screen indicates it trails.

The sharpest report locates it *inside a single page*: the version-details **Generation** row is a
live residency read and updates quickly, while the version strip beside it is fed by the
`generatorLoaded` column and waits for the cron. Two indicators on one screen, disagreeing, for
minutes.

**Fixed at the source, shipped.** The orchestrator now posts every residency change to
`/api/webhooks/resource-availability`, and the column is written as the news arrives rather than on a
cycle. That was chosen over per-resource subscriptions, which would have meant subscribing to every
already-loaded resource. Residency is taken from `workersAvailable`, not the `loaded` flag beside it
in the payload. The sync job remains as a backstop for a delivery that never arrived, at 15 minutes
rather than 5.

*Closes when:* a tester confirms a model loaded in the generator reads as loaded on its model page
without a wait.

### 3. Queue card download details disappear after the generation

Lane, position, speed and ETA showed while the generation was waiting, but not afterwards. This may
be `buildDownloadRows` dropping its rows once nothing is preparing, which is intended and documented.
Not yet reproduced, and no workflow id was captured.

*Closes when:* the steps are reproduced and the behaviour is either confirmed as the intended
row-drop — with the checklist wording fixed so it no longer reads as a defect — or filed as a bug
with a workflow id.

### 4. A generation reported as slow while everything was already loaded

One report, with a screenshot but no workflow id or timings.

*Closes when:* a workflow id is obtained and the run checked in the orchestrator, or the report is
withdrawn.

---

## Decisions needed

### 5. The Boost button is yellow but the payment may be blue Buzz

Request: the button should carry the colour of the Buzz actually being spent.

*Closes when:* one behaviour is chosen — match the currency, or keep a single colour — and the button
matches it.

### 6. The boost fee is non-refundable on cancel and nothing says so

Raised twice, with a suggestion of explicit warning text. The reporter assumed the behaviour is
deliberate; the complaint is that it is unstated. Buying a boost and then cancelling is the case where
a user loses Buzz with nothing to show for it, which makes this the highest-value item in this group.

**Fixed, with the styling still open.** All three purchase points — the queue-card panel, the
pre-submit alert and the mobile confirm — now render one shared line (`BOOST_NON_REFUNDABLE` in
`download-lanes.tsx`) stating that the fee is not refunded if the generation is cancelled. It ships
as small dimmed text; two testers asked for it to be coloured, one of them twice, and the argument
offered was support load — people who did not mean to click it will arrive in help asking for the
Buzz back.

*Closes when:* the note is coloured, or a ruling that dimmed is enough is recorded here, and a tester
confirms it is visible before each purchase.

### 7. Generation and boost fee arrive as one transaction

Request: separate them, and name the model and version on the boost line.

*Closes when:* the Buzz transaction list shows the boost as its own entry naming the resource, or the
request is declined with the reason recorded here.

### 8. Green Buzz is not offered for boosting

Observed on a preview build, and possibly an artifact of that environment rather than a rule.

*Closes when:* the Buzz types the boost accepts, and why, are recorded in
[paid-model-loading.md](paid-model-loading.md).

### 9. Boost price reads expensive in one Buzz type and reasonable in another

A data point for whoever sets the price, not a work item — the price is the orchestrator's, not the
site's. Two testers said the same thing independently, one citing roughly 1.3k for a Krea 2 boost, and
both noted the alternatives are waiting or paying in a cheaper Buzz type. Performance once boosted was
reported as matching expectations.

*Closes when:* nothing. Drop this entry at the next triage if no one picks it up.

---

## Questions raised during testing, unanswered

### 10. Download-queue abuse

What stops someone requesting several models, queueing the downloads, cancelling the jobs and
repeating? One tester believed limits exist; nobody confirmed which.

*Closes when:* the limit that applies — or the absence of one — is recorded in
[paid-model-loading.md](paid-model-loading.md).

### 11. How long a model stays resident, and whether a later requester benefits

Asked whether a second user wanting the same model gets it without a wait, and whether a model
offloads immediately after use. A figure of roughly 48 hours was recalled by one tester, who doubted
it was implemented.

*Closes when:* the residency and eviction policy is stated in
[paid-model-loading.md](paid-model-loading.md).

### 12. Whether a quantized community checkpoint can be loaded

Asked about an int8 variant of a published community model. Unanswered.

*Closes when:* the asker has an answer.

---

## Not filed, deliberately

Sign-in trouble on the preview build, and a geoblock on the same host. Both are properties of the
test environment rather than of this feature.
