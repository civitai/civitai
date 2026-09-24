# Paid model loading — testing feedback

What a round of external testing on the download-boost feature found, and what was decided about each
item. Feature: [paid-model-loading.md](paid-model-loading.md).

**Round 1: 2026-09-23**, three testers against a preview build. Six of the eight checklist lines came
back clean; the two that did not are items 1–3 below.

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

*Closes when:* a repeat of the steps confirms the panel stops offering, and that no second charge
occurred.

### 2. Loaded indicator on the model page reads "Not loaded" for a loaded model

The model page's load indicator trails the generator by the 5-minute
`sync-generator-loaded-resources` cycle, plus the search-index queue for the resource picker. This is
the documented behaviour and the tester brief lists it as expected.

**Two of three testers reported it as a bug anyway**, one of whom retracted after watching it update.
That makes it a design problem rather than a reporting one: the page states a stale answer
confidently, and nothing on screen indicates it trails.

**Being fixed at the source.** The orchestrator is adding a webhook that fires when a model enters or
leaves the cluster, so the column can be updated on the event instead of waiting for the 5-minute
cron. That was chosen over per-resource subscriptions, which would have meant subscribing to every
already-loaded resource.

*Closes when:* the site updates `ModelVersion.generatorLoaded` from that webhook, and a model loaded
in the generator reads as loaded on its model page without waiting out the cron.

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

**Fixed.** All three purchase points — the queue-card panel, the pre-submit alert and the mobile
confirm — now render one shared line (`BOOST_NON_REFUNDABLE` in `download-lanes.tsx`) stating that
the fee is not refunded if the generation is cancelled.

*Closes when:* a tester confirms the line is visible before each purchase, or a ruling that
cancelling should refund the fee supersedes it.

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
site's. Performance once boosted was reported as matching expectations.

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
